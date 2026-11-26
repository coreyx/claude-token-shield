import { describe, expect, it } from 'vitest'

import { DEFAULT_CONFIG, validateConfig } from '../../../plugin/core/config/config'
import { nextTurnCost } from '../../../plugin/core/cost/cost'
import type { NextTurnCost } from '../../../plugin/core/cost/cost'
import { formatString } from '../../../plugin/core/data/load'
import { gateDecision, overThreshold, RELEASE_WINDOW_MS } from '../../../plugin/core/gate/gate'
import { assessment, prices, strings } from '../helpers'

const NOW = Date.UTC(2026, 10, 20, 15)

/** The 12.1 fixture: Opus 5.5, 1h TTL, 812,470 tokens, $6.50 cold. */
const cold650: NextTurnCost = nextTurnCost({ prefixTokens: 812470, model: 'claude-opus-5-5', ttl: '1h', provider: 'firstParty', at: NOW }, prices)

describe('gateDecision', () => {
  it('holds the $6.50 COLD prompt and shows $6.50 (AC 12.1)', () => {
    const d = gateDecision(assessment('COLD'), cold650, 'api', DEFAULT_CONFIG, null, 'h1', NOW)
    expect(d.action).toBe('hold')
    expect(d.held).toEqual({ hash: 'h1', at: NOW })
    expect(d.params!.usd).toBeCloseTo(6.5, 2)
    const text = formatString(strings, d.reasonKey!, { ...d.params, cost: '$6.50', detail: 'expired 16:40', lever: '/compact' })
    expect(text).toContain('$6.50')
    expect(text).toMatch(/^Token Shield: /)
  })

  it('holds under a fresh install’s defaults (AC 12.5)', () => {
    expect(gateDecision(assessment('COLD'), cold650, 'api', validateConfig({}).config, null, 'h1', NOW).action).toBe('hold')
  })

  it('lets the same prompt through within 60 s and holds it again at 61 s (AC 12.2)', () => {
    const first = gateDecision(assessment('COLD'), cold650, 'api', DEFAULT_CONFIG, null, 'h1', NOW)
    const at60 = gateDecision(assessment('COLD'), cold650, 'api', DEFAULT_CONFIG, first.held, 'h1', NOW + RELEASE_WINDOW_MS)
    expect(at60).toEqual({ action: 'pass', held: null })
    const at61 = gateDecision(assessment('COLD'), cold650, 'api', DEFAULT_CONFIG, first.held, 'h1', NOW + 61_000)
    expect(at61.action).toBe('hold')
    expect(at61.held!.at).toBe(NOW + 61_000)
  })

  it('holds a different prompt even inside the window', () => {
    const first = gateDecision(assessment('INVALIDATED'), cold650, 'api', DEFAULT_CONFIG, null, 'h1', NOW)
    expect(gateDecision(assessment('INVALIDATED'), cold650, 'api', DEFAULT_CONFIG, first.held, 'h2', NOW + 5000).action).toBe('hold')
  })

  it.each(['UNKNOWN', 'HOT', 'EXPIRING', 'UNCERTAIN'] as const)('never holds in %s (AC 12.4)', state => {
    expect(gateDecision(assessment(state), cold650, 'api', DEFAULT_CONFIG, null, 'h', NOW)).toEqual({ action: 'pass', held: null })
  })

  it('passes a $4 rebuild under a $5 threshold (AC 22.1)', () => {
    // Opus 4.1 writes at $30/MTok on 1h: $4 is ~133k tokens, under the 250k token threshold.
    const cost4 = nextTurnCost({ prefixTokens: 133334, model: 'claude-opus-4-1', ttl: '1h', provider: 'firstParty', at: NOW }, prices)
    expect(cost4.usd!.cold).toBeCloseTo(4, 2)
    expect(gateDecision(assessment('COLD'), cost4, 'api', DEFAULT_CONFIG, null, 'h', NOW).action).toBe('hold')
    const cfg = validateConfig({ thresholdUsd: 5 }).config
    expect(gateDecision(assessment('COLD'), cost4, 'api', cfg, null, 'h', NOW).action).toBe('pass')
  })

  it('warns instead of holding in warn mode, and does nothing when off (REQ-12.0.4)', () => {
    const warn = gateDecision(assessment('COLD'), cold650, 'api', { ...DEFAULT_CONFIG, gate: 'warn' }, null, 'h', NOW)
    expect(warn).toMatchObject({ action: 'warn', held: null, reasonKey: 'gate.warn' })
    expect(gateDecision(assessment('COLD'), cold650, 'api', { ...DEFAULT_CONFIG, gate: 'off' }, null, 'h', NOW).action).toBe('pass')
  })

  it('leaves dollars out of the reason when the model is unpriced', () => {
    const d = gateDecision(assessment('COLD'), { ...cold650, usd: null }, 'api', DEFAULT_CONFIG, null, 'h', NOW)
    expect(d.action).toBe('hold')
    expect(d.params).toEqual({ state: 'COLD', tokens: 812470 })
  })
})

describe('overThreshold', () => {
  const small = (tokens: number, usd: number | null): NextTurnCost => ({ ...cold650, prefixTokens: tokens, usd: usd === null ? null : { warm: 0, cold: usd, penalty: usd } })

  it('counts either dollars or tokens', () => {
    expect(overThreshold(small(300_000, 0.1), 'api', DEFAULT_CONFIG)).toBe(true)
    expect(overThreshold(small(100_000, 3), 'api', DEFAULT_CONFIG)).toBe(true)
    expect(overThreshold(small(100_000, 1), 'api', DEFAULT_CONFIG)).toBe(false)
    expect(overThreshold(small(100_000, null), 'api', DEFAULT_CONFIG)).toBe(false)
  })

  it('counts only tokens on a subscription', () => {
    expect(overThreshold(small(100_000, 3), 'subscription', DEFAULT_CONFIG)).toBe(false)
    expect(overThreshold(small(300_000, 0.1), 'subscription', DEFAULT_CONFIG)).toBe(true)
    expect(overThreshold(small(100_000, 3), 'subscription-credits', DEFAULT_CONFIG)).toBe(true)
  })
})
