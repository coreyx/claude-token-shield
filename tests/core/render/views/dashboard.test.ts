import { describe, expect, it } from 'vitest'

import { CAUSES, summarize } from '../../../../plugin/core/history/summarize'
import type { SessionHistory } from '../../../../plugin/core/history/summarize'
import { ASCII, UNICODE } from '../../../../plugin/core/render/format'
import { dailyByCause, renderDashboard } from '../../../../plugin/core/render/views/dashboard'
import { prices, rules, strings } from '../../helpers'
import { request } from '../../model/fixtures'

const DAY = 86_400_000
const MIN = 60_000
const NOW = Date.UTC(2026, 0, 31, 12, 0)
const o = (glyphs = UNICODE) => ({ glyphs, strings, display: rules.display, tzOffsetMin: 0 })
const hit = (ts: number) => request(ts, { usage: { input: 10, read: 802_500, write5m: 0, write1h: 2_000, output: 500 } })
const miss = (ts: number) => request(ts, { usage: { input: 10, read: 0, write1h: 802_500, write5m: 0, output: 500 } })

/** Three days of re-caches with different causes, and some hits between. */
function history(): SessionHistory[] {
  const d1 = NOW - 3 * DAY
  const d2 = NOW - 2 * DAY
  const d3 = NOW - DAY
  return [
    { sessionId: 'a', requests: [hit(d1), miss(d1 + 70 * MIN), hit(d1 + 71 * MIN), miss(d1 + 80 * MIN)], events: [{ ts: d1 + 79 * MIN, kind: 'model_switch' }], skipped: 0 },
    { sessionId: 'b', requests: [hit(d2), hit(d2 + 2 * MIN), miss(d2 + 3 * MIN), miss(d2 + 200 * MIN)], events: [{ ts: d2 + 2.5 * MIN, kind: 'compaction' }], skipped: 0 },
    { sessionId: 'c', requests: [hit(d3), miss(d3 + 10 * MIN)], events: [], skipped: 0 },
  ]
}

describe('dailyByCause', () => {
  it('puts each re-cache on its local day, and the days sum to the period total (AC 13.5)', () => {
    const s = summarize(history(), { from: NOW - 30 * DAY, to: NOW }, { misses: false }, prices, 'firstParty')
    const days = dailyByCause(s, 0)
    expect(days.map(d => d.day)).toEqual(['01-28', '01-29', '01-30'])
    for (const d of days) expect(CAUSES.reduce((sum, c) => sum + d.byCause[c], 0)).toBeCloseTo(d.total, 10)
    expect(days.reduce((sum, d) => sum + d.total, 0)).toBeCloseTo(s.recacheUsd, 10)
    expect(days[0]!.byCause.switch).toBeGreaterThan(0)
    expect(days[1]!.byCause.compaction).toBeGreaterThan(0)
  })
})

describe('renderDashboard', () => {
  for (const width of [80, 120]) {
    it(`draws a stacked bar per day, the gap histogram against the TTL, and the sections at ${width} columns`, () => {
      const s = summarize(history(), { from: NOW - 30 * DAY, to: NOW }, { misses: false }, prices, 'firstParty')
      const text = renderDashboard(s, { advice: 'Advice line', calibration: 'Calibration table', ttl: 'TTL advisor' }, width, o())
      const bars = text.split('\n').filter(l => /^\d\d-\d\d {2}[TSXCV?]/.test(l))
      expect(bars).toHaveLength(3)
      expect(bars[0]).toMatch(/^01-28 {2}T+S+ +\$\d+\.\d\d$/)
      // The legend names every cause, wrapped to the width.
      for (const named of ['T TTL expiry', 'S switch', 'X tools', 'C compaction', 'V server-side', '? unexplained']) expect(text).toContain(named)
      expect(text).toMatch(/\n-- TTL 1h\n|\n–– TTL 1h\n/)
      for (const section of ['Advice line', 'Calibration table', 'TTL advisor']) expect(text).toContain(section)
      expect(text.split('\n').every(l => l.length <= width)).toBe(true)
    })
  }

  it('says so with nothing to show, and reads in ASCII', () => {
    const empty = summarize([], { from: NOW - DAY, to: NOW }, { misses: false }, prices, 'firstParty')
    const text = renderDashboard(empty, { advice: null, calibration: null, ttl: null }, 80, o(ASCII))
    expect(text).toContain('No re-caches in this window.')
    expect(text).not.toMatch(/[█–·]/)
  })
})
