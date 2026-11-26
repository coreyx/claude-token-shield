/**
 * The next-turn cost model and billing modes (design D4; analysis §7).
 *
 * Only the first request of the next turn is priced: what it pays to read the
 * prefix if the cache is warm, or to write it again if cold. Output, tool
 * loops and subagent requests are never part of the headline (REQ-3.0.7);
 * they are unknowable before the turn and would swamp the comparison.
 */

import type { ModelPrice, Prices, ProviderKey } from '../data/types';
import { valueOf } from '../model/snapshot';
import type { NativeSnapshot, RequestRecord, Ttl } from '../model/types';
import { modelPrice, tableAt } from './prices';

/** What to price. */
export interface CostInput {
  /** Tokens the next request re-sends as the cached prefix. */
  readonly prefixTokens: number;
  /**
   * New tokens after the prefix (the last request's uncached and newly written
   * input). Unknown before the turn; when left out it counts as 0 and the warm
   * figure is tagged `estimated`.
   */
  readonly tailTokens?: number;
  readonly model: string;
  readonly ttl: Ttl;
  readonly provider: ProviderKey;
  /** A provider's regional (not global) endpoint, which carries a premium. */
  readonly regional?: boolean;
  /** Fast mode, priced at the model's fast rate. */
  readonly fast?: boolean;
  /** When the request happens, epoch ms; picks the price table in effect. */
  readonly at: number;
}

/** Dollars for one next-turn outcome pair. */
export interface Dollars {
  readonly warm: number;
  readonly cold: number;
  /** What a cold cache costs over a warm one. */
  readonly penalty: number;
}

/** The next turn's first request, priced. */
export interface NextTurnCost {
  readonly prefixTokens: number;
  readonly tailTokens: number;
  /** Whether `tailTokens` was known or assumed 0. */
  readonly tailTier: 'measured' | 'estimated';
  /** `null` when the price table has no entry for the model: costs are unknown, tokens still shown. */
  readonly usd: Dollars | null;
  /** The effective date of the table used, `YYYY-MM-DD`. */
  readonly priceDate: string;
  /** `estimated` when the provider prices independently of the list. */
  readonly providerBasis: 'list' | 'estimated';
}

/** USD per token from a price in USD per million tokens. */
const PER_MTOK = 1e-6;

/**
 * Prices the first request of the next turn warm and cold.
 *
 * @param input the prefix, model, TTL, provider and date
 * @param prices the bundled prices, with any user override merged in
 */
export function nextTurnCost(input: CostInput, prices: Prices): NextTurnCost {
  const table = tableAt(prices, input.at);
  const tail = input.tailTokens ?? 0;
  const provider = table.providers[input.provider];
  const base = {
    prefixTokens: input.prefixTokens,
    tailTokens: tail,
    tailTier: input.tailTokens === undefined ? ('estimated' as const) : ('measured' as const),
    priceDate: table.effective,
    providerBasis: provider?.basis ?? ('estimated' as const),
  };
  const price = modelPrice(table, input.model);
  if (price === undefined) return { ...base, usd: null };

  const inRate = inputRate(price, input.prefixTokens + tail, input.fast === true);
  const providerMult = (provider?.multiplier ?? 1) * (input.regional === true ? (provider?.regional_multiplier ?? 1) : 1);
  const perToken = inRate * PER_MTOK * providerMult;
  const writeMult = input.ttl === '1h' ? price.write_1h_mult : price.write_5m_mult;
  const warm = input.prefixTokens * perToken * price.read_mult + tail * perToken * writeMult;
  const cold = input.prefixTokens * perToken * writeMult;
  return { ...base, usd: { warm, cold, penalty: cold - warm } };
}

/**
 * The base input rate for a prompt of `promptTokens`: the highest tier it
 * exceeds (a tier prices every token of the prompt, not only those above the
 * threshold), or the fast rate in fast mode.
 */
function inputRate(price: ModelPrice, promptTokens: number, fast: boolean): number {
  if (fast && price.fast_input !== undefined) return price.fast_input;
  let rate = price.input;
  for (const tier of [...(price.tiers ?? [])].sort((a, b) => a.above - b.above)) {
    if (promptTokens > tier.above) rate = tier.input;
  }
  return rate;
}

/**
 * The API-equivalent dollars of a request that already happened, output
 * included: what it counted against a plan's usage (D5). Priced at list price
 * from the table in effect on its date.
 *
 * @returns `null` when the table has no price for the request's model
 */
export function requestUsd(request: RequestRecord, prices: Prices): number | null {
  const price = modelPrice(tableAt(prices, request.tsStart), request.model);
  if (price === undefined) return null;
  const u = request.usage;
  const prompt = u.input + u.read + u.write5m + u.write1h;
  const perToken = inputRate(price, prompt, request.speed === 'fast') * PER_MTOK;
  return perToken * (u.input + u.read * price.read_mult + u.write5m * price.write_5m_mult + u.write1h * price.write_1h_mult + u.output * price.output_mult);
}

/**
 * Dollars for `tokens` of model output at the provider's rate, e.g. a
 * compaction summary.
 *
 * @returns `null` when the model isn't priced
 */
export function outputUsd(tokens: number, model: string, provider: ProviderKey, at: number, prices: Prices): number | null {
  const table = tableAt(prices, at);
  const price = modelPrice(table, model);
  if (price === undefined) return null;
  const mult = table.providers[provider]?.multiplier ?? 1;
  return tokens * price.input * price.output_mult * PER_MTOK * mult;
}

/** How the session is billed, which decides the units shown (D4). */
export type BillingMode = 'subscription' | 'subscription-credits' | 'api' | 'provider';

/**
 * Infers the billing mode. Subscription sessions report `rate_limits`; within
 * the plan their main conversation uses the 1-hour TTL, and on usage credits
 * the 5-minute one. Cloud providers are known from the environment.
 *
 * @param snapshot the newest native snapshot, or `null` without the bridge
 * @param provider where requests go
 */
export function billingMode(snapshot: NativeSnapshot | null, provider: ProviderKey): BillingMode {
  if (provider === 'bedrock' || provider === 'vertex' || provider === 'foundry') return 'provider';
  const limits = snapshot?.rateLimits;
  const hasLimits = limits !== undefined && (limits.fiveHour.tier !== 'absent' || limits.sevenDay.tier !== 'absent');
  if (!hasLimits) return 'api';
  const ttl = snapshot?.promptCache ? valueOf(snapshot.promptCache.ttl) : undefined;
  return ttl === '5m' ? 'subscription-credits' : 'subscription';
}

/** How a cost should be shown for a billing mode. */
export interface CostPresentation {
  /** Tokens are always shown. */
  readonly tokens: true;
  /** Whether dollars appear in standard output; subscription shows them only in verbose output. */
  readonly dollars: boolean;
  /** The catalog key that must accompany any dollar figure. */
  readonly dollarLabel: 'cost.api_equivalent' | 'cost.provider_priced';
  /** Whether the 5-hour window share is shown, tagged `[estimated]`. */
  readonly planShare: boolean;
}

/**
 * Decides which units a billing mode shows (REQ-3.0.2, 3.0.3). Every dollar
 * figure carries a label: there is no presentation without one.
 *
 * @param mode the billing mode
 * @param verbose verbose output, where a subscription's dollars appear as API-equivalent
 */
export function presentCost(mode: BillingMode, verbose: boolean): CostPresentation {
  switch (mode) {
    case 'subscription':
      return { tokens: true, dollars: verbose, dollarLabel: 'cost.api_equivalent', planShare: true };
    case 'subscription-credits':
      return { tokens: true, dollars: true, dollarLabel: 'cost.api_equivalent', planShare: true };
    case 'api':
      return { tokens: true, dollars: true, dollarLabel: 'cost.api_equivalent', planShare: false };
    case 'provider':
      return { tokens: true, dollars: true, dollarLabel: 'cost.provider_priced', planShare: false };
  }
}

/** A dollar figure and whose estimate it is. */
export interface SourcedUsd {
  readonly usd: number;
  readonly source: 'claude-code' | 'shield';
}

/**
 * Claude Code's own estimate for an action (a model switch or a resume) when it
 * gave one, else Token Shield's (REQ-3.0.4). Claude Code's estimate already
 * reflects a managed `modelPricing`, which the bundled table can't know.
 *
 * @param own Token Shield's figure, or `null` when unknown
 * @param claudeCode Claude Code's `estimated_cache_write_usd`, when supplied
 * @returns the figure to show, or `null` when neither is known
 */
export function preferClaudeCodeEstimate(own: number | null, claudeCode: number | undefined): SourcedUsd | null {
  if (claudeCode !== undefined && Number.isFinite(claudeCode) && claudeCode >= 0) return { usd: claudeCode, source: 'claude-code' };
  return own === null ? null : { usd: own, source: 'shield' };
}
