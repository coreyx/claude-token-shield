import { describe, expect, it } from 'vitest'

import { CHEAPEST_TOLERANCE, evaluateAdvice, TAKEN_WINDOW_MS } from '../../../plugin/core/history/advice'
import type { RecommendationRecord } from '../../../plugin/core/history/advice'
import type { RequestRecord } from '../../../plugin/core/model/types'
import { prices } from '../helpers'
import { request } from '../model/fixtures'

const MIN = 60_000
const T = Date.UTC(2026, 0, 20, 12, 0)

/** A main request that read the prefix, or rebuilt it. */
const warm = (ts: number) => request(ts, { usage: { input: 10, read: 802_500, write5m: 0, write1h: 2_000, output: 500 } })
const cold = (ts: number) => request(ts, { usage: { input: 10, read: 0, write1h: 802_500, write5m: 0, output: 500 } })
/** A small request after /clear or /compact: only a short prefix to write. */
const small = (ts: number, lane: RequestRecord['lane'] = 'main') => request(ts, { lane, usage: { input: 10, read: 0, write1h: 40_000, write5m: 0, output: 500 } })

/** A recommendation with typical quotes: continue at $0.17 warm / $6.42 cold, compact at $1.20, clear at $0.35. */
const rec = (ts: number, lever: RecommendationRecord['lever'], state: RecommendationRecord['state'] = 'COLD'): RecommendationRecord => ({
  ts,
  state,
  lever,
  pHit: state === 'COLD' ? 0.01 : 0.99,
  readUsd: 0.17,
  writeUsd: 6.42,
  quotes: [
    { lever: 'continue', nowUsd: state === 'COLD' ? 6.36 : 0.23, perTurnUsd: 0.17 },
    { lever: 'compact', nowUsd: 1.2, perTurnUsd: 0.02 },
    { lever: 'clear', nowUsd: 0.35, perTurnUsd: 0.01 },
    { lever: 'btw', nowUsd: null, perTurnUsd: null },
  ],
})

describe('evaluateAdvice', () => {
  it('compares only like-for-like levers: a cheaper /clear does not count against the recommendation', () => {
    const report = evaluateAdvice([rec(T, 'compact')], [{ ts: T + MIN, lever: 'compact' }], [warm(T - 10 * MIN), small(T + MIN + 1_000, 'compact'), small(T + 2 * MIN)], prices)
    expect(report.cheapest).toBe(1)
  })

  it('reports the cheapest-in-hindsight share for recommendations with known outcomes (AC 14.5)', () => {
    const recs = [
      // 1. COLD, compact recommended and taken: the measured path beats continuing cold. Cheapest.
      rec(T, 'compact'),
      // 2. HOT, continue recommended, the person continued and the cache was read. Cheapest.
      rec(T + 60 * MIN, 'continue', 'HOT'),
      // 3. HOT, continue recommended, the person continued but it missed: compact would have been cheaper. Not cheapest.
      rec(T + 120 * MIN, 'continue', 'HOT'),
      // 4. A recommendation nothing followed within 10 minutes: not judged.
      rec(T + 200 * MIN, 'clear'),
    ]
    const taken = [
      { ts: T + MIN, lever: 'compact' as const },
      { ts: T + 61 * MIN, lever: 'continue' as const },
      { ts: T + 121 * MIN, lever: 'continue' as const },
      { ts: T + 200 * MIN + TAKEN_WINDOW_MS + 1, lever: 'clear' as const },
    ]
    const requests = [
      warm(T - 10 * MIN),
      small(T + MIN + 1_000, 'compact'),
      small(T + 2 * MIN),
      warm(T + 3 * MIN),
      warm(T + 62 * MIN),
      warm(T + 63 * MIN),
      cold(T + 122 * MIN),
      warm(T + 123 * MIN),
    ]
    expect(evaluateAdvice(recs, taken, requests, prices)).toEqual({ evaluated: 3, cheapest: 2, share: 2 / 3, unevaluated: 1 })
  })

  it('judges a recommendation the person did not follow by its quoted cost', () => {
    // compact was recommended; the person continued and missed, paying the rebuild.
    const report = evaluateAdvice([rec(T, 'compact')], [{ ts: T + MIN, lever: 'continue' }], [warm(T - 10 * MIN), cold(T + 2 * MIN)], prices)
    expect(report).toEqual({ evaluated: 1, cheapest: 1, share: 1, unevaluated: 0 })
  })

  it('judges a none recommendation as continue, against the next prompt', () => {
    const report = evaluateAdvice([rec(T, 'none', 'HOT')], [{ ts: T + MIN, lever: 'continue' }], [warm(T - 10 * MIN), warm(T + 2 * MIN)], prices)
    expect(report.evaluated).toBe(1)
    expect(report.cheapest).toBe(1)
  })

  it('leaves out a recommendation replaced before any action, or with no request after the action', () => {
    expect(evaluateAdvice([rec(T, 'compact'), rec(T + MIN, 'clear')], [{ ts: T + 2 * MIN, lever: 'clear' }], [warm(T - MIN), small(T + 3 * MIN)], prices)).toMatchObject({
      evaluated: 1,
      unevaluated: 1,
    })
    expect(evaluateAdvice([rec(T, 'compact')], [{ ts: T + MIN, lever: 'compact' }], [warm(T - MIN)], prices)).toEqual({ evaluated: 0, cheapest: 0, share: null, unevaluated: 1 })
  })

  it('leaves the taken lever out when its path is unpriced, and a recommendation with no alternative unjudged', () => {
    // Compact taken on an unknown model: no measured cost, so only the quotes remain; compact (recommended) is among them.
    const unknown = request(T + 2 * MIN, { model: 'claude-unknown-9' })
    expect(evaluateAdvice([rec(T, 'compact')], [{ ts: T + MIN, lever: 'compact' }], [warm(T - MIN), unknown], prices)).toMatchObject({ evaluated: 0, unevaluated: 1 })
    // Only the recommended lever was quoted: nothing to compare it with.
    const alone: RecommendationRecord = { ...rec(T, 'compact'), quotes: [{ lever: 'compact', nowUsd: 1.2, perTurnUsd: 0 }] }
    expect(evaluateAdvice([alone], [{ ts: T + MIN, lever: 'clear' }], [warm(T - MIN), small(T + 2 * MIN)], prices)).toMatchObject({ evaluated: 0, unevaluated: 1 })
  })

  it('counts within the 5% tolerance as cheapest', () => {
    expect(CHEAPEST_TOLERANCE).toBe(1.05)
    // Continue taken and read; compact quoted a little lower: still cheapest within 5%.
    const close: RecommendationRecord = { ...rec(T, 'continue', 'HOT'), quotes: [{ lever: 'continue', nowUsd: 0.2, perTurnUsd: 0 }, { lever: 'compact', nowUsd: 0.18, perTurnUsd: 0 }] }
    const r = evaluateAdvice([close], [{ ts: T + MIN, lever: 'continue' }], [warm(T - MIN), warm(T + 2 * MIN)], prices)
    expect(r.cheapest).toBe(1)
  })
})
