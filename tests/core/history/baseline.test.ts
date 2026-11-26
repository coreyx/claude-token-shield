import { describe, expect, it } from 'vitest'

import { baseline, installTime } from '../../../plugin/core/history/baseline'
import { summarize } from '../../../plugin/core/history/summarize'
import { prices } from '../helpers'
import { request } from '../model/fixtures'

const NOW = Date.UTC(2026, 0, 31, 12, 0)
const DAY = 86_400_000
const empty = summarize([], { from: NOW - 30 * DAY, to: NOW }, { misses: false }, prices, 'firstParty')

describe('baseline', () => {
  it('takes the install time from the first request the mod wrote', () => {
    const sessions = [{ sessionId: 'a', requests: [request(NOW - 3 * DAY, { source: 'transcript' }), request(NOW - 2 * DAY), request(NOW - DAY)], events: [], skipped: 0 }]
    expect(installTime(sessions)).toBe(NOW - 2 * DAY)
    expect(installTime([])).toBeNull()
  })

  it('is null before any install, or with no transcripts from before it', () => {
    const backfill = [{ sessionId: 'b', requests: [request(NOW - 40 * DAY, { source: 'transcript' })], events: [], skipped: 0 }]
    expect(baseline(backfill, null, empty, prices, 'firstParty')).toBeNull()
    expect(baseline(backfill, NOW - 50 * DAY, empty, prices, 'firstParty')).toBeNull()
  })

  it('counts a short period as a week, so a day of history cannot inflate the rate', () => {
    const backfill = [{ sessionId: 'b', requests: [request(NOW - 10 * DAY, { source: 'transcript' }), request(NOW - 10 * DAY + 3_600_000, { source: 'transcript' })], events: [], skipped: 0 }]
    const b = baseline(backfill, NOW - 9 * DAY, empty, prices, 'firstParty')!
    expect(b.weeks).toBe(1)
    expect(b.currentPerWeekUsd).toBe(0)
  })
})
