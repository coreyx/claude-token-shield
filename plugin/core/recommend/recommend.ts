/**
 * The recommendation policy (design D6, REQ-4.0.3): a short ordered list of
 * rules that picks exactly one lever, or none, with a reason that fits on one
 * line.
 */

import type { Assessment } from '../assess/types';
import type { LeverId, LeverQuote } from './levers';

/** The levers compared on cost when the cache is cold or invalidated (REQ-4.0.5). */
export const COLD_CANDIDATES: readonly LeverId[] = ['continue', 'compact', 'rewind'];

/** The chance range where a probe's answer is worth its price (D6). */
const PROBE_RANGE: readonly [number, number] = [0.2, 0.8];

/** The policy's answer. */
export interface Recommendation {
  /** The one lever recommended, or `none`. */
  readonly lever: LeverId | 'none';
  /** Catalog key of the one-line reason. */
  readonly reasonKey: string;
  readonly params: Readonly<Record<string, string | number>>;
  /** In `UNCERTAIN`: mention `--probe`, because the outcome is close to a coin flip. */
  readonly probeHint: boolean;
}

/**
 * Picks one lever for the assessment, in order:
 *
 * 1. `HOT` → none ("no action needed").
 * 2. `EXPIRING` → continue now, before the expiry.
 * 3. `UNCERTAIN` → continue, with a probe hint when the chance is near even.
 * 4. `COLD` / `INVALIDATED` → the cheapest of continue, `/compact` and
 *    `/rewind` over the next turns. Levers with unknown costs are left out
 *    (REQ-4.0.6). `/clear` throws away the conversation, a cost no price
 *    captures, so it is quoted but never recommended on cost.
 * 5. `UNKNOWN` → none, saying what is missing.
 *
 * @param a the assessment
 * @param quotes the levers quoted for it
 */
export function recommend(a: Assessment, quotes: readonly LeverQuote[]): Recommendation {
  const none = (reasonKey: string, params: Readonly<Record<string, string | number>> = {}): Recommendation => ({
    lever: 'none',
    reasonKey,
    params,
    probeHint: false,
  });
  switch (a.state) {
    case 'HOT':
      return none('recommend.none.hot', expiry(a));
    case 'EXPIRING':
      return { lever: 'continue', reasonKey: 'recommend.continue.expiring', params: expiry(a), probeHint: false };
    case 'UNCERTAIN': {
      const p = a.pHit!; // set in every state but UNKNOWN
      return { lever: 'continue', reasonKey: 'recommend.continue.uncertain', params: {}, probeHint: p >= PROBE_RANGE[0] && p <= PROBE_RANGE[1] };
    }
    case 'COLD':
    case 'INVALIDATED': {
      const known = quotes.filter(q => COLD_CANDIDATES.includes(q.lever) && q.horizonUsd !== null);
      if (known.length === 0) return none('recommend.none.unknown_costs');
      const best = known.reduce((a, b) => (b.horizonUsd! < a.horizonUsd! ? b : a));
      return { lever: best.lever, reasonKey: 'recommend.cheapest', params: { lever: best.lever, usd: best.horizonUsd! }, probeHint: false };
    }
    case 'UNKNOWN':
      return none('recommend.none.unknown', { reason: a.unknownReason! }); // always set in UNKNOWN
  }
}

/** The expiry as a parameter, left out when unknown rather than filled with a stand-in. */
function expiry(a: Assessment): Readonly<Record<string, number>> {
  return a.expiresAt.tier === 'absent' ? {} : { expiresAt: a.expiresAt.value };
}
