/**
 * The check view model (design.md "Interfaces"): one plain-data object that
 * `/cache-check`, the panes and `tshield check --json` all show, so every
 * surface carries the same content (REQ-19.0.1). Its JSON form is published as
 * `schemas/check.schema.json`.
 *
 * Building the view does no formatting: numbers stay numbers and times stay
 * epoch ms. The renderers turn it into text from the string catalog alone.
 */

import type { Assessment, CacheState, Confidence } from '../assess/types';
import type { BillingMode, NextTurnCost } from '../cost/cost';
import { presentCost } from '../cost/cost';
import type { PlanShare } from '../cost/planshare';
import type { Impact } from '../data/types';
import { valueOf } from '../model/snapshot';
import type { RequestRecord, SessionState, Tier } from '../model/types';
import type { LeverId, LeverQuote } from '../recommend/levers';
import type { Recommendation } from '../recommend/recommend';

/** Which `/cache-check` view. */
export type CheckMode = 'default' | 'verbose' | 'diff';

/** A value with its tier; `value` is `null` when absent. */
export interface ViewValue<T> {
  readonly value: T | null;
  readonly tier: Tier | 'absent';
}

/** How a past main-conversation request used the cache. */
export type Outcome = 'COLD_START' | 'HIT' | 'PARTIAL' | 'MISS';

/** One request in the verbose timeline. */
export interface TimelineRow {
  readonly tsStart: number;
  /** Seconds since the previous request; `null` for the first. */
  readonly gapSec: number | null;
  readonly read: number;
  readonly write: number;
  readonly input: number;
  readonly outcome: Outcome;
}

/** One difference between the last two requests, or one pending change. */
export interface DiffChange {
  readonly field: 'model' | 'effort' | 'speed' | 'ttl' | 'event';
  readonly from: string | null;
  readonly to: string | null;
}

/** The check, as data. */
export interface CheckView {
  readonly v: 1;
  readonly mode: CheckMode;
  readonly at: number;
  readonly state: CacheState;
  readonly pHit: number | null;
  readonly interval: readonly [number, number] | null;
  readonly confidence: Confidence;
  readonly lowEvidence: boolean;
  readonly stale: boolean;
  readonly unknownReason: string | null;
  readonly ttl: ViewValue<string>;
  readonly expiresAt: ViewValue<number>;
  readonly remainingSec: number | null;
  readonly expiry: { readonly native: number | null; readonly shield: number | null; readonly driftSec: number | null };
  readonly prefixTokens: ViewValue<number>;
  readonly lastRequest: { readonly tsStart: number; readonly tier: Tier } | null;
  readonly session: {
    readonly requests: number | null;
    readonly hitRatio: number | null;
    readonly misses: number | null;
    readonly lastMiss: { readonly at: number | null; readonly causes: readonly string[] } | null;
  };
  readonly pending: readonly { readonly kind: string; readonly impact: Impact }[];
  readonly cost: {
    readonly tokens: number;
    readonly warmUsd: number | null;
    readonly coldUsd: number | null;
    /** Whether dollars may be shown in this mode (a subscription shows them only in verbose output). */
    readonly showDollars: boolean;
    readonly dollarLabel: string;
    readonly priceDate: string;
    readonly tailTier: Tier;
    readonly planShare: { readonly warm: PlanShare; readonly cold: PlanShare } | null;
  } | null;
  readonly billing: BillingMode;
  readonly levers: readonly {
    readonly lever: LeverId;
    readonly nowUsd: number | null;
    readonly nowTokens: number | null;
    readonly horizonUsd: number | null;
    readonly effectKey: string;
    readonly whenKey: string;
    readonly tier: Tier;
    readonly recommended: boolean;
  }[];
  readonly recommendation: Recommendation;
  readonly drivers: readonly { readonly key: string; readonly params: Readonly<Record<string, string | number>>; readonly tier: Tier }[];
  /** Verbose only. */
  readonly timeline: readonly TimelineRow[] | null;
  /** Diff only. */
  readonly diff: { readonly changes: readonly DiffChange[]; readonly missCauses: readonly string[] } | null;
}

/** What building the view needs beyond the assessment. */
export interface ViewInput {
  readonly a: Assessment;
  readonly s: SessionState;
  readonly quotes: readonly LeverQuote[];
  readonly rec: Recommendation;
  readonly cost: (NextTurnCost & { readonly planShare?: { readonly warm: PlanShare; readonly cold: PlanShare } }) | null;
  readonly billing: BillingMode;
  readonly mode: CheckMode;
}

/** Requests in the verbose timeline (analysis §9). */
export const TIMELINE_ROWS = 8;

/**
 * Builds the view model.
 *
 * @param input the assessment, session, quotes, recommendation, cost and mode
 */
export function checkView(input: ViewInput): CheckView {
  const { a, s, quotes, rec, cost, billing, mode } = input;
  const pc = s.lastSnapshot?.promptCache ?? null;
  const touch = s.lastTouch;
  const nativeExpiry = pc !== null ? valueOf(pc.expiresAt) ?? null : null;
  const shieldExpiry = touch !== null && touch.ttl !== undefined ? touch.tsStart + (touch.ttl === '1h' ? 3600 : 300) * 1000 : null;
  const lastMiss = pc !== null ? valueOf(pc.lastMissCause) : undefined;
  const presentation = presentCost(billing, mode === 'verbose');
  return {
    v: 1,
    mode,
    at: a.at,
    state: a.state,
    pHit: a.pHit,
    interval: a.interval,
    confidence: a.confidence,
    lowEvidence: a.lowEvidence,
    stale: a.stale,
    unknownReason: a.unknownReason ?? null,
    ttl: view(a.ttl),
    expiresAt: view(a.expiresAt),
    remainingSec: a.remainingSec,
    expiry: { native: nativeExpiry, shield: shieldExpiry, driftSec: a.driftSec },
    prefixTokens: view(a.prefixTokens),
    lastRequest: touch !== null ? { tsStart: touch.tsStart, tier: touch.tsStartTier } : null,
    session: {
      requests: pc !== null ? valueOf(pc.requests) ?? null : null,
      hitRatio: pc !== null ? valueOf(pc.hitRatio) ?? null : null,
      misses: pc !== null ? valueOf(pc.misses) ?? null : null,
      lastMiss: lastMiss !== undefined ? { at: valueOf(pc!.lastMissAt) ?? null, causes: lastMiss.causes } : null,
    },
    pending: a.pending.map(p => ({ kind: p.event.kind, impact: p.impact })),
    cost:
      cost === null
        ? null
        : {
            tokens: cost.prefixTokens,
            warmUsd: cost.usd?.warm ?? null,
            coldUsd: cost.usd?.cold ?? null,
            showDollars: presentation.dollars,
            dollarLabel: presentation.dollarLabel,
            priceDate: cost.priceDate,
            tailTier: cost.tailTier,
            planShare: cost.planShare ?? null,
          },
    billing,
    levers: quotes.map(q => ({
      lever: q.lever,
      nowUsd: q.now.usd,
      nowTokens: q.now.tokens,
      horizonUsd: q.horizonUsd,
      effectKey: q.effectKey,
      whenKey: q.whenKey,
      tier: q.tier,
      recommended: q.lever === rec.lever,
    })),
    recommendation: rec,
    drivers: a.drivers,
    timeline: mode === 'verbose' ? timeline(s.requests) : null,
    diff: mode === 'diff' ? diff(s, a) : null,
  };
}

/** A tiered value as view data. */
function view<T>(t: { readonly tier: Tier | 'absent'; readonly value?: T }): ViewValue<T> {
  return t.tier === 'absent' ? { value: null, tier: 'absent' } : { value: t.value as T, tier: t.tier };
}

/** The last {@link TIMELINE_ROWS} main requests with their gaps and outcomes. */
function timeline(requests: readonly RequestRecord[]): TimelineRow[] {
  const start = Math.max(0, requests.length - TIMELINE_ROWS);
  return requests.slice(start).map((r, i) => {
    const index = start + i;
    const prev = index > 0 ? requests[index - 1]! : null;
    const write = r.usage.write5m + r.usage.write1h;
    return {
      tsStart: r.tsStart,
      gapSec: prev === null ? null : Math.round((r.tsStart - prev.tsStart) / 1000),
      read: r.usage.read,
      write,
      input: r.usage.input,
      outcome: index === 0 ? 'COLD_START' : outcome(r.usage.read, write),
    };
  });
}

/**
 * How a later request used the cache: a read of nearly everything is a hit,
 * no read at all a miss, anything between partial. Writes of new turns are
 * expected, so a hit tolerates up to 5% of the prompt written.
 */
export function outcome(read: number, write: number): Outcome {
  if (read === 0) return 'MISS';
  return write <= 0.05 * (read + write) ? 'HIT' : 'PARTIAL';
}

/** What changed between the last two main requests, plus what is pending for the next. */
function diff(s: SessionState, a: Assessment): { changes: DiffChange[]; missCauses: string[] } {
  const changes: DiffChange[] = [];
  const [prev, last] = s.requests.slice(-2);
  if (prev !== undefined && last !== undefined) {
    const fields: [DiffChange['field'], string | undefined, string | undefined][] = [
      ['model', prev.model, last.model],
      ['effort', prev.effort, last.effort],
      ['speed', prev.speed, last.speed],
      ['ttl', prev.ttl, last.ttl],
    ];
    for (const [field, from, to] of fields) if (from !== to) changes.push({ field, from: from ?? null, to: to ?? null });
  }
  for (const p of a.pending) {
    const d = p.event.detail;
    if (p.event.kind === 'model_switch' && d !== undefined) changes.push({ field: 'model', from: d.from ?? null, to: d.to ?? null });
    else changes.push({ field: 'event', from: null, to: p.event.kind });
  }
  const pc = s.lastSnapshot?.promptCache;
  const causes = pc !== null && pc !== undefined ? valueOf(pc.lastMissCause)?.causes ?? [] : [];
  return { changes, missCauses: [...causes] };
}
