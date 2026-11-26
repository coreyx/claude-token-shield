/**
 * The notification policy (design D13, REQ-9): at most one toast per state
 * transition, at most one non-critical toast per 5 minutes, levels the user
 * can mute.
 */

import type { Assessment, CacheState } from '../assess/types';
import type { Config, Level } from '../config/config';

/** The quiet period between non-critical toasts (REQ-9.0.2). */
export const DEBOUNCE_MS = 5 * 60_000;

/** One toast to show. */
export interface Notification {
  readonly level: Level;
  /** Catalog key of the message. */
  readonly key: string;
  readonly params: Readonly<Record<string, string | number>>;
  /** What triggered it, e.g. `HOT->EXPIRING`, `ttl:1h->5m` or `gate_held`. */
  readonly trigger: string;
}

/** What the policy remembers between calls. */
export interface NotifyLog {
  /** When the last non-critical toast was shown, epoch ms. */
  readonly lastAt: number | null;
}

/** An empty log. */
export const EMPTY_LOG: NotifyLog = { lastAt: null };

/** Levels and messages for the transitions REQ-9.0.1 names. */
const ON_ENTER: Partial<Record<CacheState, { level: Level; key: string }>> = {
  EXPIRING: { level: 'warning', key: 'notify.expiring' },
  UNCERTAIN: { level: 'warning', key: 'notify.uncertain' },
  INVALIDATED: { level: 'warning', key: 'notify.invalidated' },
  COLD: { level: 'info', key: 'notify.cold' },
};

/**
 * The toast for a change between two assessments, if any.
 *
 * @param prev the previous assessment, or `null` at session start
 * @param next the new assessment
 * @param log when the last non-critical toast was shown
 * @param cfg muted levels
 * @param now epoch ms
 */
export function notify(prev: Assessment | null, next: Assessment, log: NotifyLog, cfg: Config, now: number): Notification | null {
  const prevTtl = prev !== null && prev.ttl.tier !== 'absent' ? prev.ttl.value : undefined;
  const nextTtl = next.ttl.tier !== 'absent' ? next.ttl.value : undefined;
  let candidate: Notification | null = null;
  if (prevTtl !== undefined && nextTtl !== undefined && prevTtl !== nextTtl) {
    candidate = { level: 'warning', key: 'notify.ttl_bucket_change', params: { from: prevTtl, to: nextTtl }, trigger: `ttl:${prevTtl}->${nextTtl}` };
  } else if (prev?.state !== next.state) {
    const enter = ON_ENTER[next.state];
    if (enter !== undefined) {
      const params: Record<string, string | number> = { state: next.state };
      if (next.expiresAt.tier !== 'absent') params.expiresAt = next.expiresAt.value;
      if (next.cause !== undefined) params.cause = next.cause.kind;
      candidate = { ...enter, params, trigger: `${prev?.state ?? 'START'}->${next.state}` };
    }
  }
  return admit(candidate, log, cfg, now);
}

/**
 * A critical toast for an event outside the state machine: a held prompt or
 * calibration drift (D13). Critical toasts skip the debounce but still respect
 * a muted critical level.
 */
export function notifyCritical(kind: 'gate_held' | 'calibration_drift', params: Readonly<Record<string, string | number>>, cfg: Config): Notification | null {
  return admit({ level: 'critical', key: `notify.${kind}`, params, trigger: kind }, EMPTY_LOG, cfg, 0);
}

/** Applies muting and the debounce to a candidate toast. */
function admit(n: Notification | null, log: NotifyLog, cfg: Config, now: number): Notification | null {
  if (n === null || cfg.mutedLevels.includes(n.level)) return null;
  if (n.level !== 'critical' && log.lastAt !== null && now - log.lastAt < DEBOUNCE_MS) return null;
  return n;
}

/** Records a shown toast; only non-critical ones start the quiet period. */
export function logNotification(log: NotifyLog, n: Notification, now: number): NotifyLog {
  return n.level === 'critical' ? log : { lastAt: now };
}

/**
 * The next time the state can change without any new event, so the mod can
 * arm one timer and show `EXPIRING` and `COLD` on time in an idle session
 * (REQ-9.0.5): the warn-window start, the start of the boundary band, or its
 * end. `null` when nothing is pending.
 */
export function nextBoundary(a: Assessment, now: number): number | null {
  if (a.expiresAt.tier === 'absent') return null;
  const expiry = a.expiresAt.value;
  const marginMs = a.marginSec * 1000;
  const candidates = [expiry - a.warnWindowSec * 1000, expiry - marginMs, expiry + marginMs];
  const future = candidates.filter(t => t > now);
  return future.length === 0 ? null : Math.min(...future);
}
