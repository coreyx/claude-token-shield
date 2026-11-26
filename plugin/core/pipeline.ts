/**
 * The one composition of the core every host runs: assess the session, price
 * the next turn, quote the levers, recommend one and build the check view.
 * The mod, the parity fixtures and (in Go) `tshield check` all call this, so
 * there is a single answer to "what does the check say right now".
 */

import { assess } from './assess/assess';
import type { Assessment, AssessEnv, LearnedRates } from './assess/types';
import type { BillingMode, NextTurnCost } from './cost/cost';
import { billingMode, nextTurnCost } from './cost/cost';
import type { PlanShareModel } from './cost/planshare';
import { withPlanShare } from './cost/planshare';
import type { CostWithShare } from './cost/planshare';
import type { Prices, Rules } from './data/types';
import { valueOf } from './model/snapshot';
import type { SessionState } from './model/types';
import type { LeverQuote } from './recommend/levers';
import { quoteLevers } from './recommend/levers';
import type { Recommendation } from './recommend/recommend';
import { recommend } from './recommend/recommend';
import type { CheckMode, CheckView } from './view/view';
import { checkView } from './view/view';

/** Everything `evaluate` needs besides the session and the time. */
export interface EvaluateContext {
  readonly rules: Rules;
  readonly prices: Prices;
  readonly env: AssessEnv;
  readonly ccVersion?: string;
  readonly warnWindowsSec?: { readonly '1h': number; readonly '5m': number };
  readonly learned?: LearnedRates;
  /** The model to price when neither the snapshot nor a request names one. */
  readonly defaultModel?: string;
  readonly planShare?: PlanShareModel;
  readonly mode: CheckMode;
}

/** Every intermediate result, for hosts that need more than the view. */
export interface Evaluation {
  readonly a: Assessment;
  readonly billing: BillingMode;
  readonly model: string | null;
  readonly cost: CostWithShare | null;
  readonly quotes: readonly LeverQuote[];
  readonly rec: Recommendation;
  readonly view: CheckView;
}

/** The exit code `tshield check` returns for each state (REQ-19.0.3). */
export const EXIT_CODES = { HOT: 0, EXPIRING: 10, UNCERTAIN: 20, INVALIDATED: 30, COLD: 40, UNKNOWN: 50 } as const;

/**
 * Evaluates a session at `now`.
 *
 * @param s the session model
 * @param now epoch ms
 * @param ctx rules, prices, environment and mode
 */
export function evaluate(s: SessionState, now: number, ctx: EvaluateContext): Evaluation {
  const a = assess(s, now, {
    rules: ctx.rules,
    env: ctx.env,
    ...(ctx.ccVersion !== undefined ? { ccVersion: ctx.ccVersion } : {}),
    ...(ctx.warnWindowsSec !== undefined ? { warnWindowsSec: ctx.warnWindowsSec } : {}),
    ...(ctx.learned !== undefined ? { learned: ctx.learned } : {}),
  });
  const snap = s.lastSnapshot;
  const billing = billingMode(snap, ctx.env.provider);
  const model = (snap !== null ? valueOf(snap.model) : undefined) ?? s.lastTouch?.model ?? ctx.defaultModel ?? null;
  const prefix = valueOf(a.prefixTokens);
  const ttl = valueOf(a.ttl) ?? '5m';
  const fast = snap !== null ? valueOf(snap.fastMode) === true : s.lastTouch?.speed === 'fast';
  let cost: CostWithShare | null = null;
  if (a.state !== 'UNKNOWN' && model !== null && prefix !== undefined) {
    const base: NextTurnCost = nextTurnCost({ prefixTokens: prefix, model, ttl, provider: ctx.env.provider, fast, at: now }, ctx.prices);
    cost = ctx.planShare !== undefined ? withPlanShare(base, billing, model, ctx.planShare) : base;
  }
  const quotes = model !== null ? quoteLevers(a, s, { prices: ctx.prices, model, provider: ctx.env.provider, fast, now }) : [];
  const rec = recommend(a, quotes);
  const view = checkView({ a, s, quotes, rec, cost, billing, mode: ctx.mode });
  return { a, billing, model, cost, quotes, rec, view };
}
