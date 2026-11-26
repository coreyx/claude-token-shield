import { describe, expect, it } from 'vitest'

import { ASCII, UNICODE } from '../../../../plugin/core/render/format'
import { apportion, wrap } from '../../../../plugin/core/render/views/cells'
import { layersOf, renderPrefixMap } from '../../../../plugin/core/render/views/map'
import { prices, rules, strings } from '../../helpers'
import { request } from '../../model/fixtures'

const T = Date.UTC(2026, 0, 20, 15, 0)
const MIN = 60_000
const o = (glyphs = UNICODE) => ({ glyphs, strings, display: rules.display, tzOffsetMin: 0 })

/** Five main requests: three warm, a compaction, then the rebuilt smaller prefix and one more. */
const requests = [
  request(T, { usage: { input: 10, read: 780_000, write5m: 0, write1h: 20_000, output: 500 } }),
  request(T + 2 * MIN, { usage: { input: 10, read: 800_000, write5m: 0, write1h: 6_000, output: 500 } }),
  request(T + 4 * MIN, { usage: { input: 10, read: 806_000, write5m: 0, write1h: 5_000, output: 500 } }),
  request(T + 10 * MIN, { usage: { input: 10, read: 0, write5m: 0, write1h: 60_000, output: 500 } }),
  request(T + 12 * MIN, { usage: { input: 10, read: 60_000, write5m: 0, write1h: 3_000, output: 500 } }),
]
const events = [{ ts: T + 8 * MIN, kind: 'compaction' }]

describe('apportion and wrap', () => {
  it('splits cells in proportion and always adds up', () => {
    expect(apportion([1, 1, 1], 10).reduce((a, b) => a + b)).toBe(10)
    expect(apportion([3, 1], 8)).toEqual([6, 2])
    expect(apportion([0, 0], 5)).toEqual([0, 0])
  })

  it('wraps at spaces within the width', () => {
    expect(wrap('prefix shrinks to the system layer; the conversation is gone', 30)).toEqual(['prefix shrinks to the system', 'layer; the conversation is', 'gone'])
  })
})

describe('renderPrefixMap', () => {
  for (const width of [80, 120]) {
    it(`draws five bars and labels the rebuild compaction at ${width} columns (AC 13.1)`, () => {
      const text = renderPrefixMap(requests, events, null, width, o(), prices)
      const bars = text.split('\n').filter(l => /^\d\d:\d\d:\d\d /.test(l))
      expect(bars).toHaveLength(5)
      expect(bars[3]).toMatch(/ compaction$/)
      expect(bars.filter(l => / compaction$/.test(l))).toHaveLength(1)
      expect(text.split('\n').every(l => l.length <= width)).toBe(true)
      // The rebuilt prefix is written, not read; the warm ones are mostly read.
      expect(bars[3]).toContain('▓')
      expect(bars[3]).not.toContain('█')
      expect(bars[1]).toMatch(/█{10,}/)
    })
  }

  it('reads in monochrome and ASCII: every pattern has a legend', () => {
    const text = renderPrefixMap(requests, events, null, 80, o(ASCII), prices)
    expect(text).toMatch(/# read from cache {3}= written {3}\. uncached/)
    expect(text).not.toMatch(/[█▓░]/)
  })

  it('draws the layer ruler from the context breakdown', () => {
    const layers = layersOf([
      { name: 'System prompt', tokens: 3_000, kind: 'used' },
      { name: 'System tools', tokens: 15_000, kind: 'used' },
      { name: 'Memory files', tokens: 4_000, kind: 'used' },
      { name: 'Messages', tokens: 780_000, kind: 'used' },
      { name: 'Free space', tokens: 100_000, kind: 'free' },
    ])
    expect(layers).toEqual({ system: 18_000, project: 4_000, conversation: 780_000 })
    const text = renderPrefixMap(requests, events, layers, 120, o(), prices)
    expect(text).toMatch(/\n {15}s{3,}p+c{50,}\n {15}s system\+tools 18k  p project 4k  c conversation 780k\n/)
    expect(layersOf([])).toBeNull()
  })

  it('says so when there are no main requests yet', () => {
    expect(renderPrefixMap([], [], null, 80, o(), prices)).toBe('Prefix map: no main-conversation requests yet.')
  })
})
