import { describe, expect, it } from 'vitest'

import { classifyProbe, HOT_PROBE_MIN_SEC, probeQuote, probeRecord } from '../../../plugin/core/probe/probe'
import { assessment } from '../helpers'
import { build } from '../render/scenarios'

describe('probeQuote', () => {
  it('quotes both prices in UNCERTAIN (AC 7.1)', () => {
    const b = build('UNCERTAIN')
    const q = probeQuote(b.a, b.cost, false)
    expect(q).toEqual({ action: 'confirm', warmUsd: b.cost.usd!.warm, coldUsd: b.cost.usd!.cold, tokens: 812_470 })
    expect(q.action === 'confirm' && q.coldUsd! > q.warmUsd!).toBe(true)
  })

  it('declines COLD or INVALIDATED with HIGH confidence, unless forced (AC 7.3)', () => {
    for (const state of ['COLD', 'INVALIDATED'] as const) {
      const a = assessment(state, { confidence: 'HIGH' })
      expect(probeQuote(a, null, false)).toEqual({ action: 'decline', reasonKey: 'probe.decline_lost' })
      expect(probeQuote(a, null, true).action).toBe('confirm')
    }
    expect(probeQuote(assessment('COLD', { confidence: 'MEDIUM' }), null, false).action).toBe('confirm')
  })

  it('declines HOT with more than 5 minutes left, and offers it nearer the expiry', () => {
    expect(probeQuote(assessment('HOT', { remainingSec: HOT_PROBE_MIN_SEC + 1 }), null, false)).toEqual({ action: 'decline', reasonKey: 'probe.decline_hot' })
    expect(probeQuote(assessment('HOT', { remainingSec: HOT_PROBE_MIN_SEC }), null, false).action).toBe('confirm')
    expect(probeQuote(assessment('HOT', { remainingSec: 3000 }), null, true).action).toBe('confirm')
  })

  it('quotes unknown prices as null when nothing is priced', () => {
    const q = probeQuote(assessment('UNKNOWN'), null, false)
    expect(q).toMatchObject({ action: 'confirm', warmUsd: null, coldUsd: null })
  })
})

describe('classifyProbe', () => {
  it('reads 95% or more as a hit, 5% or less as a miss, and anything between as partial', () => {
    expect(classifyProbe(771_847, 812_470)).toBe('HIT')
    expect(classifyProbe(800_000, 812_470)).toBe('HIT')
    expect(classifyProbe(40_000, 812_470)).toBe('MISS')
    expect(classifyProbe(400_000, 812_470)).toBe('PARTIAL')
    expect(classifyProbe(0, 0)).toBe('MISS')
    expect(classifyProbe(10, 0)).toBe('HIT')
  })
})

describe('probeRecord', () => {
  const usage = { input_tokens: 8, output_tokens: 2, cache_read_input_tokens: 809_458, cache_creation_input_tokens: 3_000 }

  it('records the probe on its own lane with the writes under the session TTL', () => {
    expect(probeRecord(usage, 1000, 900, 'claude-opus-5-5', '1h')).toEqual({
      id: 'probe-1000',
      lane: 'probe',
      tsStart: 1000,
      tsStartTier: 'measured',
      durationMs: 900,
      model: 'claude-opus-5-5',
      speed: 'standard',
      ttl: '1h',
      usage: { input: 8, read: 809_458, write5m: 0, write1h: 3_000, output: 2 },
      source: 'mod',
    })
    expect(probeRecord(usage, 1000, 900, 'claude-opus-5-5', '5m').usage).toMatchObject({ write5m: 3_000, write1h: 0 })
    expect(probeRecord(usage, 1000, 900, 'claude-opus-5-5', undefined)).not.toHaveProperty('ttl')
  })
})
