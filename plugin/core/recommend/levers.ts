/**
 * The lever catalog (design D6, REQ-4.0.1/4.0.2): every move available at a
 * decision point, priced for the next request and for the turns after it.
 *
 * Costs are API-equivalent dollars, the one unit every billing mode can be
 * compared in; tokens travel alongside for display. A cost that can't be
 * priced is `null` and the lever is still listed (REQ-4.0.6).
 */

import type { Assessment } from '../assess/types';
import { nextTurnCost, outputUsd } from '../cost/cost';
import type { Prices, ProviderKey } from '../data/types';
import { valueOf } from '../model/snapshot';
import type { SessionState, Tier, Ttl } from '../model/types';

/** Every lever Token Shield knows. */
export type LeverId = 'continue' | 'compact' | 'clear' | 'rewind' | 'recap' | 'btw' | 'keepalive' | 'probe' | 'ttl' | 'model';

/** How a lever acts: a slash command, a setting, a paid request, or a choice the user makes. */
export type LeverKind = 'command' | 'setting' | 'spend' | 'choice';

/** A cost in dollars and tokens; either may be unknown. */
export interface LeverCost {
  readonly usd: number | null;
  readonly tokens: number | null;
}

/** One lever, priced for the current state. */
export interface LeverQuote {
  readonly lever: LeverId;
  readonly kind: LeverKind;
  /** What the next request costs if this lever is pulled now. */
  readonly now: LeverCost;
  /** What each later turn costs after it (its effect on the prefix); `null` when it has none. */
  readonly perTurnAfter: LeverCost | null;
  /** `now` plus {@link HORIZON_TURNS} later turns, the figure levers are compared on; `null` if unknown. */
  readonly horizonUsd: number | null;
  /** Catalog key describing the effect on later turns. */
  readonly effectKey: string;
  /** Catalog key for "when to use it". */
  readonly whenKey: string;
  readonly tier: Tier;
}

/** What quoting needs besides the assessment and the session. */
export interface LeverContext {
  /** Prices with any user override merged in. */
  readonly prices: Prices;
  readonly model: string;
  readonly provider: ProviderKey;
  readonly fast?: boolean;
  /** Epoch ms. */
  readonly now: number;
  /** Learned summary size as a fraction of the prefix; defaults to {@link DEFAULT_SUMMARY_FRACTION}. */
  readonly summaryFraction?: number;
  /** Tokens in the system layer (system prompt, tools, project context), when known. */
  readonly systemTokens?: number;
}

/** Turns after the current one that a lever's effect is counted over (D6). */
export const HORIZON_TURNS = 5;

/** A compaction summary's size relative to the prefix until history teaches it (D6). */
export const DEFAULT_SUMMARY_FRACTION = 0.08;

/** Summarization and helper requests run on the 5-minute TTL (analysis §1.2). */
const HELPER_TTL: Ttl = '5m';

/**
 * Quotes every lever applicable to the assessment. `UNKNOWN` has none: with
 * no picture of the cache, no price would mean anything.
 *
 * @param a the assessment
 * @param s the session, for the request log and the system-layer size
 * @param ctx prices, model and time
 */
export function quoteLevers(a: Assessment, s: SessionState, ctx: LeverContext): LeverQuote[] {
  if (a.state === 'UNKNOWN') return [];
  const prefix = valueOf(a.prefixTokens);
  const ttl = valueOf(a.ttl) ?? '5m';
  // Only UNKNOWN lacks a probability, and it returned above.
  const p = a.pHit!;

  /** Read (warm) and write (cold) prices of a prefix of `tokens` on the main TTL. */
  const price = (tokens: number, t: Ttl = ttl): { read: number; write: number } | null => {
    const c = nextTurnCost({ prefixTokens: tokens, model: ctx.model, ttl: t, provider: ctx.provider, fast: ctx.fast, at: ctx.now }, ctx.prices);
    return c.usd === null ? null : { read: c.usd.warm, write: c.usd.cold };
  };
  /** Later turns on a prefix of `tokens`, assumed to read the cache. */
  const after = (tokens: number | null): LeverCost | null => {
    if (tokens === null) return { usd: null, tokens: null };
    const pr = price(tokens);
    return { usd: pr === null ? null : pr.read, tokens };
  };
  const horizon = (now: LeverCost, later: LeverCost | null): number | null =>
    now.usd === null || (later !== null && later.usd === null) ? null : now.usd + HORIZON_TURNS * (later?.usd ?? 0);
  const quote = (lever: LeverId, kind: LeverKind, now: LeverCost, later: LeverCost | null, tier: Tier, effect: string): LeverQuote => ({
    lever,
    kind,
    now,
    perTurnAfter: later,
    horizonUsd: horizon(now, later),
    effectKey: `effect.${effect}`,
    whenKey: `lever.${lever}.when`,
    tier,
  });

  const quotes: LeverQuote[] = [];
  const full = prefix !== undefined ? price(prefix) : null;
  const expected = full === null ? null : p * full.read + (1 - p) * full.write;

  // continue: the expected cost given the chance of reading the cache.
  quotes.push(quote('continue', 'choice', { usd: expected, tokens: prefix ?? null }, after(prefix ?? null), 'estimated', 'unchanged'));

  // /compact: summarize (reading or rewriting the prefix on the helper TTL, plus the summary as output),
  // then the first request writes system + summary.
  const system = ctx.systemTokens ?? systemLayer(s);
  const summary = prefix !== undefined ? Math.round(prefix * (ctx.summaryFraction ?? DEFAULT_SUMMARY_FRACTION)) : undefined;
  const compactPrefix = summary !== undefined && system !== undefined ? system + summary : null;
  let compactNow: number | null = null;
  if (prefix !== undefined && summary !== undefined && compactPrefix !== null) {
    const helper = price(prefix, HELPER_TTL);
    const rebuilt = price(compactPrefix);
    const out = outputUsd(summary, ctx.model, ctx.provider, ctx.now, ctx.prices);
    if (helper !== null && rebuilt !== null && out !== null) {
      compactNow = p * helper.read + (1 - p) * helper.write + out + rebuilt.write;
    }
  }
  quotes.push(quote('compact', 'command', { usd: compactNow, tokens: compactPrefix }, after(compactPrefix), 'estimated', 'compact'));

  // /clear: only the system layer is written again; the conversation is gone.
  const clearPrice = system !== undefined ? price(system) : null;
  quotes.push(quote('clear', 'command', { usd: clearPrice?.write ?? null, tokens: system ?? null }, after(system ?? null), 'estimated', 'clear'));

  // /rewind: back to an earlier point, cheap only while that point's entry is still within its TTL.
  const rewind = rewindTarget(s, ctx.now);
  if (rewind !== null) {
    const pr = rewind.warm ? price(rewind.tokens) : null;
    quotes.push(quote('rewind', 'command', { usd: pr?.read ?? null, tokens: rewind.tokens }, after(rewind.tokens), 'inferred', 'rewind'));
  }

  // /recap: no request on the main prefix's cache, no change to it.
  quotes.push(quote('recap', 'command', { usd: 0, tokens: 0 }, null, 'inferred', 'none'));

  // /btw: a side question reading the prefix; unknown when cold, since it then pays an unknown rebuild.
  const warmish = a.state === 'HOT' || a.state === 'EXPIRING';
  quotes.push(quote('btw', 'command', { usd: warmish && full !== null ? full.read : null, tokens: prefix ?? null }, null, 'estimated', 'none'));

  if (a.state === 'HOT' || a.state === 'EXPIRING' || a.state === 'UNCERTAIN') {
    // keep-alive: one read of the prefix per refresh; a refresh every TTL, slightly early.
    quotes.push(quote('keepalive', 'spend', { usd: full?.read ?? null, tokens: prefix ?? null }, null, 'estimated', 'keepalive'));
    // probe: what the next request would pay anyway, either way, and it refreshes the expiry.
    quotes.push(quote('probe', 'spend', { usd: expected, tokens: prefix ?? null }, null, 'estimated', 'probe'));
  }

  // TTL settings cost nothing now; their effect comes from the TTL advisor.
  quotes.push(quote('ttl', 'setting', { usd: 0, tokens: 0 }, null, 'estimated', 'ttl'));

  // A model, effort or fast-mode change rebuilds the prefix on the target: free relative to continuing once cold.
  quotes.push(quote('model', 'choice', { usd: full?.write ?? null, tokens: prefix ?? null }, null, 'estimated', 'rebuild'));

  return quotes;
}

/**
 * The system layer's size: what the session's first main request wrote, which
 * is the system prompt, tools and project context plus the first message.
 */
function systemLayer(s: SessionState): number | undefined {
  const first = s.requests[0];
  if (first === undefined) return undefined;
  const written = first.usage.write5m + first.usage.write1h;
  return written > 0 ? written : undefined;
}

/** The newest earlier main request: its prefix size and whether its entry is still within the TTL. */
function rewindTarget(s: SessionState, now: number): { tokens: number; warm: boolean } | null {
  if (s.requests.length < 2) return null;
  const earlier = s.requests[s.requests.length - 2]!;
  const u = earlier.usage;
  const ttlMs = (earlier.ttl === '1h' ? 3600 : 300) * 1000;
  return { tokens: u.input + u.read + u.write5m + u.write1h, warm: earlier.tsStart + ttlMs > now };
}

