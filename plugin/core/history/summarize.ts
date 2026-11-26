/**
 * History summaries (REQ-14.0.2, 14.0.3; design D16): each main-conversation
 * request's outcome against the one before it, re-cache spend by cause, and
 * the share of it that was avoidable. Computed when read, from the records
 * the mod wrote, the same way in the mod and in `tshield`.
 */

import { nextTurnCost } from '../cost/cost';
import type { Prices, ProviderKey } from '../data/types';
import type { EventRecord, RequestRecord, Ttl } from '../model/types';
import { classifyProbe } from '../probe/probe';
import type { ProbeOutcome } from '../probe/probe';

/** One session's history as read from its chunks. */
export interface SessionHistory {
  readonly sessionId: string;
  readonly requests: readonly RequestRecord[];
  readonly events: readonly EventRecord[];
  /** Chunks that couldn't be read or are from a newer format. */
  readonly skipped: number;
}

/** What a re-cache is put down to (REQ-14.0.2). */
export type Cause = 'ttl_expiry' | 'switch' | 'tools' | 'compaction' | 'server_side' | 'unexplained';

/** The causes in the order the summary lists them. */
export const CAUSES: readonly Cause[] = ['ttl_expiry', 'switch', 'tools', 'compaction', 'server_side', 'unexplained'];

/** The time window, epoch ms, inclusive. */
export interface Range {
  readonly from: number;
  readonly to: number;
}

/** Which rows to list: one session's or all, and only re-caches. */
export interface HistoryFilter {
  readonly session?: string;
  readonly misses: boolean;
}

/** One main request after the first of its session. */
export interface HistoryRow {
  readonly session: string;
  readonly ts: number;
  readonly model: string;
  readonly ttl: Ttl | null;
  readonly outcome: ProbeOutcome;
  readonly cause: Cause | null;
  /** The part of the prefix written again, tokens. */
  readonly recacheTokens: number;
  /** What writing it cost above reading it, dollars; `null` when unpriced. */
  readonly recacheUsd: number | null;
  readonly avoidable: boolean;
  /** Seconds since the previous main request. */
  readonly gapSec: number;
}

/** Spend and count for one cause. */
export interface CauseTotal {
  readonly count: number;
  readonly tokens: number;
  readonly usd: number;
}

/** A summary over a window. */
export interface HistorySummary {
  readonly range: Range;
  readonly sessions: number;
  readonly requests: number;
  readonly recaches: number;
  readonly recacheTokens: number;
  readonly recacheUsd: number;
  /** Re-caches with no price, left out of the dollar totals. */
  readonly unpriced: number;
  readonly byCause: Readonly<Record<Cause, CauseTotal>>;
  readonly avoidableCount: number;
  readonly avoidableUsd: number;
  readonly rows: readonly HistoryRow[];
  readonly skippedChunks: number;
}

/** The cache's lifetime in seconds. */
const TTL_SEC: Readonly<Record<Ttl, number>> = { '5m': 300, '1h': 3600 };

/** Events the person causes that rebuild the cache, by the cause they count as. */
const ACTION_CAUSES: Readonly<Record<string, Cause>> = {
  model_switch: 'switch',
  effort_change: 'switch',
  fast_toggle: 'switch',
  mcp_plugin_toggle: 'tools',
  reload_plugins: 'tools',
  image_batch_removal: 'tools',
  compaction: 'compaction',
};

/** Claude Code's own diagnosis of a miss, by the cause it counts as. */
const NATIVE_CAUSES: Readonly<Record<string, Cause>> = {
  ttl_expired_5m: 'ttl_expiry',
  ttl_expired_1h: 'ttl_expiry',
  model_changed: 'switch',
  tools_changed: 'tools',
  system_prompt_changed: 'tools',
  likely_server_side: 'server_side',
};

/**
 * Claude Code stamps a diagnosed miss with the time of the request that
 * missed, so a diagnosis belongs to a request from its start (less a second
 * of clock skew) to a minute after it ends.
 */
const NATIVE_BEFORE_MS = 1_000;
const NATIVE_AFTER_MS = 60_000;

/** Every token a request put in the prefix the next one re-sends. */
function windowTokens(r: RequestRecord): number {
  const u = r.usage;
  return u.input + u.read + u.write5m + u.write1h + u.output;
}

/**
 * Puts one re-cache down to a cause: an action the person took since the
 * previous request first, then Claude Code's own diagnosis, then the gap
 * against the TTL, else unexplained.
 */
function attribute(events: readonly EventRecord[], prev: RequestRecord, r: RequestRecord, ttl: Ttl | null): { cause: Cause; actionAt: number | null } {
  const action = events.find(e => e.ts > prev.tsStart && e.ts <= r.tsStart && ACTION_CAUSES[e.kind] !== undefined);
  if (action !== undefined) return { cause: ACTION_CAUSES[action.kind]!, actionAt: action.ts };
  const end = r.tsStart + (r.durationMs ?? 0) + NATIVE_AFTER_MS;
  const native = events.find(e => e.ts >= r.tsStart - NATIVE_BEFORE_MS && e.ts <= end && e.kind === 'native_miss' && e.detail?.to !== undefined && NATIVE_CAUSES[e.detail.to] !== undefined);
  if (native !== undefined) return { cause: NATIVE_CAUSES[native.detail!.to!]!, actionAt: null };
  if (ttl !== null && (r.tsStart - prev.tsStart) / 1000 > TTL_SEC[ttl]) return { cause: 'ttl_expiry', actionAt: null };
  return { cause: 'unexplained', actionAt: null };
}

/**
 * Summarizes the history in a window (REQ-14.0.2, 14.0.3, AC 6.5). Each main
 * request after a session's first is compared with the one before it: what
 * it read from cache against the prefix that request left. A miss or partial
 * hit is a re-cache, priced at the premium of writing the missing tokens over
 * reading them, and put down to a cause. A re-cache is avoidable when the
 * cache expired and the person was back within twice the TTL (a keep-alive or
 * probe could have kept it), or when an action that rebuilds the cache was
 * taken while it was still warm.
 *
 * @param sessions each session's records
 * @param range the window
 * @param filter one session or all, and whether to list only re-caches
 * @param prices the price table
 * @param provider who serves the requests
 */
export function summarize(sessions: readonly SessionHistory[], range: Range, filter: HistoryFilter, prices: Prices, provider: ProviderKey): HistorySummary {
  const byCause = Object.fromEntries(CAUSES.map(c => [c, { count: 0, tokens: 0, usd: 0 }])) as Record<Cause, { count: number; tokens: number; usd: number }>;
  const rows: HistoryRow[] = [];
  let requests = 0;
  let recaches = 0;
  let recacheTokens = 0;
  let recacheUsd = 0;
  let unpriced = 0;
  let avoidableCount = 0;
  let avoidableUsd = 0;
  let skippedChunks = 0;
  const seen = new Set<string>();

  for (const s of sessions) {
    if (filter.session !== undefined && s.sessionId !== filter.session) continue;
    skippedChunks += s.skipped;
    const main = s.requests.filter(r => r.lane === 'main').slice().sort((a, b) => a.tsStart - b.tsStart);
    const events = s.events.slice().sort((a, b) => a.ts - b.ts);
    for (let i = 0; i < main.length; i++) {
      const r = main[i]!;
      if (r.tsStart < range.from || r.tsStart > range.to) continue;
      requests += 1;
      seen.add(s.sessionId);
      if (i === 0) continue;
      const prev = main[i - 1]!;
      const ttl = prev.ttl ?? r.ttl ?? null;
      const prefix = windowTokens(prev);
      const outcome = classifyProbe(r.usage.read, prefix);
      const gapSec = (r.tsStart - prev.tsStart) / 1000;
      if (outcome === 'HIT') {
        if (!filter.misses) rows.push({ session: s.sessionId, ts: r.tsStart, model: r.model, ttl, outcome, cause: null, recacheTokens: 0, recacheUsd: 0, avoidable: false, gapSec });
        continue;
      }
      const missing = Math.max(0, prefix - r.usage.read);
      const priced = nextTurnCost({ prefixTokens: missing, model: r.model, ttl: ttl ?? '5m', provider, at: r.tsStart }, prices);
      const usd = priced.usd !== null ? priced.usd.cold - priced.usd.warm : null;
      const { cause, actionAt } = attribute(events, prev, r, ttl);
      const ttlSec = ttl !== null ? TTL_SEC[ttl] : null;
      const avoidable =
        ttlSec !== null &&
        ((cause === 'ttl_expiry' && gapSec <= 2 * ttlSec) || (actionAt !== null && (actionAt - prev.tsStart) / 1000 < ttlSec));

      recaches += 1;
      recacheTokens += missing;
      const total = byCause[cause];
      total.count += 1;
      total.tokens += missing;
      if (usd === null) unpriced += 1;
      else {
        recacheUsd += usd;
        total.usd += usd;
      }
      if (avoidable) {
        avoidableCount += 1;
        avoidableUsd += usd ?? 0;
      }
      rows.push({ session: s.sessionId, ts: r.tsStart, model: r.model, ttl, outcome, cause, recacheTokens: missing, recacheUsd: usd, avoidable, gapSec });
    }
  }
  rows.sort((a, b) => a.ts - b.ts);
  return { range, sessions: seen.size, requests, recaches, recacheTokens, recacheUsd, unpriced, byCause, avoidableCount, avoidableUsd, rows, skippedChunks };
}

/**
 * Reads `--since <n>d|<n>h` into a window ending now; 30 days without one.
 *
 * @param since the argument, if given
 * @param now epoch ms
 * @returns the window, or `null` when the argument doesn't parse
 */
export function sinceRange(since: string | undefined, now: number): Range | null {
  if (since === undefined) return { from: now - 30 * 86_400_000, to: now };
  const m = /^(\d+)([dh])$/.exec(since);
  if (m === null || Number(m[1]) <= 0) return null;
  return { from: now - Number(m[1]) * (m[2] === 'd' ? 86_400_000 : 3_600_000), to: now };
}
