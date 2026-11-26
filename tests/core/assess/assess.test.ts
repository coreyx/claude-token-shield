import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { assess } from '../../../plugin/core/assess/assess'
import { assessmentProbability, formatProbability } from '../../../plugin/core/assess/format'
import type { AssessEnv, AssessParams } from '../../../plugin/core/assess/types'
import { formatString, parseRules, parseStrings } from '../../../plugin/core/data/load'
import { initialState, reduce } from '../../../plugin/core/model/reduce'
import { parseSnapshot } from '../../../plugin/core/model/snapshot'
import { glyphParams, UNICODE } from '../../../plugin/core/render/format'
import type { Fact, SessionState } from '../../../plugin/core/model/types'
import { payload, request, T0 } from '../model/fixtures'

/** Reads a file relative to the repository root. */
function repoFile(path: string): string {
  return readFileSync(fileURLToPath(new URL(`../../../${path}`, import.meta.url)), 'utf8')
}

const rules = parseRules(repoFile('plugin/data/rules.json'))
const strings = parseStrings(repoFile('plugin/data/strings.en.json'))
const MS = T0 * 1000
const subscription: AssessEnv = { provider: 'firstParty', toolSearch: true, experimentalBetasDisabled: false }
const params: AssessParams = { rules, env: subscription }

/** A state holding one snapshot received at `now` whose cache expires `inSec` from now. */
function warmState(inSec: number, overrides: Record<string, unknown> = {}, cache: Record<string, unknown> = {}): SessionState {
  const snapshot = parseSnapshot(payload(overrides, { expires_at: T0 + inSec, ...cache }), MS)
  return reduce(initialState(), { kind: 'snapshot', snapshot })
}

/** Adds facts to a state. */
function plus(state: SessionState, ...facts: Fact[]): SessionState {
  return facts.reduce(reduce, state)
}

/** A pending event of `kind` one second after T0. */
function event(kind: string, detail?: { from?: string; to?: string }): Fact {
  return { kind: 'event', event: { ts: MS + 1000, kind, ...(detail ? { detail } : {}) } }
}

const at = (state: SessionState, p: AssessParams = params, offsetSec = 0) => assess(state, MS + offsetSec * 1000, p)

describe('one fixture per state, each giving that state only (AC 2.1)', () => {
  it('HOT: 48 minutes left on a 1h TTL', () => {
    const a = at(warmState(48 * 60))
    expect(a.state).toBe('HOT')
    expect(a.confidence).toBe('HIGH')
    expect(a.pHit).toBeCloseTo(0.995)
    expect(a.interval![0]).toBeCloseTo(0.985)
    expect(a.interval![1]).toBeCloseTo(0.9975)
  })

  it('EXPIRING: 7 minutes left, inside the 10-minute window', () => {
    expect(at(warmState(7 * 60)).state).toBe('EXPIRING')
  })

  it('UNCERTAIN: at the expiry boundary', () => {
    const a = at(warmState(0))
    expect(a.state).toBe('UNCERTAIN')
    expect(a.pHit).toBeCloseTo(0.5, 1)
    expect(a.interval![0]).toBeGreaterThan(0.15)
    expect(a.interval![1]).toBeLessThan(0.8)
    expect(a.confidence).toBe('MEDIUM')
  })

  it('INVALIDATED: a model switch after the last request (AC 2.4)', () => {
    const a = at(plus(warmState(48 * 60), event('model_switch', { from: 'claude-opus-5-5', to: 'claude-sonnet-5-5' })))
    expect(a.state).toBe('INVALIDATED')
    expect(a.cause!.kind).toBe('model_switch')
    expect(formatString(strings, `event.${a.cause!.kind}`)).toBe('model switch')
    expect(a.confidence).toBe('HIGH')
    expect(a.pHit).toBe(rules.priors.epsAfter)
  })

  it('COLD: Claude Code reports the cache cold', () => {
    const a = at(warmState(-600, {}, { warm: false, expires_at: null }))
    expect(a.state).toBe('COLD')
    expect(a.confidence).toBe('HIGH')
  })

  it('COLD: the expiry passed by more than the margin', () => {
    expect(at(warmState(-120)).state).toBe('COLD')
  })

  it('UNKNOWN: no response yet (AC 1.5)', () => {
    const a = at(warmState(0, { prompt_cache: undefined }))
    expect(a).toMatchObject({ state: 'UNKNOWN', unknownReason: 'no_response', pHit: null, interval: null })
    expect(formatString(strings, a.drivers[0]!.key)).toContain('no response')
  })
})

describe('UNKNOWN cases', () => {
  it('turns cache features off below v2.1.260, naming the version (AC 1.4)', () => {
    const a = at(warmState(48 * 60, { version: '2.1.259' }))
    expect(a.state).toBe('UNKNOWN')
    expect(a.unknownReason).toBe('version')
    expect(formatString(strings, a.drivers[0]!.key, a.drivers[0]!.params)).toContain('v2.1.260')
  })

  it('prefers the engine-reported version to the snapshot', () => {
    expect(at(warmState(48 * 60), { ...params, ccVersion: '2.1.200' }).unknownReason).toBe('version')
  })

  it('reports caching off, never COLD (AC 1.6)', () => {
    const a = at(warmState(-600, {}, { caching_observed: false, warm: false }))
    expect(a.state).toBe('UNKNOWN')
    expect(a.unknownReason).toBe('caching_off')
  })

  it('has nothing to go on in an empty session', () => {
    expect(at(initialState()).unknownReason).toBe('no_response')
  })
})

describe('the invalidation table', () => {
  it.each(['mcp_config_edit', 'claude_md_edit', 'permission_mode_change'])('ignores %s (AC 2.3)', kind => {
    expect(at(plus(warmState(48 * 60), event(kind))).state).toBe('HOT')
  })

  it('invalidates on effort changes for a model without per-message effort (AC 2.5)', () => {
    const s = plus(warmState(48 * 60, { model: { id: 'claude-sonnet-5' } }), event('effort_change'))
    expect(at(s).state).toBe('INVALIDATED')
  })

  it('keeps the cache on Opus 5.5 with subscription or API-key auth (AC 2.5)', () => {
    const s = plus(warmState(48 * 60, { model: { id: 'claude-opus-5-5[1m]' } }), event('effort_change'))
    expect(at(s).state).toBe('HOT')
  })

  it('invalidates on Opus 5.5 through Bedrock or with experimental betas disabled', () => {
    const s = plus(warmState(48 * 60), event('effort_change'))
    expect(at(s, { rules, env: { ...subscription, provider: 'bedrock' } }).state).toBe('INVALIDATED')
    expect(at(s, { rules, env: { ...subscription, experimentalBetasDisabled: true } }).state).toBe('INVALIDATED')
  })

  it('treats tool changes as invalidating only when tools load upfront', () => {
    const s = plus(warmState(48 * 60), event('tools_changed'))
    expect(at(s).state).toBe('HOT')
    expect(at(s, { rules, env: { ...subscription, toolSearch: false } }).state).toBe('INVALIDATED')
  })

  it('makes a MAY event uncertain, with low confidence while its probability is a prior', () => {
    const a = at(plus(warmState(48 * 60), event('reload_plugins')))
    expect(a.state).toBe('UNCERTAIN')
    expect(a.pHit).toBeCloseTo(0.995 * 0.5)
    expect(a.confidence).toBe('LOW')
  })

  it('treats an event kind the table lacks as MAY', () => {
    expect(at(plus(warmState(48 * 60), event('something_new'))).pending[0]!.impact).toBe('MAY')
  })

  it('treats a TTL change as no effect on the current entry', () => {
    const s = plus(warmState(48 * 60), { kind: 'snapshot', snapshot: parseSnapshot(payload({}, { ttl: '5m', expires_at: T0 + 240 }), MS + 1000) })
    const a = at(s, params, 2)
    expect(a.pending.map(p => [p.event.kind, p.impact])).toEqual([['ttl_bucket_change', 'NO_EFFECT']])
    expect(a.warnWindowSec).toBe(60)
    expect(a.state).toBe('HOT')
  })
})

describe('staleness, drift and fallbacks', () => {
  it('marks a 61-second-old snapshot stale with confidence LOW (AC 2.7)', () => {
    const a = at(warmState(48 * 60), params, 61)
    expect(a.stale).toBe(true)
    expect(a.confidence).toBe('LOW')
    expect(a.state).toBe('UNCERTAIN')
    expect(a.drivers.map(d => d.key)).toContain('driver.stale')
  })

  it('is not stale at 60 seconds', () => {
    expect(at(warmState(48 * 60), params, 60).stale).toBe(false)
  })

  it('records drift when native and own expiry disagree, and caps confidence at MEDIUM (REQ-2.0.10)', () => {
    // Own expiry: request start + 1h = T0 − 600 s + 3600 s = T0 + 3000 s; native: T0 + 2880 s. 120 s apart.
    const s = plus(warmState(48 * 60), { kind: 'request', request: request(MS - 600_000) })
    const a = at(s)
    expect(a.driftSec).toBe(120)
    expect(a.confidence).toBe('MEDIUM')
    expect(a.state).toBe('HOT')
  })

  it('runs on its own observations without the bridge, capped at MEDIUM (D2)', () => {
    const s = plus(initialState(), { kind: 'request', request: request(MS - 12 * 60_000) })
    const a = at(s)
    expect(a.state).toBe('HOT')
    expect(a.nativeUnavailable).toBe(true)
    expect(a.confidence).toBe('MEDIUM')
    expect(a.expiresAt).toEqual({ tier: 'inferred', value: MS + 48 * 60_000 })
    expect(a.prefixTokens).toEqual({ tier: 'inferred', value: 10 + 800000 + 2000 + 500 })
  })

  it('widens the margin when the start time was not measured', () => {
    const s = plus(initialState(), { kind: 'request', request: request(MS - 60 * 60_000 + 20_000, { tsStartTier: 'inferred' }) })
    const a = at(s)
    expect(a.marginSec).toBe(rules.timing.skewSec + 30 + rules.timing.baseMarginSec)
    expect(a.state).toBe('UNCERTAIN')
    const withDuration = plus(initialState(), { kind: 'request', request: request(MS, { tsStartTier: 'inferred', durationMs: 8000 }) })
    expect(at(withDuration).marginSec).toBe(rules.timing.skewSec + 8 + rules.timing.baseMarginSec)
  })

  it('stays HOT at MEDIUM confidence when Claude Code says warm but gives no expiry', () => {
    const a = at(warmState(0, {}, { expires_at: null }))
    expect(a.state).toBe('HOT')
    expect(a.remainingSec).toBeNull()
    expect(a.confidence).toBe('MEDIUM')
    expect(a.drivers.map(d => d.key)).toContain('driver.expiry_unknown')
  })

  it('uses the shorter warn window when the TTL is unknown', () => {
    const a = at(warmState(48 * 60, {}, { ttl: null }))
    expect(a.ttl.tier).toBe('absent')
    expect(a.warnWindowSec).toBe(60)
  })

  it('takes the TTL from the last request when the snapshot lacks it', () => {
    const s = plus(warmState(48 * 60, {}, { ttl: null }), { kind: 'request', request: request(MS - 12 * 60_000) })
    expect(at(s).ttl).toEqual({ tier: 'measured', value: '1h' })
  })

  it('honors configured warn windows', () => {
    expect(at(warmState(15 * 60), { ...params, warnWindowsSec: { '1h': 20 * 60, '5m': 60 } }).state).toBe('EXPIRING')
  })
})

describe('learned rates (D19)', () => {
  it('uses learned rates and drops the low-evidence label with enough data', () => {
    const a = at(warmState(48 * 60), { ...params, learned: { epsWithin: 0.002, epsAfter: 0.02, n: 120, drift: false } })
    expect(a.pHit).toBeCloseTo(0.998)
    expect(a.lowEvidence).toBe(false)
  })

  it('gives MAY events MEDIUM confidence once learned', () => {
    const a = at(plus(warmState(48 * 60), event('reload_plugins')), { ...params, learned: { epsWithin: 0.005, epsAfter: 0.01, n: 60, drift: false } })
    expect(a.confidence).toBe('MEDIUM')
  })

  it('caps confidence and says so during calibration drift', () => {
    const a = at(warmState(48 * 60), { ...params, learned: { epsWithin: 0.04, epsAfter: 0.01, n: 60, drift: true } })
    expect(a.confidence).toBe('MEDIUM')
    expect(a.drivers.map(d => d.key)).toContain('driver.calibration_drift')
  })
})

describe('drivers', () => {
  it('lists the reasons in order with their tiers', () => {
    const a = at(warmState(48 * 60))
    expect(a.drivers.map(d => [d.key, d.tier])).toEqual([
      ['driver.ttl', 'measured'],
      ['driver.expiry', 'inferred'],
      ['driver.remaining', 'inferred'],
      ['driver.pending_none', 'measured'],
      ['driver.eps', 'estimated'],
    ])
    for (const d of a.drivers) expect(formatString(strings, d.key, { ...glyphParams(UNICODE), ...d.params })).not.toMatch(/^\[|\{/)
  })
})

describe('display caps (AC 2.6)', () => {
  it.each<[number | null, string | null]>([
    [0.9995, '≥ 99%'],
    [0.99, '≥ 99%'],
    [0.0004, '≤ 1%'],
    [0.45, '~45%'],
    [0.985, '~99%'],
    [0.012, '~1%'],
    [null, null],
    [Number.NaN, null],
  ])('%s → %s', (p, text) => {
    expect(formatProbability(p, rules.display, strings)).toBe(text)
  })

  it('shows no percentage in UNKNOWN', () => {
    const unknown = at(warmState(0, { prompt_cache: undefined }))
    expect(assessmentProbability(unknown, rules.display, strings)).toBeNull()
    expect(assessmentProbability(at(warmState(48 * 60)), rules.display, strings)).toBe('≥ 99%')
  })
})
