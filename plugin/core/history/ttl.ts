/**
 * The TTL advisor (REQ-16, design D16): what the recorded idle gaps would
 * have cost under the 5-minute and the 1-hour TTL, for the main
 * conversation and for subagents, and which is cheaper once there is enough
 * history to say.
 */

import { nextTurnCost } from '../cost/cost';
import type { Prices, ProviderKey } from '../data/types';
import type { RequestRecord, Ttl } from '../model/types';
import type { Range, SessionHistory } from './summarize';

/** A bucket needs gaps from this many sessions, and this many gaps, before it recommends (D16). */
export const MIN_SESSIONS = 10;
export const MIN_GAPS = 20;

/** Idle gaps by length: within 5 minutes, within the hour, longer. */
export interface GapCounts {
  readonly under5m: number;
  readonly under1h: number;
  readonly over1h: number;
}

/** What one bucket's gaps would have cost under each TTL. */
export interface TtlBucket {
  readonly sessions: number;
  readonly gaps: GapCounts;
  readonly gapCount: number;
  /** Totals, dollars; `null` when a gap couldn't be priced. */
  readonly cost5mUsd: number | null;
  readonly cost1hUsd: number | null;
  /** The cheaper TTL, or `null` with too little history (REQ-16.0.2). */
  readonly recommended: Ttl | null;
  readonly savingsUsd: number | null;
}

/** The advice for the main conversation and for subagents. */
export interface TtlAdvice {
  readonly range: Range;
  readonly main: TtlBucket;
  readonly subagent: TtlBucket;
}

/** Every token a request put in the prefix the next one re-sends. */
function windowTokens(r: RequestRecord): number {
  const u = r.usage;
  return u.input + u.read + u.write5m + u.write1h + u.output;
}

/** One bucket's gaps priced under both TTLs. */
function bucket(lanes: readonly RequestRecord[][], prices: Prices, provider: ProviderKey): TtlBucket {
  let sessions = 0;
  let gapCount = 0;
  const gaps = { under5m: 0, under1h: 0, over1h: 0 };
  let cost5m: number | null = 0;
  let cost1h: number | null = 0;
  for (const requests of lanes) {
    if (requests.length < 2) continue;
    sessions += 1;
    for (let i = 1; i < requests.length; i++) {
      const prev = requests[i - 1]!;
      const r = requests[i]!;
      const gapSec = (r.tsStart - prev.tsStart) / 1000;
      gapCount += 1;
      if (gapSec <= 300) gaps.under5m += 1;
      else if (gapSec <= 3600) gaps.under1h += 1;
      else gaps.over1h += 1;
      const prefix = windowTokens(prev);
      const fresh = r.usage.write5m + r.usage.write1h;
      // Under each TTL: the prefix read if the gap fits it, rewritten if not, plus this turn's new writes at that TTL's rate.
      const price = (ttl: Ttl, fits: boolean): number | null => {
        const p = nextTurnCost({ prefixTokens: prefix, model: r.model, ttl, provider, at: r.tsStart }, prices);
        const w = nextTurnCost({ prefixTokens: fresh, model: r.model, ttl, provider, at: r.tsStart }, prices);
        if (p.usd === null || w.usd === null) return null;
        return (fits ? p.usd.warm : p.usd.cold) + w.usd.cold;
      };
      const c5 = price('5m', gapSec <= 300);
      const c1 = price('1h', gapSec <= 3600);
      cost5m = cost5m === null || c5 === null ? null : cost5m + c5;
      cost1h = cost1h === null || c1 === null ? null : cost1h + c1;
    }
  }
  const enough = sessions >= MIN_SESSIONS && gapCount >= MIN_GAPS && cost5m !== null && cost1h !== null;
  return {
    sessions,
    gaps,
    gapCount,
    cost5mUsd: cost5m,
    cost1hUsd: cost1h,
    recommended: enough ? (cost1h! < cost5m! ? '1h' : '5m') : null,
    savingsUsd: enough ? Math.abs(cost5m! - cost1h!) : null,
  };
}

/**
 * Compares the recorded idle gaps' re-cache costs under the 5-minute and the
 * 1-hour TTL, separately for the main conversation and for subagents
 * (REQ-16.0.1), recommending one only with enough history (REQ-16.0.2).
 *
 * @param sessions each session's records
 * @param range the window; requests outside it are left out
 * @param prices the price table
 * @param provider who serves the requests
 */
export function adviseTtl(sessions: readonly SessionHistory[], range: Range, prices: Prices, provider: ProviderKey): TtlAdvice {
  const lane = (name: 'main' | 'subagent') =>
    sessions.map(s =>
      s.requests
        .filter(r => r.lane === name && r.tsStart >= range.from && r.tsStart <= range.to)
        .slice()
        .sort((a, b) => a.tsStart - b.tsStart),
    );
  return { range, main: bucket(lane('main'), prices, provider), subagent: bucket(lane('subagent'), prices, provider) };
}
