/**
 * The advice report (REQ-4.0.x, 14.0.7; design D18): each recommendation
 * judged in hindsight against the lever the person took, over the same
 * horizon the quotes compare levers on.
 */

import type { CacheState } from '../assess/types';
import { requestUsd } from '../cost/cost';
import type { Prices } from '../data/types';
import type { RequestRecord } from '../model/types';
import { classifyProbe } from '../probe/probe';
import { HORIZON_TURNS } from '../recommend/levers';
import { COLD_CANDIDATES } from '../recommend/recommend';
import type { HistoryFilter, Range, SessionHistory } from './summarize';
import type { LeverId } from '../recommend/levers';

/** One lever's quote as stored with the recommendation (AC 4.5). */
export interface StoredQuote {
  readonly lever: LeverId;
  readonly nowUsd: number | null;
  readonly perTurnUsd: number | null;
}

/** A recommendation as shown, with every alternative and its estimated cost. */
export interface RecommendationRecord {
  readonly ts: number;
  readonly state: CacheState;
  readonly lever: LeverId | 'none';
  readonly pHit: number | null;
  /** What reading and what rewriting the whole prefix cost, to re-price `continue` by what happened. */
  readonly readUsd: number | null;
  readonly writeUsd: number | null;
  readonly quotes: readonly StoredQuote[];
}

/** A lever the person took: a command, a setting, a spend, or a plain prompt (`continue`). */
export interface LeverTakenRecord {
  readonly ts: number;
  readonly lever: LeverId;
}

/** A recommendation's action must come this soon after it (D18). */
export const TAKEN_WINDOW_MS = 10 * 60_000;

/** A recommendation is cheapest when within this factor of the cheapest alternative (D18). */
export const CHEAPEST_TOLERANCE = 1.05;

/** The share of recommendations that were cheapest in hindsight. */
export interface AdviceReport {
  readonly evaluated: number;
  readonly cheapest: number;
  readonly share: number | null;
  /** Recommendations no action followed, left out. */
  readonly unevaluated: number;
}

/** Lanes whose requests count toward a path's realized cost. */
const COST_LANES = new Set(['main', 'compact', 'probe', 'keepalive']);

/**
 * Judges every recommendation in hindsight (D18). The taken lever is the
 * first action within 10 minutes of the recommendation and before the next
 * main request; a plain prompt counts as `continue`, and a `none`
 * recommendation is judged as `continue`. Each lever's hindsight cost covers
 * the requests the taken path actually made, up to the quote horizon: the
 * taken lever's is measured; `continue`'s, when not taken, is re-priced by
 * whether the next request read the cache; the rest keep their quotes. The
 * recommendation is cheapest when its hindsight cost is within 5% of the
 * cheapest alternative's, among the levers the recommender itself weighs
 * (continue, compact, rewind): /clear always prices lowest because it gives
 * up the conversation, so it is no like-for-like alternative.
 *
 * @param recs the recommendations shown
 * @param taken the levers the person took
 * @param requests every recorded request
 * @param prices the price table
 */
export function evaluateAdvice(
  recs: readonly RecommendationRecord[],
  taken: readonly LeverTakenRecord[],
  requests: readonly RequestRecord[],
  prices: Prices,
): AdviceReport {
  const main = requests.filter(r => r.lane === 'main').slice().sort((a, b) => a.tsStart - b.tsStart);
  const actions = taken.slice().sort((a, b) => a.ts - b.ts);
  const ordered = recs.slice().sort((a, b) => a.ts - b.ts);
  let evaluated = 0;
  let cheapest = 0;
  let unevaluated = 0;

  for (let i = 0; i < ordered.length; i++) {
    const rec = ordered[i]!;
    // A recommendation replaced by a newer one before anything was done is not judged.
    const nextRec = ordered[i + 1]?.ts ?? Infinity;
    const nextMain = main.find(r => r.tsStart > rec.ts)?.tsStart ?? Infinity;
    const end = Math.min(rec.ts + TAKEN_WINDOW_MS, nextMain, nextRec);
    const action = actions.find(a => a.ts > rec.ts && a.ts <= end);
    if (action === undefined) {
      unevaluated += 1;
      continue;
    }

    // The path: up to the horizon's worth of main requests after the action,
    // ending where the person's next action starts a path of its own.
    const nextAction = actions.find(a => a.ts > action.ts)?.ts ?? Infinity;
    const after = main.filter(r => r.tsStart >= action.ts && r.tsStart < nextAction).slice(0, HORIZON_TURNS + 1);
    if (after.length === 0) {
      unevaluated += 1;
      continue;
    }
    const k = after.length;
    const last = after[k - 1]!.tsStart;
    let realized: number | null = 0;
    for (const r of requests) {
      if (!COST_LANES.has(r.lane) || r.tsStart < action.ts || r.tsStart > last) continue;
      const usd = requestUsd(r, prices);
      if (usd === null) {
        realized = null;
        break;
      }
      realized += usd;
    }

    const first = after[0]!;
    const prefixBefore = main.filter(r => r.tsStart < first.tsStart).at(-1);
    const read = prefixBefore !== undefined ? classifyProbe(first.usage.read, windowTokens(prefixBefore)) !== 'MISS' : null;
    const hindsight = new Map<LeverId, number>();
    for (const q of rec.quotes) {
      if (q.lever === action.lever) continue;
      if (q.nowUsd === null) continue;
      const nowUsd = q.lever === 'continue' && read !== null && rec.readUsd !== null && rec.writeUsd !== null ? (read ? rec.readUsd : rec.writeUsd) : q.nowUsd;
      hindsight.set(q.lever, nowUsd + (k - 1) * (q.perTurnUsd ?? 0));
    }
    if (realized !== null) hindsight.set(action.lever, realized);

    const recommended: LeverId = rec.lever === 'none' ? 'continue' : rec.lever;
    const mine = hindsight.get(recommended);
    const others = [...hindsight].filter(([lever]) => lever !== recommended && COLD_CANDIDATES.includes(lever)).map(([, usd]) => usd);
    if (mine === undefined || others.length === 0) {
      unevaluated += 1;
      continue;
    }
    evaluated += 1;
    if (mine <= CHEAPEST_TOLERANCE * Math.min(...others)) cheapest += 1;
  }
  return { evaluated, cheapest, share: evaluated > 0 ? cheapest / evaluated : null, unevaluated };
}

/** Every token a request put in the prefix the next one re-sends. */
function windowTokens(r: RequestRecord): number {
  const u = r.usage;
  return u.input + u.read + u.write5m + u.write1h + u.output;
}

/**
 * The advice report over the same sessions and window as a history summary:
 * each session judged on its own records, the counts summed.
 *
 * @param sessions each session's records
 * @param range the window; recommendations outside it are left out
 * @param filter one session or all
 * @param prices the price table
 */
export function adviceReport(sessions: readonly SessionHistory[], range: Range, filter: HistoryFilter, prices: Prices): AdviceReport {
  let evaluated = 0;
  let cheapest = 0;
  let unevaluated = 0;
  for (const s of sessions) {
    if (filter.session !== undefined && s.sessionId !== filter.session) continue;
    const recs = (s.recommendations ?? []).filter(r => r.ts >= range.from && r.ts <= range.to);
    if (recs.length === 0) continue;
    const r = evaluateAdvice(recs, s.levers ?? [], s.requests, prices);
    evaluated += r.evaluated;
    cheapest += r.cheapest;
    unevaluated += r.unevaluated;
  }
  return { evaluated, cheapest, share: evaluated > 0 ? cheapest / evaluated : null, unevaluated };
}
