import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { assess } from '../../../plugin/core/assess/assess'
import type { AssessParams } from '../../../plugin/core/assess/types'
import { formatString, parsePrices, parseRules, parseStrings } from '../../../plugin/core/data/load'
import { initialState, reduce } from '../../../plugin/core/model/reduce'
import { parseSnapshot } from '../../../plugin/core/model/snapshot'
import type { Fact, RequestRecord, SessionState } from '../../../plugin/core/model/types'
import { HORIZON_TURNS, quoteLevers } from '../../../plugin/core/recommend/levers'
import type { LeverContext, LeverQuote } from '../../../plugin/core/recommend/levers'
import { recommend } from '../../../plugin/core/recommend/recommend'
import { payload, request, T0 } from '../model/fixtures'

/** Reads a file relative to the repository root. */
const repoFile = (path: string) => readFileSync(fileURLToPath(new URL(`../../../${path}`, import.meta.url)), 'utf8')
const rules = parseRules(repoFile('plugin/data/rules.json'))
const prices = parsePrices(repoFile('plugin/data/prices.json'))
const strings = parseStrings(repoFile('plugin/data/strings.en.json'))
const MS = T0 * 1000
const params: AssessParams = { rules, env: { provider: 'firstParty', toolSearch: true, experimentalBetasDisabled: false } }
const ctx: LeverContext = { prices, model: 'claude-opus-5-5', provider: 'firstParty', now: MS }

/** The session's first request wrote a 40k system layer; a later one sits `agoSec` back. */
function history(agoSec: number): Fact[] {
  const first: RequestRecord = request(MS - 4 * 3600_000, { usage: { input: 5, read: 0, write5m: 0, write1h: 40000, output: 300 } })
  const later: RequestRecord = request(MS - agoSec * 1000, { usage: { input: 10, read: 300000, write5m: 0, write1h: 5000, output: 400 } })
  return [{ kind: 'request', request: first }, { kind: 'request', request: later }]
}

/** A session with the given snapshot cache fields, plus extra facts, assessed at T0. */
function session(cache: Record<string, unknown>, ...facts: Fact[]): { state: SessionState; quotes: LeverQuote[]; a: ReturnType<typeof assess> } {
  const snapshot = parseSnapshot(payload({}, cache), MS)
  const state = [...facts, { kind: 'snapshot', snapshot } as Fact].reduce(reduce, initialState())
  const a = assess(state, MS, params)
  return { state, a, quotes: quoteLevers(a, state, ctx) }
}

const cold = () => session({ warm: false, expires_at: null }, ...history(2 * 3600))
const byLever = (quotes: LeverQuote[], lever: string) => quotes.find(q => q.lever === lever)

describe('COLD with an 812k prefix (AC 4.1)', () => {
  it('lists continue, /compact, /clear and /recap with costs, and recommends exactly one', () => {
    const { a, quotes } = cold()
    expect(a.state).toBe('COLD')
    for (const lever of ['continue', 'compact', 'clear', 'recap']) expect(byLever(quotes, lever)!.now.usd, lever).not.toBeNull()
    const rec = recommend(a, quotes)
    expect(['continue', 'compact', 'rewind']).toContain(rec.lever)
    expect(rec.reasonKey).toBe('recommend.cheapest')
  })

  it('prices continue as a full re-cache and /compact as a summary plus a smaller prefix', () => {
    const { quotes } = cold()
    const cont = byLever(quotes, 'continue')!
    const compact = byLever(quotes, 'compact')!
    expect(cont.now.usd).toBeCloseTo(0.99 * 6.4998 + 0.01 * 0.1625, 2)
    expect(cont.horizonUsd).toBeCloseTo(cont.now.usd! + HORIZON_TURNS * 0.1625, 2)
    expect(compact.now.tokens).toBe(40000 + Math.round(812470 * 0.08))
    expect(compact.horizonUsd!).toBeLessThan(cont.horizonUsd!)
    expect(recommend(cold().a, quotes).lever).toBe('compact')
  })

  it('never recommends /clear, though it is the cheapest on paper', () => {
    const { a, quotes } = cold()
    const clear = byLever(quotes, 'clear')!
    expect(clear.horizonUsd!).toBeLessThan(Math.min(...quotes.filter(q => q.horizonUsd !== null && q.lever !== 'clear' && q.lever !== 'recap' && q.lever !== 'ttl').map(q => q.horizonUsd!)))
    expect(recommend(a, quotes).lever).not.toBe('clear')
  })
})

describe('the other states', () => {
  it('needs no action while HOT (AC 4.2)', () => {
    const { a, quotes } = session({ expires_at: T0 + 48 * 60 })
    expect(recommend(a, quotes)).toEqual({ lever: 'none', reasonKey: 'recommend.none.hot', params: { expiresAt: (T0 + 48 * 60) * 1000 }, probeHint: false })
  })

  it('says to send before the expiry while EXPIRING', () => {
    const { a, quotes } = session({ expires_at: T0 + 300 })
    expect(recommend(a, quotes)).toMatchObject({ lever: 'continue', reasonKey: 'recommend.continue.expiring' })
  })

  it('mentions a probe only when the outcome is near even', () => {
    const boundary = session({ expires_at: T0 })
    expect(recommend(boundary.a, boundary.quotes)).toMatchObject({ lever: 'continue', probeHint: true })
    const stale = session({ expires_at: T0 + 48 * 60 })
    const staleA = assess(stale.state, MS + 61_000, params)
    expect(staleA.state).toBe('UNCERTAIN')
    expect(recommend(staleA, stale.quotes).probeHint).toBe(false)
  })

  it('offers nothing in UNKNOWN', () => {
    const unknown = assess(reduce(initialState(), { kind: 'snapshot', snapshot: parseSnapshot(payload({ prompt_cache: undefined }), MS) }), MS, params)
    expect(quoteLevers(unknown, initialState(), ctx)).toEqual([])
    expect(recommend(unknown, [])).toMatchObject({ lever: 'none', reasonKey: 'recommend.none.unknown', params: { reason: 'no_response' } })
  })

  it('leaves the expiry out of the reason when it is unknown', () => {
    const { a, quotes } = session({ expires_at: null })
    expect(recommend(a, quotes).params).toEqual({})
  })

  it('quotes keep-alive and probe only while the cache may be warm', () => {
    expect(byLever(session({ expires_at: T0 + 48 * 60 }).quotes, 'keepalive')).toBeDefined()
    expect(byLever(cold().quotes, 'keepalive')).toBeUndefined()
    expect(byLever(cold().quotes, 'probe')).toBeUndefined()
  })
})

describe('/rewind', () => {
  it('reads an earlier prefix still within its TTL, and can be the cheapest after a switch', () => {
    // first (system layer), then 10 minutes ago (still warm), then 1 minute ago, then a model switch.
    const latest: Fact = { kind: 'request', request: request(MS - 60_000) }
    const { a, quotes } = session({ expires_at: T0 + 48 * 60 }, ...history(10 * 60), latest, { kind: 'event', event: { ts: MS - 1000, kind: 'model_switch' } })
    expect(a.state).toBe('INVALIDATED')
    const rewind = byLever(quotes, 'rewind')!
    expect(rewind.now.usd).toBeCloseTo(305010 * 4 * 0.05 * 1e-6, 4)
    expect(recommend(a, quotes).lever).toBe('rewind')
  })

  it('is unknown once the earlier entry has expired, and absent without history', () => {
    expect(byLever(cold().quotes, 'rewind')!.now.usd).toBeNull()
    expect(byLever(session({ warm: false, expires_at: null }).quotes, 'rewind')).toBeUndefined()
  })
})

describe('explanations and unknown costs', () => {
  it('describes /recap as neither invalidating the cache nor shrinking the prefix (AC 4.3)', () => {
    const recap = byLever(cold().quotes, 'recap')!
    expect(formatString(strings, recap.whenKey)).toMatch(/neither invalidates the cache nor shrinks the prefix/)
    expect(formatString(strings, recap.effectKey)).toBe('no effect on the prefix')
  })

  it('lists an unpriceable lever as "cost unknown" and never recommends it (AC 4.4)', () => {
    const { a, quotes } = cold()
    const btw = byLever(quotes, 'btw')!
    expect(btw.now.usd).toBeNull()
    expect(formatString(strings, 'cost.unknown')).toBe('cost unknown')
    expect(recommend(a, quotes).lever).not.toBe('btw')
  })

  it('recommends nothing when no candidate can be priced', () => {
    const { a, state } = cold()
    const quotes = quoteLevers(a, state, { ...ctx, model: 'some-other-model' })
    expect(quotes.every(q => q.lever === 'recap' || q.lever === 'ttl' || q.now.usd === null)).toBe(true)
    expect(recommend(a, quotes)).toMatchObject({ lever: 'none', reasonKey: 'recommend.none.unknown_costs' })
  })

  it('leaves /compact and /clear unknown without a system-layer size, or takes it from the context', () => {
    const bare = session({ warm: false, expires_at: null })
    expect(byLever(bare.quotes, 'compact')!.now.usd).toBeNull()
    expect(byLever(bare.quotes, 'clear')!.now.usd).toBeNull()
    const given = quoteLevers(bare.a, bare.state, { ...ctx, systemTokens: 30000, summaryFraction: 0.05 })
    expect(byLever(given, 'compact')!.now.tokens).toBe(30000 + Math.round(812470 * 0.05))
  })

  it('recommends continuing when a small prefix makes compaction dearer', () => {
    const small = session({ warm: false, expires_at: null, recache_tokens_if_cold: 50000 }, ...history(2 * 3600))
    expect(recommend(small.a, small.quotes).lever).toBe('continue')
  })

  it('keeps every quote unknown, not zero, when the prefix size is unknown', () => {
    const { quotes } = session({ warm: false, expires_at: null, recache_tokens_if_cold: null, ttl: null })
    for (const lever of ['continue', 'compact', 'btw', 'model']) {
      expect(byLever(quotes, lever)!.now, lever).toEqual({ usd: null, tokens: null })
    }
    expect(byLever(quotes, 'continue')!.perTurnAfter).toEqual({ usd: null, tokens: null })
  })

  it('quotes keep-alive as unknown for an unpriced model', () => {
    const { a, state } = session({ expires_at: T0 + 48 * 60 })
    expect(byLever(quoteLevers(a, state, { ...ctx, model: 'some-other-model' }), 'keepalive')!.now.usd).toBeNull()
  })

  it('finds no system layer when the first request wrote nothing, and rewinds on a 5-minute entry', () => {
    const first = request(MS - 4 * 3600_000, { usage: { input: 5, read: 0, write5m: 0, write1h: 0, output: 1 } })
    const earlier = request(MS - 120_000, { ttl: '5m', usage: { input: 1, read: 9000, write5m: 1000, write1h: 0, output: 1 } })
    const latest = request(MS - 60_000)
    const { quotes } = session(
      { warm: false, expires_at: null },
      { kind: 'request', request: first },
      { kind: 'request', request: earlier },
      { kind: 'request', request: latest },
    )
    expect(byLever(quotes, 'clear')!.now.usd).toBeNull()
    expect(byLever(quotes, 'rewind')!.now.tokens).toBe(10001)
    expect(byLever(quotes, 'rewind')!.now.usd).not.toBeNull()
  })

  it('has a catalog entry for every effect and explanation', () => {
    for (const q of [...cold().quotes, ...session({ expires_at: T0 + 48 * 60 }).quotes]) {
      expect(formatString(strings, q.effectKey), q.effectKey).not.toMatch(/^\[/)
      expect(formatString(strings, q.whenKey), q.whenKey).not.toMatch(/^\[/)
    }
  })
})
