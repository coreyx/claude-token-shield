/**
 * The guard's decisions before an invalidating action (REQ-10, design D10):
 * whether a model-switch event is the one to show, whether to ask Claude
 * Code to confirm it, and whether an effort, fast-mode or plugin-reload
 * change is worth a toast. Pure; the mod shows what these decide.
 */

import type { CacheState } from '../assess/types';
import type { Config } from '../config/config';
import type { BillingMode } from '../cost/cost';
import { baseModelId } from '../model/ids';

/** Events of one switch arrive within milliseconds; later ones in this window are the same switch. */
export const BURST_MS = 2000;

/** A `classic.PreModelSwitch` event's facts. */
export interface SwitchFacts {
  readonly from: string;
  readonly to: string;
  /** What the person asked for (`sonnet`, a full id), or `null` from the picker. */
  readonly requested: string | null;
  readonly warm: boolean;
  readonly contextTokens: number;
  /** Claude Code's own estimate of the rebuild. */
  readonly estimatedUsd: number;
  readonly at: number;
}

/** Why the guard stays silent for an event. */
export type SilentReason = 'same-model' | 'cold' | 'not-requested' | 'same-burst';

/** The guard's answer to one switch event. */
export type SwitchGuard =
  | { readonly action: 'silent'; readonly why: SilentReason }
  | { readonly action: 'show'; readonly ask: boolean; readonly model: string; readonly tokens: number; readonly usd: number };

/** Model families an alias can name; an alias naming none of them (`default`) can't be matched by name. */
const FAMILIES = ['opus', 'sonnet', 'haiku', 'fable', 'mythos'];

/**
 * Whether an event's target is what the person asked for. Each switch fires
 * a pair of events with different targets (spikes.md §1); only the one the
 * request names is shown. A picker event has no request, and an alias that
 * names no family can't be compared, so those match and the burst window
 * keeps the pair to one warning.
 *
 * @param requested the requested model or alias, or `null`
 * @param to the event's target model id
 */
export function requestMatches(requested: string | null, to: string): boolean {
  if (requested === null || requested.trim() === '') return true;
  const want = baseModelId(requested);
  const target = baseModelId(to);
  if (want === target) return true;
  const family = FAMILIES.find(f => want.includes(f));
  return family === undefined ? true : target.includes(family);
}

/**
 * Decides one model-switch event. Silent for a same-model pick, a cold or
 * invalidated cache (REQ-10.0.5), the pair's other target, or a later event
 * of a burst already shown. Otherwise it shows Claude Code's estimate, and
 * asks Claude Code to confirm only with `switchConfirm` on and a rebuild
 * that reaches the threshold (REQ-10.0.6).
 *
 * @param f the event's facts
 * @param state the cache state before the switch
 * @param mode the billing mode: a subscription is judged on tokens only
 * @param cfg the thresholds and the switchConfirm setting
 * @param lastShownAt when the guard last showed a switch, if ever
 */
export function switchGuard(f: SwitchFacts, state: CacheState, mode: BillingMode, cfg: Config, lastShownAt: number | null): SwitchGuard {
  if (baseModelId(f.from) === baseModelId(f.to)) return { action: 'silent', why: 'same-model' };
  if (!f.warm || state === 'COLD' || state === 'INVALIDATED') return { action: 'silent', why: 'cold' };
  if (!requestMatches(f.requested, f.to)) return { action: 'silent', why: 'not-requested' };
  if (lastShownAt !== null && f.at - lastShownAt >= 0 && f.at - lastShownAt < BURST_MS) return { action: 'silent', why: 'same-burst' };
  const reaches = f.contextTokens >= cfg.thresholdTokens || (mode !== 'subscription' && f.estimatedUsd >= cfg.thresholdUsd);
  return { action: 'show', ask: cfg.switchConfirm === 'on' && reaches, model: f.to, tokens: f.contextTokens, usd: f.estimatedUsd };
}

/** The guard's answer to an effort, fast-mode or reload change. */
export type ChangeGuard = { readonly action: 'silent' } | { readonly action: 'toast'; readonly key: 'guard.effort.toast' | 'guard.fast.toast' | 'guard.reload.toast' };

/** The toast each change kind gets. */
const CHANGE_KEYS = {
  effort_change: 'guard.effort.toast',
  fast_toggle: 'guard.fast.toast',
  reload_plugins: 'guard.reload.toast',
} as const;

/**
 * Decides an effort change, fast toggle or plugin reload while the cache is
 * warm (REQ-10.0.2): a toast when the rules say it `WILL` rebuild the cache,
 * and for a reload, which `MAY`, an info toast. Silent when the cache is
 * already lost, and for a change the rules say has no effect (effort on a
 * per-message-effort model, AC 10.3).
 *
 * @param kind the event kind
 * @param impact the rules' impact for it here
 * @param state the cache state before the change
 */
export function changeGuard(kind: string, impact: 'WILL' | 'MAY' | 'NO_EFFECT', state: CacheState): ChangeGuard {
  const key = CHANGE_KEYS[kind as keyof typeof CHANGE_KEYS];
  if (key === undefined) return { action: 'silent' };
  if (state !== 'HOT' && state !== 'EXPIRING' && state !== 'UNCERTAIN') return { action: 'silent' };
  if (impact === 'WILL' || (impact === 'MAY' && kind === 'reload_plugins')) return { action: 'toast', key };
  return { action: 'silent' };
}
