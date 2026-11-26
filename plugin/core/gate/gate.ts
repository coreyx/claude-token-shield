/**
 * The submit gate's decision (design D9, REQ-12): pass, warn or hold a prompt
 * from the assessment and the rebuild cost. The mod applies it; this function
 * only decides, so the 20 ms budget is spent here on arithmetic, not I/O.
 *
 * The gate never sees prompt text, only a hash the mod computes and keeps in
 * memory, so an identical resubmission can be recognized.
 */

import type { Assessment } from '../assess/types';
import type { Config } from '../config/config';
import type { BillingMode, NextTurnCost } from '../cost/cost';

/** How long a held prompt can be resent unchanged and go through (REQ-12.0.2). */
export const RELEASE_WINDOW_MS = 60_000;

/** The prompt being held: its hash and when it was held. */
export interface HeldPrompt {
  readonly hash: string;
  readonly at: number;
}

/** What the gate does with a submission. */
export interface GateDecision {
  readonly action: 'pass' | 'warn' | 'hold';
  /** The hold to remember afterwards: set when holding, cleared on release, kept otherwise. */
  readonly held: HeldPrompt | null;
  /** Catalog key for the drop reason or warning; absent when passing silently. */
  readonly reasonKey?: 'gate.hold' | 'gate.warn';
  readonly params?: Readonly<Record<string, string | number>>;
}

/**
 * Decides a user's prompt submission. Commands, meta prompts and prompts from
 * other origins are passed by the mod before this is called.
 *
 * @param a the cached assessment
 * @param cost the next turn's cost
 * @param mode the billing mode: a subscription is judged on tokens only
 * @param cfg the threshold and gate mode
 * @param held the prompt currently held, if any
 * @param hash the submitted prompt's hash
 * @param now epoch ms
 */
export function gateDecision(
  a: Assessment,
  cost: NextTurnCost,
  mode: BillingMode,
  cfg: Config,
  held: HeldPrompt | null,
  hash: string,
  now: number,
): GateDecision {
  const pass: GateDecision = { action: 'pass', held };
  // Only a rebuild that is expected regardless of timing is worth stopping for;
  // UNKNOWN in particular is never held (REQ-12.0.5).
  if (a.state !== 'COLD' && a.state !== 'INVALIDATED') return pass;
  if (cfg.gate === 'off' || !overThreshold(cost, mode, cfg)) return pass;

  const params = {
    state: a.state,
    tokens: cost.prefixTokens,
    ...(cost.usd !== null ? { usd: cost.usd.cold } : {}),
  };
  if (cfg.gate === 'warn') return { action: 'warn', held, reasonKey: 'gate.warn', params };

  // The same prompt again within the window goes through, and the hold is cleared.
  if (held !== null && held.hash === hash && now - held.at <= RELEASE_WINDOW_MS) return { action: 'pass', held: null };
  return { action: 'hold', held: { hash, at: now }, reasonKey: 'gate.hold', params };
}

/**
 * Whether the rebuild reaches the threshold: either the dollars or the tokens,
 * except on a subscription, where dollars aren't what the user pays and only
 * tokens count (D20).
 */
export function overThreshold(cost: NextTurnCost, mode: BillingMode, cfg: Config): boolean {
  if (cost.prefixTokens > cfg.thresholdTokens) return true;
  if (mode === 'subscription') return false;
  return cost.usd !== null && cost.usd.cold > cfg.thresholdUsd;
}
