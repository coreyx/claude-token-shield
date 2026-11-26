/**
 * The pre-install baseline (REQ-14.0.8, design D17): avoidable spend per week
 * in the sessions before Token Shield, from the numbers backfilled out of
 * Claude Code's transcripts, beside the same figure since.
 */

import type { Prices, ProviderKey } from '../data/types';
import { summarize } from './summarize';
import type { HistorySummary, SessionHistory } from './summarize';

/** The baseline beside the current figure. */
export interface BaselineReport {
  readonly installAt: number;
  /** Weeks of transcripts before the install that the baseline covers. */
  readonly weeks: number;
  readonly beforePerWeekUsd: number;
  readonly currentPerWeekUsd: number;
}

const WEEK_MS = 7 * 86_400_000;

/**
 * When Token Shield started recording: the earliest request the mod itself
 * wrote, or `null` before it has written any.
 *
 * @param sessions the mod's own history
 */
export function installTime(sessions: readonly SessionHistory[]): number | null {
  let first: number | null = null;
  for (const s of sessions) for (const r of s.requests) if (r.source === 'mod' && (first === null || r.tsStart < first)) first = r.tsStart;
  return first;
}

/**
 * The avoidable spend per week before the install, from the backfilled
 * sessions, and per week since, from the current summary. Each period counts
 * as at least a week, so a short one can't inflate the rate. `null` with no
 * backfilled requests before the install.
 *
 * @param backfill the backfilled sessions
 * @param installAt when Token Shield started recording, if it has
 * @param current the summary of the window shown
 * @param prices the price table
 * @param provider who serves the requests
 */
export function baseline(
  backfill: readonly SessionHistory[],
  installAt: number | null,
  current: HistorySummary,
  prices: Prices,
  provider: ProviderKey,
): BaselineReport | null {
  if (installAt === null) return null;
  let earliest: number | null = null;
  for (const s of backfill) for (const r of s.requests) if (r.lane === 'main' && r.tsStart < installAt && (earliest === null || r.tsStart < earliest)) earliest = r.tsStart;
  if (earliest === null) return null;
  const before = summarize(backfill, { from: earliest, to: installAt - 1 }, { misses: false }, prices, provider);
  const weeks = Math.max(1, (installAt - earliest) / WEEK_MS);
  const since = Math.max(1, (current.range.to - Math.max(current.range.from, installAt)) / WEEK_MS);
  return { installAt, weeks, beforePerWeekUsd: before.avoidableUsd / weeks, currentPerWeekUsd: current.avoidableUsd / since };
}
