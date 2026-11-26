import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { billingMode, nextTurnCost, preferClaudeCodeEstimate, presentCost } from '../../../plugin/core/cost/cost'
import type { CostInput } from '../../../plugin/core/cost/cost'
import { mergeOverride, modelPrice, tableAt } from '../../../plugin/core/cost/prices'
import { DataError, parsePrices } from '../../../plugin/core/data/load'
import type { Prices } from '../../../plugin/core/data/types'
import { parseSnapshot } from '../../../plugin/core/model/snapshot'
import { payload, T0 } from '../model/fixtures'

const prices = parsePrices(readFileSync(fileURLToPath(new URL('../../../plugin/data/prices.json', import.meta.url)), 'utf8'))
const AT = Date.UTC(2026, 10, 20)

/** Opus 5.5, 1h TTL, first-party, 812,470-token prefix, overridable. */
function input(overrides: Partial<CostInput> = {}): CostInput {
  return { prefixTokens: 812470, model: 'claude-opus-5-5', ttl: '1h', provider: 'firstParty', at: AT, ...overrides }
}

describe('nextTurnCost', () => {
  it('prices the worked example: cold $6.50 ± $0.01, warm $0.16–$0.18 (AC 3.1)', () => {
    const c = nextTurnCost(input(), prices)
    expect(c.usd!.cold).toBeGreaterThanOrEqual(6.49)
    expect(c.usd!.cold).toBeLessThanOrEqual(6.51)
    expect(c.usd!.warm).toBeGreaterThanOrEqual(0.16)
    expect(c.usd!.warm).toBeLessThanOrEqual(0.18)
    expect(c.usd!.penalty).toBeCloseTo(c.usd!.cold - c.usd!.warm)
    expect(c.priceDate).toBe('2026-11-03')
    expect(c.providerBasis).toBe('list')
  })

  it('prices the 5-minute TTL at the 1.25x write rate (analysis §7: ≈ $4.06)', () => {
    expect(nextTurnCost(input({ ttl: '5m' }), prices).usd!.cold).toBeCloseTo(4.06, 2)
  })

  it.each([
    ['claude-haiku-5-5', 0.1244],
    ['claude-sonnet-5-5', 0.4977],
    ['claude-opus-5-5', 0.9954],
  ])('matches Claude Code’s own switch estimate for %s at 124,421 tokens (spikes.md §1)', (model, usd) => {
    expect(nextTurnCost(input({ model, prefixTokens: 124421 }), prices).usd!.cold).toBeCloseTo(usd, 3)
  })

  it('applies a prompt-size tier to every token of the prompt', () => {
    const small = nextTurnCost(input({ model: 'claude-haiku-5-5', prefixTokens: 90000 }), prices).usd!.cold
    const large = nextTurnCost(input({ model: 'claude-haiku-5-5', prefixTokens: 90000, tailTokens: 20000 }), prices).usd!.cold
    expect(small).toBeCloseTo(90000 * 0.1 * 2 * 1e-6)
    expect(large).toBeCloseTo(90000 * 0.5 * 2 * 1e-6)
  })

  it('adds the known tail to the warm cost and tags an unknown one estimated', () => {
    const withTail = nextTurnCost(input({ tailTokens: 3000 }), prices)
    expect(withTail.tailTier).toBe('measured')
    expect(withTail.usd!.warm).toBeCloseTo(812470 * 4 * 0.05 * 1e-6 + 3000 * 4 * 2 * 1e-6)
    expect(nextTurnCost(input(), prices).tailTier).toBe('estimated')
  })

  it('applies provider multipliers and labels independent pricing as estimated', () => {
    const global = nextTurnCost(input({ provider: 'bedrock' }), prices)
    const regional = nextTurnCost(input({ provider: 'bedrock', regional: true }), prices)
    expect(global.providerBasis).toBe('estimated')
    expect(regional.usd!.cold).toBeCloseTo(global.usd!.cold * 1.1)
    expect(nextTurnCost(input({ provider: 'firstParty', regional: true }), prices).usd!.cold).toBeCloseTo(global.usd!.cold)
  })

  it('uses the fast-mode rate when there is one', () => {
    expect(nextTurnCost(input({ fast: true }), prices).usd!.cold).toBeCloseTo(812470 * 8 * 2 * 1e-6)
    expect(nextTurnCost(input({ fast: true, model: 'claude-sonnet-5-5' }), prices).usd!.cold).toBeCloseTo(812470 * 2 * 2 * 1e-6)
  })

  it('matches provider ids and size suffixes to the base model', () => {
    const plain = nextTurnCost(input(), prices).usd!.cold
    expect(nextTurnCost(input({ model: 'us.anthropic.claude-opus-5-5-v1:0' }), prices).usd!.cold).toBeCloseTo(plain)
    expect(nextTurnCost(input({ model: 'claude-opus-5-5[1m]' }), prices).usd!.cold).toBeCloseTo(plain)
  })

  it('reports unknown dollars, but still the tokens, for a model without a price', () => {
    const c = nextTurnCost(input({ model: 'some-other-model' }), prices)
    expect(c.usd).toBeNull()
    expect(c.prefixTokens).toBe(812470)
  })

  it('treats an unknown provider as estimated list price', () => {
    const c = nextTurnCost(input({ provider: 'gateway' }), prices)
    expect(c.providerBasis).toBe('estimated')
    expect(c.usd!.cold).toBeCloseTo(nextTurnCost(input(), prices).usd!.cold)
  })
})

describe('price tables by date', () => {
  const dated: Prices = {
    ...prices,
    tables: [
      { ...prices.tables[0]!, effective: '2026-11-03' },
      { ...prices.tables[0]!, effective: '2026-06-01', models: { 'claude-opus-5-5': { input: 5, read_mult: 0.1, write_5m_mult: 1.25, write_1h_mult: 2, output_mult: 5 } } },
    ],
  }

  it('uses the table in effect on each request’s date', () => {
    expect(tableAt(dated, Date.UTC(2026, 7, 1)).effective).toBe('2026-06-01')
    expect(tableAt(dated, Date.UTC(2026, 10, 3)).effective).toBe('2026-11-03')
    expect(nextTurnCost(input({ at: Date.UTC(2026, 7, 1) }), dated).usd!.cold).toBeCloseTo(812470 * 5 * 2 * 1e-6)
  })

  it('falls back to the oldest table before any applies', () => {
    expect(tableAt(dated, Date.UTC(2025, 0, 1)).effective).toBe('2026-06-01')
  })

  it('finds models by base id', () => {
    expect(modelPrice(prices.tables[0]!, 'claude-haiku-4-5-20251001')!.input).toBe(1)
  })
})

describe('user price override (AC 3.4)', () => {
  it('changes the costs for an overridden model', () => {
    const merged = mergeOverride(prices, { models: { 'claude-opus-5-5': { input: 2 } } })
    expect(nextTurnCost(input(), merged).usd!.cold).toBeCloseTo(812470 * 2 * 2 * 1e-6)
    expect(nextTurnCost(input({ model: 'claude-sonnet-5-5' }), merged).usd!.cold).toBeCloseTo(
      nextTurnCost(input({ model: 'claude-sonnet-5-5' }), prices).usd!.cold,
    )
  })

  it('adds a model only when every required rate is given', () => {
    const merged = mergeOverride(prices, {
      models: {
        'claude-new': { input: 1, read_mult: 0.1, write_5m_mult: 1.25, write_1h_mult: 2, output_mult: 5 },
        'claude-partial': { input: 1 },
      },
    })
    expect(nextTurnCost(input({ model: 'claude-new' }), merged).usd).not.toBeNull()
    expect(nextTurnCost(input({ model: 'claude-partial' }), merged).usd).toBeNull()
  })

  it('overrides provider multipliers and adds complete providers', () => {
    const merged = mergeOverride(prices, {
      providers: { bedrock: { multiplier: 0.8, basis: 'list' }, gateway: { multiplier: 1.2, basis: 'estimated' }, half: { multiplier: 1 } },
    })
    const t = merged.tables[0]!
    expect(t.providers.bedrock).toMatchObject({ multiplier: 0.8, basis: 'list' })
    expect(t.providers.gateway!.multiplier).toBe(1.2)
    expect(t.providers.half).toBeUndefined()
  })

  it('accepts tiers and leaves an empty override as is', () => {
    const merged = mergeOverride(prices, { models: { 'claude-opus-5-5': { tiers: [{ above: 500000, input: 6 }] } } })
    expect(nextTurnCost(input(), merged).usd!.cold).toBeCloseTo(812470 * 6 * 2 * 1e-6)
    expect(mergeOverride(prices, {})).toEqual(prices)
  })

  it.each<[string, unknown, string]>([
    ['not an object', [], 'prices.override.json: must be an object'],
    ['models not an object', { models: 1 }, 'models: must be an object'],
    ['entry not an object', { models: { x: 1 } }, 'models.x: must be an object'],
    ['unknown field', { models: { x: { price: 1 } } }, 'models.x.price: is not a known field'],
    ['zero rate', { models: { x: { input: 0 } } }, 'models.x.input: must be a number above 0'],
    ['bad tiers', { models: { x: { tiers: [{ above: 1 }] } } }, 'models.x.tiers'],
    ['bad basis', { providers: { x: { basis: 'guess' } } }, 'providers.x.basis'],
  ])('rejects %s', (_name, override, fragment) => {
    expect(() => mergeOverride(prices, override)).toThrow(DataError)
    expect(() => mergeOverride(prices, override)).toThrow(fragment)
  })
})

describe('billing modes', () => {
  const snap = (overrides: Record<string, unknown>, cache: Record<string, unknown> = {}) => parseSnapshot(payload(overrides, cache), T0 * 1000)

  it('detects a subscription on the 1-hour TTL and credits on the 5-minute one', () => {
    expect(billingMode(snap({}), 'firstParty')).toBe('subscription')
    expect(billingMode(snap({}, { ttl: '5m' }), 'firstParty')).toBe('subscription-credits')
  })

  it('detects API billing without rate limits, and providers from the environment', () => {
    expect(billingMode(snap({ rate_limits: undefined }), 'firstParty')).toBe('api')
    expect(billingMode(null, 'firstParty')).toBe('api')
    expect(billingMode(snap({}), 'vertex')).toBe('provider')
    expect(billingMode(snap({}), 'foundry')).toBe('provider')
    expect(billingMode(snap({}), 'bedrock')).toBe('provider')
  })

  it('shows a subscription tokens and plan share, and no dollars outside verbose output (AC 3.2)', () => {
    expect(presentCost('subscription', false)).toEqual({ tokens: true, dollars: false, dollarLabel: 'cost.api_equivalent', planShare: true })
    expect(presentCost('subscription', true).dollars).toBe(true)
  })

  it('labels every dollar figure', () => {
    expect(presentCost('subscription-credits', false)).toMatchObject({ dollars: true, dollarLabel: 'cost.api_equivalent', planShare: true })
    expect(presentCost('api', false)).toMatchObject({ dollars: true, dollarLabel: 'cost.api_equivalent', planShare: false })
    expect(presentCost('provider', false)).toMatchObject({ dollars: true, dollarLabel: 'cost.provider_priced' })
  })
})

describe('Claude Code’s estimate first (AC 3.3)', () => {
  it('shows a PreModelSwitch estimate in place of the own figure', () => {
    expect(preferClaudeCodeEstimate(6.4998, 0.9954)).toEqual({ usd: 0.9954, source: 'claude-code' })
  })

  it('falls back to the own figure, or nothing', () => {
    expect(preferClaudeCodeEstimate(6.5, undefined)).toEqual({ usd: 6.5, source: 'shield' })
    expect(preferClaudeCodeEstimate(6.5, Number.NaN)).toEqual({ usd: 6.5, source: 'shield' })
    expect(preferClaudeCodeEstimate(null, undefined)).toBeNull()
  })
})
