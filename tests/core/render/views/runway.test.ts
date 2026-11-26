import { describe, expect, it } from 'vitest'

import { ASCII, UNICODE } from '../../../../plugin/core/render/format'
import { renderContext } from '../../../../plugin/core/render/views/context'
import { renderRunway } from '../../../../plugin/core/render/views/runway'
import { assessment, rules, strings } from '../../helpers'
import { build } from '../scenarios'

const o = (glyphs = UNICODE) => ({ glyphs, strings, display: rules.display, tzOffsetMin: 0 })

describe('renderRunway', () => {
  for (const width of [80, 120]) {
    it(`places now inside the warn window in EXPIRING and shows both costs at ${width} columns (AC 13.2)`, () => {
      const b = build('EXPIRING')
      const text = renderRunway(b.a, b.cost, width, o())
      const [, axis, marker] = text.split('\n')
      const now = marker!.indexOf('▲')
      expect(now).toBeGreaterThan(0)
      // The axis under the marker is the warn window (or the margin inside it).
      expect(['=', '~']).toContain(axis![now])
      expect(axis).toContain('|')
      expect(text).toMatch(/Act before \d\d:\d\d ≈ \$0\.\d\d · after ≈ \$6\.50/)
      expect(text.split('\n').every(l => l.length <= width)).toBe(true)
    })
  }

  it('puts now before the warn window while HOT, and reads in ASCII', () => {
    const b = build('HOT')
    const text = renderRunway(b.a, b.cost, 80, o(ASCII))
    const [, axis, marker] = text.split('\n')
    expect(axis![marker!.indexOf('^')]).toBe('-')
    expect(text).not.toMatch(/[▲─]/)
  })

  it('says so when the expiry is not known', () => {
    expect(renderRunway(assessment('UNKNOWN'), null, 80, o())).toBe("Expiry runway: the expiry isn't known yet.")
  })
})

describe('renderContext', () => {
  it('shows each category as a bar, stable or changing each turn (REQ-13.0.4)', () => {
    const text = renderContext(
      [
        { name: 'System prompt', tokens: 3_000, kind: 'used' },
        { name: 'System tools', tokens: 15_000, kind: 'used' },
        { name: 'Memory files', tokens: 4_000, kind: 'used' },
        { name: 'Messages', tokens: 780_000, kind: 'used' },
        { name: 'Free space', tokens: 100_000, kind: 'free' },
      ],
      80,
      o(),
    )
    expect(text.split('\n')[0]).toBe('Context composition · 802k tokens in the prefix')
    expect(text).toMatch(/^System prompt +█+ +3k {2}stable$/m)
    expect(text).toMatch(/^Messages +█+ +780k {2}changes each turn$/m)
    expect(text).not.toContain('Free space')
    expect(text.split('\n').every(l => l.length <= 80)).toBe(true)
  })

  it('says so with nothing counted yet', () => {
    expect(renderContext([], 80, o())).toBe('Context composition: not available yet.')
  })
})
