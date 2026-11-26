import { describe, expect, it } from 'vitest'

import { bandOf, calibrate, calibrationPair, wilson } from '../../../plugin/core/history/calibrate'
import type { AssessmentRecord } from '../../../plugin/core/history/calibrate'
import { assessment } from '../helpers'
import { request } from '../model/fixtures'

const PRIORS = { epsWithin: 0.005, epsAfter: 0.01, minCalibrationN: 30 }

/** A recorded prediction; HOT with 40 minutes left by default. */
const rec = (over: Partial<AssessmentRecord> = {}): AssessmentRecord => ({
  ts: 0,
  state: 'HOT',
  pHit: 0.99,
  interval: [0.985, 0.998],
  ttl: '1h',
  remainingSec: 2400,
  marginSec: 40,
  ccVersion: '2.1.332',
  model: 'claude-opus-5-5',
  outcome: 'HIT',
  ...over,
})
const times = (n: number, r: AssessmentRecord) => Array.from({ length: n }, () => r)

describe('wilson', () => {
  it('brackets the observed rate and stays inside 0–1', () => {
    const [lo, hi] = wilson(9, 10)
    expect(lo).toBeLessThan(0.9)
    expect(hi).toBeGreaterThan(0.9)
    expect(wilson(0, 10)[0]).toBe(0)
    expect(wilson(10, 10)[1]).toBe(1)
    expect(wilson(0, 0)).toEqual([0, 1])
  })
})

describe('bandOf', () => {
  it('puts a prediction in its remaining-time band', () => {
    expect(bandOf(null, 40)).toBe('unknown')
    expect(bandOf(-100, 40)).toBe('past')
    expect(bandOf(20, 40)).toBe('margin')
    expect(bandOf(-40, 40)).toBe('margin')
    expect(bandOf(300, 40)).toBe('1_10m')
    expect(bandOf(601, 40)).toBe('over_10m')
  })
})

describe('calibrate', () => {
  it('counts every recorded prediction exactly once in the reliability table (AC 14.3)', () => {
    const records = [
      ...times(12, rec()),
      ...times(3, rec({ remainingSec: 300, state: 'EXPIRING', pHit: 0.97, interval: [0.95, 0.99] })),
      ...times(4, rec({ state: 'COLD', remainingSec: -3000, pHit: 0.01, interval: [0.005, 0.03], outcome: 'MISS' })),
      rec({ state: 'UNCERTAIN', remainingSec: 10, pHit: 0.5, interval: [0.3, 0.7], outcome: 'PARTIAL', ttl: '5m', ccVersion: '2.1.330' }),
    ]
    const c = calibrate(records, PRIORS)
    expect(c.n).toBe(20)
    expect(c.buckets.reduce((s, b) => s + b.n, 0)).toBe(20)
    expect(c.buckets.map(b => [b.state, b.ttl, b.band, b.n])).toEqual([
      ['HOT', '1h', 'over_10m', 12],
      ['EXPIRING', '1h', '1_10m', 3],
      ['UNCERTAIN', '5m', 'margin', 1],
      ['COLD', '1h', 'past', 4],
    ])
    // A partial read counts as read.
    expect(c.buckets.find(b => b.state === 'UNCERTAIN')!.observed).toBe(1)
    expect(c.brierBy.reduce((s, g) => s + g.n, 0)).toBe(20)
    expect(c.brier).toBeGreaterThan(0)
    expect(c.brier).toBeLessThan(0.05)
  })

  it('raises drift for HOT misses above the stated interval, and widens epsWithin (AC 14.4)', () => {
    const records = [...times(36, rec()), ...times(4, rec({ outcome: 'MISS' }))]
    const c = calibrate(records, PRIORS)
    expect(c.hot.missRate).toBeCloseTo(0.1)
    expect(c.hot.statedUpper).toBeCloseTo(0.015)
    expect(c.drift).toBe(true)
    expect(c.learned.drift).toBe(true)
    expect(c.learned.epsWithin).toBeCloseTo(wilson(4, 40)[1])
    expect(c.learned.epsWithin).toBeGreaterThan(0.1)
  })

  it('needs enough HOT predictions before it can drift, and keeps the priors until then', () => {
    const few = calibrate([...times(20, rec()), ...times(5, rec({ outcome: 'MISS' }))], PRIORS)
    expect(few.drift).toBe(false)
    expect(few.learned).toEqual({ epsWithin: 0.005, epsAfter: 0.01, n: 25, drift: false })
  })

  it('learns the rates from enough evidence, floored so a perfect run claims no certainty', () => {
    const perfect = calibrate(times(40, rec()), PRIORS)
    expect(perfect.drift).toBe(false)
    expect(perfect.learned.epsWithin).toBe(0.0005)
    const after = calibrate(times(35, rec({ state: 'COLD', remainingSec: -4000, pHit: 0.01, interval: [0.005, 0.03], outcome: 'MISS' })), PRIORS)
    expect(after.learned.epsAfter).toBe(0.001)
    expect(after.hot).toEqual({ n: 0, missRate: null, statedUpper: null })
  })

  it('reports nothing to score with no records', () => {
    const c = calibrate([], PRIORS)
    expect(c).toMatchObject({ n: 0, buckets: [], brier: null, brierBy: [], drift: false })
  })
})

describe('calibrationPair', () => {
  it('pairs a main request with the assessment before it, and skips what predicts nothing', () => {
    const a = assessment('HOT', { pHit: 0.99, interval: [0.985, 0.998], prefixTokens: { tier: 'measured', value: 802_510 }, remainingSec: 2400, marginSec: 40, ttl: { tier: 'measured', value: '1h' } })
    const r = request(1000)
    expect(calibrationPair(a, r, '2.1.332')).toEqual({
      ts: 1000,
      state: 'HOT',
      pHit: 0.99,
      interval: [0.985, 0.998],
      ttl: '1h',
      remainingSec: 2400,
      marginSec: 40,
      ccVersion: '2.1.332',
      model: 'claude-opus-5-5',
      outcome: 'HIT',
    })
    expect(calibrationPair(a, { ...r, usage: { ...r.usage, read: 0 } }, null)?.outcome).toBe('MISS')
    expect(calibrationPair(a, { ...r, lane: 'subagent' }, null)).toBeNull()
    expect(calibrationPair(assessment('UNKNOWN'), r, null)).toBeNull()
    expect(calibrationPair({ ...a, prefixTokens: { tier: 'absent', reason: 'missing' } }, r, null)).toBeNull()
    expect(calibrationPair({ ...a, ttl: { tier: 'absent', reason: 'missing' } }, r, null)?.ttl).toBeNull()
  })
})
