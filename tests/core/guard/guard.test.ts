import { describe, expect, it } from 'vitest'

import { DEFAULT_CONFIG } from '../../../plugin/core/config/config'
import { BURST_MS, changeGuard, requestMatches, switchGuard } from '../../../plugin/core/guard/guard'
import type { SwitchFacts } from '../../../plugin/core/guard/guard'
import { changeGuardText, switchGuardText } from '../../../plugin/core/render/band'
import { ASCII, UNICODE } from '../../../plugin/core/render/format'
import { rules, strings } from '../helpers'

const AT = Date.UTC(2026, 0, 1, 12, 0)
const facts = (over: Partial<SwitchFacts> = {}): SwitchFacts => ({
  from: 'claude-opus-5-5',
  to: 'claude-sonnet-5-5',
  requested: 'sonnet',
  warm: true,
  contextTokens: 812_470,
  estimatedUsd: 6.5,
  at: AT,
  ...over,
})
const o = { strings, display: rules.display, tzOffsetMin: 0, glyphs: UNICODE }

describe('requestMatches', () => {
  it('matches the target the request names, by id or family alias', () => {
    expect(requestMatches('sonnet', 'claude-sonnet-5-5')).toBe(true)
    expect(requestMatches('sonnet', 'claude-haiku-5-5')).toBe(false)
    expect(requestMatches('claude-haiku-5-5', 'claude-haiku-5-5')).toBe(true)
    expect(requestMatches('opus[1m]', 'claude-opus-5-5[1m]')).toBe(true)
  })

  it('lets the burst decide when the request names no family or is absent (the picker)', () => {
    expect(requestMatches(null, 'claude-sonnet-5-5')).toBe(true)
    expect(requestMatches('', 'claude-sonnet-5-5')).toBe(true)
    expect(requestMatches('default', 'claude-sonnet-5-5')).toBe(true)
  })
})

describe('switchGuard', () => {
  it('shows a warm switch with Claude Code estimate, without asking by default (AC 10.1, 10.6)', () => {
    expect(switchGuard(facts(), 'HOT', 'api', DEFAULT_CONFIG, null)).toEqual({ action: 'show', ask: false, model: 'claude-sonnet-5-5', tokens: 812_470, usd: 6.5 })
  })

  it('is silent when cold, invalidated, or not warm (AC 10.2, REQ-10.0.5)', () => {
    expect(switchGuard(facts(), 'COLD', 'api', DEFAULT_CONFIG, null)).toEqual({ action: 'silent', why: 'cold' })
    expect(switchGuard(facts(), 'INVALIDATED', 'api', DEFAULT_CONFIG, null)).toEqual({ action: 'silent', why: 'cold' })
    expect(switchGuard(facts({ warm: false }), 'HOT', 'api', DEFAULT_CONFIG, null)).toEqual({ action: 'silent', why: 'cold' })
  })

  it('is silent for a same-model pick and for the pair other target', () => {
    expect(switchGuard(facts({ to: 'claude-opus-5-5', requested: 'opus' }), 'HOT', 'api', DEFAULT_CONFIG, null)).toEqual({ action: 'silent', why: 'same-model' })
    expect(switchGuard(facts({ to: 'claude-haiku-5-5' }), 'HOT', 'api', DEFAULT_CONFIG, null)).toEqual({ action: 'silent', why: 'not-requested' })
  })

  it('shows one event per burst, and the next switch after the window', () => {
    expect(switchGuard(facts({ at: AT + 5 }), 'HOT', 'api', DEFAULT_CONFIG, AT)).toEqual({ action: 'silent', why: 'same-burst' })
    expect(switchGuard(facts({ at: AT + BURST_MS }), 'HOT', 'api', DEFAULT_CONFIG, AT).action).toBe('show')
  })

  it('asks only with switchConfirm on and a rebuild that reaches the threshold (AC 10.5, 10.6)', () => {
    const on = { ...DEFAULT_CONFIG, switchConfirm: 'on' as const }
    expect(switchGuard(facts(), 'HOT', 'api', on, null)).toMatchObject({ action: 'show', ask: true })
    const small = facts({ contextTokens: 40_000, estimatedUsd: 0.5 })
    expect(switchGuard(small, 'HOT', 'api', on, null)).toMatchObject({ action: 'show', ask: false })
    expect(switchGuard(facts({ contextTokens: 40_000, estimatedUsd: DEFAULT_CONFIG.thresholdUsd }), 'EXPIRING', 'api', on, null)).toMatchObject({ ask: true })
    // A subscription is judged on tokens: dollars alone don't reach it.
    expect(switchGuard(facts({ contextTokens: 40_000, estimatedUsd: 9 }), 'HOT', 'subscription', on, null)).toMatchObject({ ask: false })
    expect(switchGuard(facts(), 'HOT', 'subscription', on, null)).toMatchObject({ ask: true })
  })
})

describe('changeGuard', () => {
  it('toasts a warm effort or fast change the rules say WILL rebuild, and nothing that has no effect (AC 10.3)', () => {
    expect(changeGuard('effort_change', 'WILL', 'HOT')).toEqual({ action: 'toast', key: 'guard.effort.toast' })
    expect(changeGuard('effort_change', 'NO_EFFECT', 'HOT')).toEqual({ action: 'silent' })
    expect(changeGuard('fast_toggle', 'WILL', 'EXPIRING')).toEqual({ action: 'toast', key: 'guard.fast.toast' })
    expect(changeGuard('fast_toggle', 'MAY', 'HOT')).toEqual({ action: 'silent' })
  })

  it('gives a plugin reload an info toast, and stays silent once the cache is lost', () => {
    expect(changeGuard('reload_plugins', 'MAY', 'UNCERTAIN')).toEqual({ action: 'toast', key: 'guard.reload.toast' })
    expect(changeGuard('effort_change', 'WILL', 'COLD')).toEqual({ action: 'silent' })
    expect(changeGuard('reload_plugins', 'MAY', 'UNKNOWN')).toEqual({ action: 'silent' })
    expect(changeGuard('rewind', 'WILL', 'HOT')).toEqual({ action: 'silent' })
  })
})

describe('guard text', () => {
  const show = { model: 'claude-sonnet-5-5', tokens: 812_470, usd: 6.5 }

  it('labels the toast and the confirmation reason as Token Shield and carries the estimate (AC 10.4)', () => {
    const { toast, reason } = switchGuardText(show, true, o)
    expect(toast).toBe('Token Shield: switching to claude-sonnet-5-5 rebuilds the cache (812,470 tokens) ≈ $6.50. Cheaper for a one-off task: run it in a subagent on claude-sonnet-5-5.')
    expect(reason).toBe('Token Shield: this switch rebuilds the cache (812,470 tokens), ≈ $6.50.')
  })

  it('leaves dollars out cleanly on a subscription, and follows the glyph setting', () => {
    const { toast, reason } = switchGuardText(show, false, { ...o, glyphs: ASCII })
    expect(toast).toBe('Token Shield: switching to claude-sonnet-5-5 rebuilds the cache (812,470 tokens). Cheaper for a one-off task: run it in a subagent on claude-sonnet-5-5.')
    expect(reason).toBe('Token Shield: this switch rebuilds the cache (812,470 tokens).')
  })

  it('prices an effort change, or names its tokens where dollars are not shown', () => {
    expect(changeGuardText('guard.effort.toast', 6.5, 812_470, o)).toBe('Token Shield: this effort change rebuilds the cache on the next request ≈ $6.50.')
    expect(changeGuardText('guard.fast.toast', null, 812_470, o)).toBe('Token Shield: toggling fast mode rebuilds the cache on the next request ≈ 812,470 tokens.')
    expect(changeGuardText('guard.reload.toast', null, 0, o)).toBe('Token Shield: reloading plugins may rebuild the cache if tool definitions change.')
  })
})
