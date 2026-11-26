/**
 * Display rules for probabilities (REQ-2.0.6, analysis §6.7): never above
 * "≥ 99%" or below "≤ 1%", never "100%" or "0%", and nothing at all in
 * `UNKNOWN`.
 */

import { formatString } from '../data/load';
import type { Rules, Strings } from '../data/types';
import type { Assessment } from './types';

/**
 * Formats a probability within the display caps.
 *
 * @param p the probability, or `null` when there is none to show
 * @param display the caps from `rules.json`
 * @param strings the catalog (`prob.at_least`, `prob.at_most`, `prob.about`)
 * @returns the text, or `null` when no percentage may be shown
 */
export function formatProbability(p: number | null, display: Rules['display'], strings: Strings): string | null {
  if (p === null || !Number.isFinite(p)) return null;
  if (p >= display.maxProb) return formatString(strings, 'prob.at_least', { pct: Math.round(display.maxProb * 100) });
  if (p <= display.minProb) return formatString(strings, 'prob.at_most', { pct: Math.round(display.minProb * 100) });
  // Between the caps, rounding can never produce 0% or 100%.
  const pct = Math.min(Math.round(display.maxProb * 100), Math.max(Math.round(display.minProb * 100), Math.round(p * 100)));
  return formatString(strings, 'prob.about', { pct });
}

/**
 * The assessment's probability for display: `null` in `UNKNOWN`, so no
 * surface can show a percentage there.
 */
export function assessmentProbability(a: Assessment, display: Rules['display'], strings: Strings): string | null {
  return a.state === 'UNKNOWN' ? null : formatProbability(a.pHit, display, strings);
}
