import { describe, expect, it } from 'vitest'

import { CAUSES, sinceRange, summarize } from '../../../plugin/core/history/summarize'
import type { SessionHistory } from '../../../plugin/core/history/summarize'
import type { EventRecord, RequestRecord } from '../../../plugin/core/model/types'
import { prices } from '../helpers'
import { request } from '../model/fixtures'

const DAY = 86_400_000
const MIN = 60_000
const NOW = Date.UTC(2026, 0, 31, 12, 0)

/** A request that reads the whole prefix the one before it left. */
const hit = (ts: number) => request(ts, { usage: { input: 10, read: 802_500, write5m: 0, write1h: 2_000, output: 500 } })
/** A request that rebuilt the prefix: almost nothing read, everything written. */
const miss = (ts: number, over: Partial<RequestRecord> = {}) => request(ts, { usage: { input: 10, read: 0, write1h: 802_500, write5m: 0, output: 500 }, ...over })

const session = (sessionId: string, requests: RequestRecord[], events: EventRecord[] = [], skipped = 0): SessionHistory => ({ sessionId, requests, events, skipped })
const all = { misses: false }
const range = { from: NOW - 30 * DAY, to: NOW }

describe('summarize', () => {
  it('sums per-cause spend to the total re-cache spend (AC 14.1)', () => {
    const t0 = NOW - 2 * DAY
    const s = session(
      'a',
      [hit(t0), miss(t0 + 70 * MIN), miss(t0 + 80 * MIN), miss(t0 + 90 * MIN), miss(t0 + 100 * MIN), miss(t0 + 101 * MIN), hit(t0 + 102 * MIN)],
      [
        { ts: t0 + 79 * MIN, kind: 'model_switch', detail: { from: 'claude-opus-5-5', to: 'claude-sonnet-5-5' } },
        { ts: t0 + 89 * MIN, kind: 'compaction' },
        { ts: t0 + 100 * MIN + 2_000, kind: 'native_miss', detail: { to: 'likely_server_side' } },
      ],
    )
    const sum = summarize([s], range, all, prices, 'firstParty')
    expect(sum.recaches).toBe(5)
    expect(sum.byCause.ttl_expiry.count).toBe(1)
    expect(sum.byCause.switch.count).toBe(1)
    expect(sum.byCause.compaction.count).toBe(1)
    expect(sum.byCause.server_side.count).toBe(1)
    expect(sum.byCause.unexplained.count).toBe(1)
    const perCause = CAUSES.reduce((total, c) => total + sum.byCause[c].usd, 0)
    expect(perCause).toBeCloseTo(sum.recacheUsd, 10)
    expect(sum.recacheUsd).toBeGreaterThan(0)
    expect(sum.unpriced).toBe(0)
  })

  it('counts a 70-minute gap on a 1h TTL as avoidable, and a 3-hour gap as not (AC 14.2)', () => {
    const t0 = NOW - DAY
    const near = summarize([session('a', [hit(t0), miss(t0 + 70 * MIN)])], range, all, prices, 'firstParty')
    expect(near.rows[0]).toMatchObject({ cause: 'ttl_expiry', avoidable: true })
    expect(near.avoidableUsd).toBeCloseTo(near.recacheUsd, 10)
    const far = summarize([session('a', [hit(t0), miss(t0 + 180 * MIN)])], range, all, prices, 'firstParty')
    expect(far.rows[0]).toMatchObject({ cause: 'ttl_expiry', avoidable: false })
    expect(far.avoidableUsd).toBe(0)
  })

  it('counts an invalidating action as avoidable only when taken while warm', () => {
    const t0 = NOW - DAY
    const warm = summarize([session('a', [hit(t0), miss(t0 + 20 * MIN)], [{ ts: t0 + 15 * MIN, kind: 'effort_change' }])], range, all, prices, 'firstParty')
    expect(warm.rows[0]).toMatchObject({ cause: 'switch', avoidable: true })
    const cold = summarize([session('a', [hit(t0), miss(t0 + 90 * MIN)], [{ ts: t0 + 75 * MIN, kind: 'effort_change' }])], range, all, prices, 'firstParty')
    expect(cold.rows[0]).toMatchObject({ cause: 'switch', avoidable: false })
  })

  it('lists only misses from the last seven days with --since 7d --misses (AC 6.5)', () => {
    const old = NOW - 10 * DAY
    const recent = NOW - 2 * DAY
    const sessions = [session('old', [hit(old), miss(old + 90 * MIN), hit(old + 91 * MIN)]), session('new', [hit(recent), hit(recent + 10 * MIN), miss(recent + 100 * MIN)])]
    const sum = summarize(sessions, sinceRange('7d', NOW)!, { misses: true }, prices, 'firstParty')
    expect(sum.rows.map(r => [r.session, r.outcome])).toEqual([['new', 'MISS']])
    expect(sum.rows.every(r => r.ts >= NOW - 7 * DAY)).toBe(true)
    expect(sum.sessions).toBe(1)
  })

  it('filters to one session, keeps hits without --misses, and counts skipped chunks', () => {
    const t0 = NOW - DAY
    const sessions = [session('a', [hit(t0), hit(t0 + MIN)], [], 1), session('b', [hit(t0), miss(t0 + 2 * 60 * MIN)], [], 2)]
    const one = summarize(sessions, range, { session: 'a', misses: false }, prices, 'firstParty')
    expect(one.rows.map(r => r.outcome)).toEqual(['HIT'])
    expect(one.skippedChunks).toBe(1)
    expect(summarize(sessions, range, all, prices, 'firstParty').skippedChunks).toBe(3)
  })

  it('leaves an unpriced model out of the dollar totals and counts it', () => {
    const t0 = NOW - DAY
    const sum = summarize([session('a', [hit(t0), miss(t0 + 90 * MIN, { model: 'claude-unknown-9' })])], range, all, prices, 'firstParty')
    expect(sum.unpriced).toBe(1)
    expect(sum.recacheUsd).toBe(0)
    expect(sum.rows[0]!.recacheUsd).toBeNull()
  })

  it('ignores other lanes and attributes a gap within the TTL to nothing known as unexplained', () => {
    const t0 = NOW - DAY
    const sum = summarize([session('a', [hit(t0), { ...miss(t0 + 5 * MIN), lane: 'subagent' }, miss(t0 + 10 * MIN)])], range, all, prices, 'firstParty')
    expect(sum.requests).toBe(2)
    expect(sum.rows[0]).toMatchObject({ cause: 'unexplained', avoidable: false })
  })
})

describe('sinceRange', () => {
  it('reads days and hours, and defaults to 30 days', () => {
    expect(sinceRange('7d', NOW)).toEqual({ from: NOW - 7 * DAY, to: NOW })
    expect(sinceRange('12h', NOW)).toEqual({ from: NOW - 12 * 3_600_000, to: NOW })
    expect(sinceRange(undefined, NOW)).toEqual({ from: NOW - 30 * DAY, to: NOW })
    expect(sinceRange('soon', NOW)).toBeNull()
    expect(sinceRange('0d', NOW)).toBeNull()
  })
})
