import { describe, expect, it } from 'vitest'

import { summarize } from '../../../plugin/core/history/summarize'
import { UNICODE } from '../../../plugin/core/render/format'
import { MAX_ROWS, renderHistory } from '../../../plugin/core/render/history'
import { prices, rules, strings } from '../helpers'
import { request } from '../model/fixtures'

const o = { glyphs: UNICODE, strings, display: rules.display, tzOffsetMin: 0 }
const NOW = Date.UTC(2026, 0, 31, 12, 0)

describe('renderHistory', () => {
  it('shows the most recent rows and counts the earlier ones', () => {
    const t0 = NOW - 86_400_000
    const requests = Array.from({ length: MAX_ROWS + 6 }, (_, i) => request(t0 + i * 60_000, { usage: { input: 10, read: 802_500, write5m: 0, write1h: 2_000, output: 500 } }))
    const s = summarize([{ sessionId: 'a', requests, events: [], skipped: 0 }], { from: NOW - 30 * 86_400_000, to: NOW }, { misses: false }, prices, 'firstParty')
    const text = renderHistory(s, 100, o)
    expect(text).toContain('– 5 earlier rows not shown')
    expect(text.split('\n').filter(l => /^\d\d-\d\d /.test(l))).toHaveLength(MAX_ROWS)
  })

  it('fits every line to the width', () => {
    const s = summarize([], { from: NOW - 86_400_000, to: NOW }, { misses: false }, prices, 'firstParty')
    expect(renderHistory(s, 40, o).split('\n').every(l => l.length <= 40)).toBe(true)
  })
})
