import { describe, expect, it } from 'vitest'

import type { SessionHistory } from '../../../plugin/core/history/summarize'
import { adviseTtl, MIN_GAPS, MIN_SESSIONS } from '../../../plugin/core/history/ttl'
import type { RequestRecord } from '../../../plugin/core/model/types'
import { prices, rules, strings } from '../helpers'
import { renderTtlAdvice } from '../../../plugin/core/render/history'
import { UNICODE } from '../../../plugin/core/render/format'
import { request } from '../model/fixtures'

const MIN = 60_000
const DAY = 86_400_000
const NOW = Date.UTC(2026, 0, 31, 12, 0)
const range = { from: NOW - 30 * DAY, to: NOW }

/** A session whose main requests come `gapsMin` minutes apart, each adding a few thousand tokens. */
function session(i: number, gapsMin: readonly number[], lane: RequestRecord['lane'] = 'main'): SessionHistory {
  let ts = NOW - (i + 1) * DAY
  const requests = [request(ts, { lane })]
  for (const g of gapsMin) {
    ts += g * MIN
    requests.push(request(ts, { lane, usage: { input: 10, read: 400_000, write5m: 0, write1h: 4_000, output: 500 } }))
  }
  return { sessionId: `s${i}`, requests, events: [], skipped: 0 }
}

describe('adviseTtl', () => {
  it('recommends the 1-hour TTL with the savings when most gaps fall between 10 and 50 minutes (AC 16.1)', () => {
    const sessions = Array.from({ length: 12 }, (_, i) => session(i, [12, 25, 48]))
    const a = adviseTtl(sessions, range, prices, 'firstParty')
    expect(a.main).toMatchObject({ sessions: 12, gapCount: 36, gaps: { under5m: 0, under1h: 36, over1h: 0 }, recommended: '1h' })
    expect(a.main.cost1hUsd!).toBeLessThan(a.main.cost5mUsd!)
    expect(a.main.savingsUsd).toBeCloseTo(a.main.cost5mUsd! - a.main.cost1hUsd!, 10)
    expect(a.subagent.recommended).toBeNull()
  })

  it('recommends the 5-minute TTL when gaps stay within 5 minutes, since its writes cost less', () => {
    const sessions = Array.from({ length: 10 }, (_, i) => session(i, [1, 2, 3]))
    expect(adviseTtl(sessions, range, prices, 'firstParty').main.recommended).toBe('5m')
  })

  it('shows "not enough data" with fewer sessions or gaps than the minimum (AC 16.2)', () => {
    const few = adviseTtl(Array.from({ length: MIN_SESSIONS - 1 }, (_, i) => session(i, [20, 20, 20])), range, prices, 'firstParty')
    expect(few.main).toMatchObject({ sessions: 9, recommended: null, savingsUsd: null })
    const thin = adviseTtl(Array.from({ length: MIN_SESSIONS }, (_, i) => session(i, [20])), range, prices, 'firstParty')
    expect(thin.main.gapCount).toBeLessThan(MIN_GAPS)
    expect(thin.main.recommended).toBeNull()
    const text = renderTtlAdvice(few, 100, { glyphs: UNICODE, strings, display: rules.display, tzOffsetMin: 0 })
    expect(text).toContain('not enough data yet: 9 of 10 sessions, 27 of 20 idle gaps')
    expect(text).toContain('Subscriptions use the 1-hour TTL within plan usage,\nand the 5-minute TTL once on usage credits;')
  })

  it('keeps subagents separate from the main conversation (REQ-16.0.1)', () => {
    const sessions = Array.from({ length: 11 }, (_, i) => session(i, [2, 3], 'subagent'))
    const a = adviseTtl(sessions, range, prices, 'firstParty')
    expect(a.main.gapCount).toBe(0)
    expect(a.subagent).toMatchObject({ sessions: 11, gapCount: 22, recommended: '5m' })
  })

  it('says there is no recommendation when requests cannot be priced', () => {
    const sessions = Array.from({ length: 10 }, (_, i) => {
      const s = session(i, [20, 20])
      return { ...s, requests: s.requests.map(r => ({ ...r, model: 'claude-unknown-9' })) }
    })
    const a = adviseTtl(sessions, range, prices, 'firstParty')
    expect(a.main).toMatchObject({ cost5mUsd: null, recommended: null })
    expect(renderTtlAdvice(a, 100, { glyphs: UNICODE, strings, display: rules.display, tzOffsetMin: 0 })).toContain('some requests have no price')
  })
})
