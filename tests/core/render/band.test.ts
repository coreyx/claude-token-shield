import { describe, expect, it } from 'vitest'

import { DEFAULT_CONFIG } from '../../../plugin/core/config/config'
import { gateDecision } from '../../../plugin/core/gate/gate'
import { bandText, gateText, notificationText } from '../../../plugin/core/render/band'
import { ASCII, UNICODE } from '../../../plugin/core/render/format'
import { rules, strings } from '../helpers'
import { build, STATES } from './scenarios'

const base = { strings, display: rules.display, tzOffsetMin: 0, glyphs: UNICODE }

describe('band text', () => {
  it('shows only in EXPIRING, COLD and INVALIDATED, labelled Token Shield with a lever line', () => {
    for (const state of STATES) {
      const text = bandText(build(state).view('default'), base)
      if (state === 'EXPIRING' || state === 'COLD' || state === 'INVALIDATED') {
        expect(text).toMatch(/^Token Shield · /)
        expect(text).toContain('  → ')
      } else {
        expect(text).toBeNull()
      }
    }
  })

  it('prices COLD at the rebuild and EXPIRING at what waiting would add', () => {
    expect(bandText(build('COLD').view('default'), base)).toContain('re-caches 812,470 tokens (≈ $6.50)')
    expect(bandText(build('EXPIRING').view('default'), base)).toMatch(/cache warm until \d\d:\d\d; send before then, or the next prompt re-caches 812,470 tokens \(≈ \$6\.\d\d\)/)
  })

  it('drops the rebuild dollars on a subscription and uses ASCII glyphs when asked', () => {
    const text = bandText(build('COLD').view('default', 'subscription'), { ...base, glyphs: ASCII })!
    expect(text.split('->')[0]).toBe('Token Shield | cache cold; the next prompt re-caches 812,470 tokens.  ')
  })
})

describe('notification text', () => {
  it('turns a time into a clock reading and a cause into its name', () => {
    expect(notificationText({ key: 'notify.expiring', level: 'warning', trigger: 'state:EXPIRING', params: { expiresAt: Date.UTC(2026, 0, 1, 14, 5) } }, base)).toBe('Token Shield: cache expires at 14:05.')
    const invalidated = notificationText({ key: 'notify.invalidated', level: 'warning', trigger: 'state:INVALIDATED', params: { cause: 'model_switch' } }, base)
    expect(invalidated).toContain('model switch')
  })
})

describe('gate text', () => {
  const decide = (which: 'COLD' | 'INVALIDATED', gate: 'hold' | 'warn' = 'hold', billing: 'api' | 'subscription' = 'api') => {
    const b = build(which)
    return { d: gateDecision(b.a, b.cost, billing, { ...DEFAULT_CONFIG, gate }, null, 'h', b.a.at), view: b.view('default', billing) }
  }

  it('holds COLD with the time it expired, the $6.50 rebuild and what to do first (AC 12.1)', () => {
    const { d, view } = decide('COLD')
    expect(d.action).toBe('hold')
    expect(gateText(d, view, 'compact', base)).toMatch(
      /^Token Shield: cache COLD \(expired at \d\d:\d\d\)\. This prompt is expected to re-cache 812,470 tokens ≈ \$6\.50\. Press Enter again within 60 s to send it anyway, or \/compact first\.$/,
    )
  })

  it('names what invalidated the cache, and falls back to /compact for a non-command lever', () => {
    const { d, view } = decide('INVALIDATED')
    expect(gateText(d, view, 'continue', base)).toMatch(/\(.+ invalidated it\)\..*or \/compact first\.$/)
  })

  it('warns without the Enter-again line when the gate is set to warn', () => {
    const { d, view } = decide('COLD', 'warn')
    expect(d.action).toBe('warn')
    expect(gateText(d, view, 'clear', base)).toBe('Token Shield: cache COLD. This prompt is expected to re-cache 812,470 tokens ≈ $6.50.')
  })

  it('leaves dollars out cleanly where they are not shown', () => {
    const { d, view } = decide('COLD', 'warn', 'subscription')
    expect(d.action).toBe('warn')
    expect(gateText(d, view, 'clear', base)).toBe('Token Shield: cache COLD. This prompt is expected to re-cache 812,470 tokens.')
  })
})
