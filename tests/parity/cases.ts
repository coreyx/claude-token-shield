/**
 * Inputs for the parity fixtures in fixtures/parity/: one case per state,
 * billing mode and recommendation path. Each case is raw input (statusline
 * payloads, requests, events, the time and environment); the TypeScript core
 * computes the expected output, and the Go port must reproduce it.
 * Every value is synthetic.
 */

import type { AssessEnv } from '../../plugin/core/assess/types'
import type { EventRecord, RequestRecord, ResumeInfo } from '../../plugin/core/model/types'
import type { CheckMode } from '../../plugin/core/view/view'
import { payload, request } from '../core/model/fixtures'

/** One input fact, in the fixture's language-neutral form. */
export type CaseFact =
  | { readonly kind: 'snapshot'; readonly receivedAt: number; readonly payload: Record<string, unknown> }
  | { readonly kind: 'request'; readonly request: RequestRecord }
  | { readonly kind: 'event'; readonly event: EventRecord }
  | { readonly kind: 'resume'; readonly resume: ResumeInfo }

/** A parity case's inputs. */
export interface CaseInput {
  readonly name: string
  readonly now: number
  readonly tzOffsetMin: number
  readonly env: AssessEnv
  readonly ccVersion?: string
  readonly defaultModel?: string
  readonly mode: CheckMode
  readonly width: number
  readonly glyphs: 'unicode' | 'ascii'
  readonly facts: readonly CaseFact[]
}

const at = (hh: number, mm: number, ss = 0) => Date.UTC(2026, 0, 1, hh, mm, ss)
const sec = (ms: number) => ms / 1000
const first: AssessEnv = { provider: 'firstParty', toolSearch: true, experimentalBetasDisabled: false }

/** A session's requests: a 40k system layer written at 14:02, reads after, the last at 15:40:02. */
function requests(model = 'claude-opus-5-5', lastTtl: '1h' | '5m' = '1h'): CaseFact[] {
  const rows: [number, number, number][] = [
    [at(14, 2, 11), 0, 40000],
    [at(14, 3, 40), 40000, 6000],
    [at(15, 12, 47), 46000, 300000],
    [at(15, 40, 2), 346000, 3000],
  ]
  return rows.map(([ts, read, write], i) => ({
    kind: 'request',
    request: request(ts, { model, ttl: i === rows.length - 1 ? lastTtl : '1h', usage: { input: 500, read, write5m: lastTtl === '5m' ? write : 0, write1h: lastTtl === '5m' ? 0 : write, output: 600 } }),
  }))
}

/** A snapshot received at `receivedAt` with cache fields, payload overrides, and API billing unless `subscription`. */
function snap(receivedAt: number, cache: Record<string, unknown>, overrides: Record<string, unknown> = {}, subscription = false): CaseFact {
  return { kind: 'snapshot', receivedAt, payload: payload({ ...(subscription ? {} : { rate_limits: undefined }), ...overrides }, cache) }
}

const WARM = sec(at(16, 40, 2))
const base = { tzOffsetMin: 0, env: first, mode: 'default' as CheckMode, width: 100, glyphs: 'unicode' as const }

export const CASES: readonly CaseInput[] = [
  { ...base, name: 'hot-api', now: at(15, 52, 2), facts: [...requests(), snap(at(15, 52), { expires_at: WARM })] },
  { ...base, name: 'hot-subscription-verbose', now: at(15, 52, 2), mode: 'verbose', width: 120, facts: [...requests(), snap(at(15, 52), { expires_at: WARM }, {}, true)] },
  {
    ...base,
    name: 'expiring-credits',
    now: at(15, 44, 32),
    facts: [...requests('claude-opus-5-5', '5m'), snap(at(15, 44, 30), { ttl: '5m', expires_at: sec(at(15, 45, 2)) }, {}, true)],
  },
  { ...base, name: 'uncertain-boundary-ascii', now: at(16, 40, 0), width: 80, glyphs: 'ascii', facts: [...requests(), snap(at(16, 39, 50), { expires_at: WARM })] },
  {
    ...base,
    name: 'uncertain-may-event',
    now: at(15, 52, 2),
    facts: [...requests(), snap(at(15, 52), { expires_at: WARM }), { kind: 'event', event: { ts: at(15, 50), kind: 'reload_plugins' } }],
  },
  {
    ...base,
    name: 'invalidated-switch-rewind-diff',
    now: at(15, 52, 2),
    mode: 'diff',
    facts: [
      ...requests(),
      snap(at(15, 52), { expires_at: WARM }),
      { kind: 'event', event: { ts: at(15, 50), kind: 'model_switch', detail: { from: 'claude-opus-5-5', to: 'claude-sonnet-5-5' } } },
    ],
  },
  {
    ...base,
    name: 'invalidated-switch-default',
    now: at(15, 52, 2),
    facts: [...requests(), snap(at(15, 52), { expires_at: WARM }), { kind: 'event', event: { ts: at(15, 50), kind: 'model_switch', detail: { from: 'claude-opus-5-5', to: 'claude-sonnet-5-5' } } }],
  },
  {
    ...base,
    name: 'invalidated-effort-sonnet',
    now: at(15, 52, 2),
    facts: [...requests('claude-sonnet-5'), snap(at(15, 52), { expires_at: WARM }, { model: { id: 'claude-sonnet-5' } }), { kind: 'event', event: { ts: at(15, 50), kind: 'effort_change' } }],
  },
  {
    ...base,
    name: 'hot-effort-opus-no-effect',
    now: at(15, 52, 2),
    facts: [...requests(), snap(at(15, 52), { expires_at: WARM }), { kind: 'event', event: { ts: at(15, 50), kind: 'effort_change' } }],
  },
  {
    ...base,
    name: 'cold-compact',
    now: at(17, 30),
    facts: [...requests(), snap(at(17, 29, 55), { warm: false, expires_at: null })],
  },
  {
    ...base,
    name: 'cold-continue-small-prefix',
    now: at(17, 30),
    facts: [...requests(), snap(at(17, 29, 55), { warm: false, expires_at: null, recache_tokens_if_cold: 50000 })],
  },
  {
    ...base,
    name: 'cold-bedrock',
    now: at(17, 30),
    env: { ...first, provider: 'bedrock' },
    facts: [...requests(), snap(at(17, 29, 55), { warm: false, expires_at: null }, { model: { id: 'us.anthropic.claude-opus-5-5-v1:0' } })],
  },
  {
    ...base,
    name: 'cold-subscription-80-ascii',
    now: at(17, 30),
    width: 80,
    glyphs: 'ascii',
    facts: [...requests(), snap(at(17, 29, 55), { warm: false, expires_at: null }, {}, true)],
  },
  {
    ...base,
    name: 'cold-unpriced-model',
    now: at(17, 30),
    facts: [...requests('example-model'), snap(at(17, 29, 55), { warm: false, expires_at: null }, { model: { id: 'example-model' } })],
  },
  { ...base, name: 'unknown-no-response', now: at(15, 52, 2), facts: [snap(at(15, 52), {}, { prompt_cache: undefined })] },
  { ...base, name: 'unknown-version', now: at(15, 52, 2), facts: [...requests(), snap(at(15, 52), { expires_at: WARM }, { version: '2.1.259' })] },
  { ...base, name: 'unknown-caching-off', now: at(15, 52, 2), facts: [...requests(), snap(at(15, 52), { caching_observed: false, warm: false, expires_at: null })] },
  { ...base, name: 'stale-snapshot', now: at(15, 52, 2), facts: [...requests(), snap(at(15, 51), { expires_at: WARM })] },
  // Resumed before any snapshot or request: timing from the last response and its TTL (REQ-11).
  {
    ...base,
    name: 'resume-warm-verbose',
    now: at(15, 52, 2),
    mode: 'verbose',
    defaultModel: 'claude-opus-5-5',
    facts: [{ kind: 'resume', resume: { ts: at(15, 52), source: 'resume', secondsSinceLastResponse: 600, contextTokens: 812470, likelyExpired: false, estimatedCacheWriteUsd: 6.5, ttl: '1h' } }],
  },
  {
    ...base,
    name: 'resume-cold',
    now: at(15, 52, 2),
    defaultModel: 'claude-opus-5-5',
    facts: [{ kind: 'resume', resume: { ts: at(15, 52), source: 'resume', secondsSinceLastResponse: 10800, contextTokens: 812470, likelyExpired: true, estimatedCacheWriteUsd: 6.5, ttl: '1h' } }],
  },
  {
    ...base,
    name: 'fork-without-ttl-unknown',
    now: at(15, 52, 2),
    defaultModel: 'claude-opus-5-5',
    facts: [{ kind: 'resume', resume: { ts: at(15, 52), source: 'fork', secondsSinceLastResponse: 600, contextTokens: 812470, likelyExpired: false } }],
  },
  { ...base, name: 'no-bridge-verbose', now: at(15, 52, 2), mode: 'verbose', defaultModel: 'claude-opus-5-5', facts: requests() },
]
