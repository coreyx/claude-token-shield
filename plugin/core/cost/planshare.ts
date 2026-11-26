/**
 * Plan share: what a cost means as a share of a subscription's 5-hour window
 * (design D5). Claude Code reports the window's used percentage only as a
 * whole-window figure, too coarse to attribute per turn, so the share is
 * learned: per 5-hour window, the percentage gained against the
 * API-equivalent dollars spent, accumulated per model family over 14 days.
 * Every share is `[estimated]`.
 */

import type { Prices } from '../data/types';
import { baseModelId } from '../model/ids';
import { valueOf } from '../model/snapshot';
import type { NativeSnapshot, RateWindow, RequestRecord } from '../model/types';
import type { BillingMode, NextTurnCost } from './cost';
import { requestUsd } from './cost';

/** The part of a snapshot plan share needs; the bridge's `snapshots.jsonl` rows carry it. */
export interface SnapshotRow {
  /** Epoch ms. */
  readonly receivedAt: number;
  readonly fiveHour: RateWindow | null;
}

/** Takes the plan-share fields from a snapshot. */
export function snapshotRow(s: NativeSnapshot): SnapshotRow {
  return { receivedAt: s.receivedAt, fiveHour: valueOf(s.rateLimits.fiveHour) ?? null };
}

/** Model families, which use plan quota at different rates. */
export type ModelFamily = 'fable' | 'mythos' | 'opus' | 'sonnet' | 'haiku' | 'other';

/** The family a model id belongs to. */
export function modelFamily(model: string): ModelFamily {
  const m = /^claude-(fable|mythos|opus|sonnet|haiku)\b/.exec(baseModelId(model));
  return (m?.[1] as ModelFamily | undefined) ?? 'other';
}

/** One family's learned ratio, in percentage points of the window per API-equivalent dollar. */
export interface FamilyRatio {
  readonly ratio: number;
  /** Lowest and highest per-window ratio: the spread behind the interval. */
  readonly low: number;
  readonly high: number;
  /** Windows the ratio rests on. */
  readonly windows: number;
}

/** Learned ratios by family. */
export interface PlanShareModel {
  readonly byFamily: Readonly<Partial<Record<ModelFamily, FamilyRatio>>>;
}

/** How far back windows count (D5). */
export const PLAN_SHARE_DAYS = 14;

/** Windows needed before a share is shown instead of "learning" (D5). */
export const MIN_WINDOWS = 3;

/**
 * Learns the percent-per-dollar ratio from snapshot rows and the requests
 * recorded alongside them.
 *
 * @param rows snapshot rows, any order
 * @param requests requests of every lane (subagents use the plan too)
 * @param prices prices for the API-equivalent dollars
 * @param now epoch ms; windows older than {@link PLAN_SHARE_DAYS} are ignored
 */
export function planShare(rows: readonly SnapshotRow[], requests: readonly RequestRecord[], prices: Prices, now: number): PlanShareModel {
  const since = now - PLAN_SHARE_DAYS * 86_400_000;
  const windows = new Map<number, SnapshotRow[]>();
  for (const row of rows) {
    if (row.fiveHour === null || row.receivedAt < since) continue;
    // A window is identified by when it resets; a reset starts a new group.
    const group = windows.get(row.fiveHour.resetsAt) ?? [];
    group.push(row);
    windows.set(row.fiveHour.resetsAt, group);
  }

  const sums = new Map<ModelFamily, { pct: number; usd: number; ratios: number[] }>();
  for (const group of windows.values()) {
    group.sort((a, b) => a.receivedAt - b.receivedAt);
    const first = group[0]!;
    const last = group[group.length - 1]!;
    const deltaPct = last.fiveHour!.usedPercentage - first.fiveHour!.usedPercentage;
    // One snapshot shows no change, and a fall can only be a glitch inside one window.
    if (group.length < 2 || deltaPct < 0) continue;
    const byFamily = new Map<ModelFamily, number>();
    for (const r of requests) {
      if (r.tsStart < first.receivedAt || r.tsStart > last.receivedAt) continue;
      const usd = requestUsd(r, prices);
      if (usd === null) continue;
      const family = modelFamily(r.model);
      byFamily.set(family, (byFamily.get(family) ?? 0) + usd);
    }
    const usd = [...byFamily.values()].reduce((a, b) => a + b, 0);
    if (usd <= 0) continue;
    // The window counts toward the family that spent most in it.
    const family = [...byFamily.entries()].sort((a, b) => b[1] - a[1])[0]![0];
    const s = sums.get(family) ?? { pct: 0, usd: 0, ratios: [] };
    s.pct += deltaPct;
    s.usd += usd;
    s.ratios.push(deltaPct / usd);
    sums.set(family, s);
  }

  const byFamily: Partial<Record<ModelFamily, FamilyRatio>> = {};
  for (const [family, s] of sums) {
    byFamily[family] = { ratio: s.pct / s.usd, low: Math.min(...s.ratios), high: Math.max(...s.ratios), windows: s.ratios.length };
  }
  return { byFamily };
}

/** A cost as a share of the 5-hour window, or why it isn't shown yet. */
export type PlanShare =
  | { readonly status: 'learning'; readonly windows: number }
  | { readonly status: 'estimated'; readonly pct: number; readonly low: number; readonly high: number };

/**
 * A dollar cost as a share of the 5-hour window, from the model family's
 * learned ratio; "learning" until {@link MIN_WINDOWS} windows back it.
 */
export function shareOf(usd: number, model: string, m: PlanShareModel): PlanShare {
  const f = m.byFamily[modelFamily(model)];
  if (f === undefined || f.windows < MIN_WINDOWS) return { status: 'learning', windows: f?.windows ?? 0 };
  return { status: 'estimated', pct: f.ratio * usd, low: f.low * usd, high: f.high * usd };
}

/** The next turn's cost with its plan share, for subscription sessions. */
export interface CostWithShare extends NextTurnCost {
  /** Present only in subscription modes; always `[estimated]`. */
  readonly planShare?: { readonly warm: PlanShare; readonly cold: PlanShare };
}

/**
 * Adds the plan share to a cost when the session is on a subscription
 * (REQ-3.0.2); other modes and unknown dollars get none.
 */
export function withPlanShare(cost: NextTurnCost, mode: BillingMode, model: string, m: PlanShareModel): CostWithShare {
  if ((mode !== 'subscription' && mode !== 'subscription-credits') || cost.usd === null) return cost;
  return { ...cost, planShare: { warm: shareOf(cost.usd.warm, model, m), cold: shareOf(cost.usd.cold, model, m) } };
}
