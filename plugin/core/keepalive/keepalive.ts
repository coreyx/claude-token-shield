/**
 * The keep-alive's pure half (REQ-15, design D12): reading the command, the
 * refresh schedule, the estimate shown before it starts, and the decision
 * at each refresh. The mod confirms it, schedules it and forks.
 */

import type { Config } from '../config/config';
import type { Ttl } from '../model/types';

/** The cache's lifetime in ms. */
const TTL_MS: Readonly<Record<Ttl, number>> = { '5m': 300_000, '1h': 3_600_000 };

/** How long before the expiry a refresh is sent (D12): enough for the request to land in time. */
export function leadMs(ttl: Ttl): number {
  return ttl === '1h' ? 120_000 : 30_000;
}

/** A refresh may cost a little more than quoted; the budget check allows for it (AC 15.1). */
export const QUOTE_MARGIN = 1.2;

/** A keep-alive the person asked for. */
export interface KeepAliveRequest {
  readonly until: number;
  readonly budgetUsd: number;
}

/**
 * Reads `keepalive [until HH:MM | for <n>m] [max $<n>]`; what's left out
 * comes from the settings. A time of day is the next time the clock reads
 * it, in the session's time zone.
 *
 * @param words the arguments after `keepalive`
 * @param now epoch ms
 * @param tzOffsetMin the session's offset from UTC, minutes
 * @param cfg the default length and budget
 * @returns the request, or `null` when the words don't parse
 */
export function parseKeepAlive(words: readonly string[], now: number, tzOffsetMin: number, cfg: Config): KeepAliveRequest | null {
  let until = now + cfg.keepAliveDefaultMinutes * 60_000;
  let budgetUsd = cfg.keepAliveDefaultBudgetUsd;
  for (let i = 0; i < words.length; i += 2) {
    const value = words[i + 1];
    if (value === undefined) return null;
    if (words[i] === 'until') {
      const m = /^(\d{1,2}):(\d{2})$/.exec(value);
      if (m === null || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
      const offsetMs = tzOffsetMin * 60_000;
      const dayStart = Math.floor((now + offsetMs) / 86_400_000) * 86_400_000 - offsetMs;
      let at = dayStart + (Number(m[1]) * 60 + Number(m[2])) * 60_000;
      if (at <= now) at += 86_400_000;
      until = at;
    } else if (words[i] === 'for') {
      const m = /^(\d+)m$/.exec(value);
      if (m === null || Number(m[1]) <= 0) return null;
      until = now + Number(m[1]) * 60_000;
    } else if (words[i] === 'max') {
      const m = /^\$?(\d+(?:\.\d{1,2})?)$/.exec(value);
      if (m === null || Number(m[1]) <= 0) return null;
      budgetUsd = Number(m[1]);
    } else {
      return null;
    }
  }
  return { until, budgetUsd };
}

/**
 * When the refresh after one sent at `sentAt` is due: one TTL later, less the lead.
 *
 * @param sentAt when the last refresh (or request) was sent, epoch ms
 * @param ttl the cache's TTL
 */
export function nextRefreshAt(sentAt: number, ttl: Ttl): number {
  return sentAt + TTL_MS[ttl] - leadMs(ttl);
}

/**
 * The refreshes a keep-alive would send before its end, given the budget,
 * and their estimated total (REQ-15.0.2): what the confirm band shows.
 *
 * @param expiresAt when the cache expires now, epoch ms
 * @param ttl the cache's TTL
 * @param req the end and budget
 * @param warmUsd one refresh's warm price
 * @param now epoch ms
 */
export function plan(expiresAt: number, ttl: Ttl, req: KeepAliveRequest, warmUsd: number, now: number): { readonly refreshes: number; readonly totalUsd: number; readonly firstAt: number } {
  const firstAt = Math.max(now, expiresAt - leadMs(ttl));
  let refreshes = 0;
  let spent = 0;
  for (let at = firstAt; at < req.until && spent + warmUsd * QUOTE_MARGIN <= req.budgetUsd; at = nextRefreshAt(at, ttl)) {
    refreshes += 1;
    spent += warmUsd;
  }
  return { refreshes, totalUsd: spent, firstAt };
}

/** Why a keep-alive stopped. */
export type StopReason = 'prompt' | 'budget' | 'end' | 'miss' | 'failed' | 'user';

/** A running keep-alive's numbers. */
export interface KeepAliveRun extends KeepAliveRequest {
  readonly spentUsd: number;
  /** Whether the person sent a prompt since it started. */
  readonly promptSince: boolean;
}

/**
 * Decides one scheduled refresh (D12): stop if the person is back, the end
 * has come, or the next refresh at its quoted warm price, allowing 20% over,
 * would pass the budget; otherwise refresh.
 *
 * @param run the keep-alive's state
 * @param now epoch ms
 * @param warmUsd the quoted warm price of one refresh, if known
 */
export function tickDecision(run: KeepAliveRun, now: number, warmUsd: number | null): { readonly action: 'refresh' } | { readonly action: 'stop'; readonly reason: StopReason } {
  if (run.promptSince) return { action: 'stop', reason: 'prompt' };
  if (now >= run.until) return { action: 'stop', reason: 'end' };
  if (warmUsd === null || run.spentUsd + warmUsd * QUOTE_MARGIN > run.budgetUsd) return { action: 'stop', reason: 'budget' };
  return { action: 'refresh' };
}
