import { describe, expect, it } from 'vitest'

import { ASCII, UNICODE } from '../../../../plugin/core/render/format'
import { renderLevers } from '../../../../plugin/core/render/views/levers'
import { rules, strings } from '../../helpers'
import { build } from '../scenarios'

const o = (glyphs = UNICODE) => ({ glyphs, strings, display: rules.display, tzOffsetMin: 0 })

describe('renderLevers', () => {
  for (const width of [80, 120]) {
    it(`shows the levers side by side with exactly one recommended in the COLD 812k fixture at ${width} columns (AC 4.1, 17.5)`, () => {
      const b = build('COLD')
      const text = renderLevers(b.quotes, b.rec, width, o())
      for (const name of ['continue', '/compact', '/clear', '/rewind']) expect(text).toMatch(new RegExp(`^[▶ ] ${name.replace('/', '\/')} `, 'm'))
      // One lever row carries the mark; the legend line explains it.
      expect(text.split('\n').filter(l => l.startsWith('▶ ') && l !== '▶ recommended')).toHaveLength(1)
      expect(text.split('\n').every(l => l.length <= width)).toBe(true)
    })
  }

  it('wraps a long effect onto the next line instead of cutting it, and reads in ASCII', () => {
    const b = build('COLD')
    const text = renderLevers(b.quotes, { ...b.rec, lever: 'compact' }, 80, o(ASCII))
    expect(text).toMatch(/^> \/compact /m)
    // The continuation line sits under the effect column, with nothing cut.
    expect(text).toMatch(/\n {30,}layer; the conversation is gone\n/)
    expect(text).toContain('> recommended')
  })

  it('says when no lever beats simply continuing', () => {
    const b = build('HOT')
    expect(renderLevers(b.quotes, { ...b.rec, lever: 'none' }, 80, o())).toContain(
      'No lever is recommended over simply continuing.',
    )
  })
})
