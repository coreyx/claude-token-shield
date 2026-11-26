/**
 * Calibration (REQ-14.0.4 to 14.0.6, design D19): how well the predicted
 * chance of a cache read matched what happened, from the assessment recorded
 * before each main request and that request's outcome. Computed when read,
 * the same way in the mod and in `tshield`.
 */

import type { Assessment, CacheState, LearnedRates } from '../assess/types';
import type { RequestRecord, Ttl } from '../model/types';
import { classifyProbe } from '../probe/probe';
import type { ProbeOutcome } from '../probe/probe';

/** The assessment that preceded one main request, and what the request found. */
export interface AssessmentRecord {
  readonly ts: number;
  readonly state: CacheState;
  readonly pHit: number;
  readonly interval: readonly [number, number];
  readonly ttl: Ttl | null;
  readonly remainingSec: number | null;
  readonly marginSec: number;
  readonly ccVersion: string | null;
  readonly model: string | null;
  readonly outcome: ProbeOutcome;
}

/** How far from the expiry a prediction was made (D19). */
export type Band = 'over_10m' | '1_10m' | 'margin' | 'past' | 'unknown';

/** One reliability-table row. */
export interface Bucket {
  readonly state: CacheState;
  readonly ttl: Ttl | null;
  readonly band: Band;
  readonly n: number;
  readonly meanPredicted: number;
  readonly observed: number;
  /** 95% Wilson interval around the observed rate. */
  readonly wilson: readonly [number, number];
}

/** The Brier score of one Claude Code version × model × TTL. */
export interface BrierGroup {
  readonly ccVersion: string | null;
  readonly model: string | null;
  readonly ttl: Ttl | null;
  readonly n: number;
  readonly brier: number;
}

/** The priors calibration falls back on, from `rules.json`. */
export interface Priors {
  readonly epsWithin: number;
  readonly epsAfter: number;
  readonly minCalibrationN: number;
}

/** What calibration found. */
export interface Calibration {
  readonly n: number;
  readonly buckets: readonly Bucket[];
  readonly brier: number | null;
  readonly brierBy: readonly BrierGroup[];
  readonly hot: { readonly n: number; readonly missRate: number | null; readonly statedUpper: number | null };
  readonly drift: boolean;
  /** Rates for the assessor: observed where there is enough evidence, the priors otherwise. */
  readonly learned: LearnedRates;
}

/** z for a 95% interval. */
const Z = 1.96;

/** The order bands and states are listed in. */
const BAND_ORDER: readonly Band[] = ['over_10m', '1_10m', 'margin', 'past', 'unknown'];
const STATE_ORDER: readonly CacheState[] = ['HOT', 'EXPIRING', 'UNCERTAIN', 'INVALIDATED', 'COLD', 'UNKNOWN'];

/**
 * A 95% Wilson score interval for `k` successes in `n` trials.
 *
 * @param k successes
 * @param n trials
 */
export function wilson(k: number, n: number): readonly [number, number] {
  if (n === 0) return [0, 1];
  const p = k / n;
  const z2 = Z * Z;
  const centre = (p + z2 / (2 * n)) / (1 + z2 / n);
  const half = (Z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

/**
 * The band a prediction falls in: past the expiry by more than the margin,
 * within it, then by minutes left.
 */
export function bandOf(remainingSec: number | null, marginSec: number): Band {
  if (remainingSec === null) return 'unknown';
  if (remainingSec < -marginSec) return 'past';
  if (Math.abs(remainingSec) <= marginSec) return 'margin';
  if (remainingSec <= 600) return '1_10m';
  return 'over_10m';
}

/** Orders strings by code unit, as Go compares them, so both list rows alike. */
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A partial read still read the cache; only a miss didn't. */
function wasRead(o: ProbeOutcome): number {
  return o === 'MISS' ? 0 : 1;
}

/**
 * Calibrates the recorded predictions (D19): the reliability table by state ×
 * TTL × band, the Brier score overall and per Claude Code version × model ×
 * TTL, and drift: `HOT` misses above the upper bound of the stated interval
 * with at least `minCalibrationN` of them. During drift the learned
 * within-TTL miss rate is the observed rate's Wilson upper bound, which widens
 * every interval until the rate is back inside (REQ-14.0.6).
 *
 * @param records the assessments with outcomes
 * @param priors the rates to fall back on, and the evidence needed to leave them
 */
export function calibrate(records: readonly AssessmentRecord[], priors: Priors): Calibration {
  const groups = new Map<string, { state: CacheState; ttl: Ttl | null; band: Band; n: number; predicted: number; read: number }>();
  const brierGroups = new Map<string, { ccVersion: string | null; model: string | null; ttl: Ttl | null; n: number; sum: number }>();
  let brierSum = 0;
  for (const r of records) {
    const band = bandOf(r.remainingSec, r.marginSec);
    const key = `${r.state}|${r.ttl ?? ''}|${band}`;
    const g = groups.get(key) ?? { state: r.state, ttl: r.ttl, band, n: 0, predicted: 0, read: 0 };
    g.n += 1;
    g.predicted += r.pHit;
    g.read += wasRead(r.outcome);
    groups.set(key, g);
    const sq = (r.pHit - wasRead(r.outcome)) ** 2;
    brierSum += sq;
    const bkey = `${r.ccVersion ?? ''}|${r.model ?? ''}|${r.ttl ?? ''}`;
    const b = brierGroups.get(bkey) ?? { ccVersion: r.ccVersion, model: r.model, ttl: r.ttl, n: 0, sum: 0 };
    b.n += 1;
    b.sum += sq;
    brierGroups.set(bkey, b);
  }

  const buckets: Bucket[] = [...groups.values()]
    .map(g => ({ state: g.state, ttl: g.ttl, band: g.band, n: g.n, meanPredicted: g.predicted / g.n, observed: g.read / g.n, wilson: wilson(g.read, g.n) }))
    .sort((a, b) => STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state) || cmp(a.ttl ?? '', b.ttl ?? '') || BAND_ORDER.indexOf(a.band) - BAND_ORDER.indexOf(b.band));
  const brierBy: BrierGroup[] = [...brierGroups.values()]
    .map(b => ({ ccVersion: b.ccVersion, model: b.model, ttl: b.ttl, n: b.n, brier: b.sum / b.n }))
    .sort((a, b) => cmp(`${a.ccVersion ?? ''}|${a.model ?? ''}|${a.ttl ?? ''}`, `${b.ccVersion ?? ''}|${b.model ?? ''}|${b.ttl ?? ''}`));

  const hot = records.filter(r => r.state === 'HOT');
  const hotMisses = hot.filter(r => r.outcome === 'MISS').length;
  const missRate = hot.length > 0 ? hotMisses / hot.length : null;
  // The stated interval's upper bound on a miss is one less its lower bound on a read.
  const statedUpper = hot.length > 0 ? 1 - hot.reduce((s, r) => s + r.interval[0], 0) / hot.length : null;
  const enoughHot = hot.length >= priors.minCalibrationN;
  const drift = enoughHot && missRate !== null && statedUpper !== null && missRate > statedUpper;

  // Observed rates are floored at a tenth of the prior: a run with no misses
  // at all must not claim certainty the assessor would then repeat.
  const after = records.filter(r => r.state === 'COLD' || bandOf(r.remainingSec, r.marginSec) === 'past');
  const epsWithin = !enoughHot || missRate === null ? priors.epsWithin : drift ? wilson(hotMisses, hot.length)[1] : Math.max(missRate, priors.epsWithin / 10);
  const epsAfter =
    after.length >= priors.minCalibrationN ? Math.max(after.filter(r => r.outcome !== 'MISS').length / after.length, priors.epsAfter / 10) : priors.epsAfter;

  return {
    n: records.length,
    buckets,
    brier: records.length > 0 ? brierSum / records.length : null,
    brierBy,
    hot: { n: hot.length, missRate, statedUpper },
    drift,
    learned: { epsWithin, epsAfter, n: records.length, drift },
  };
}

/**
 * The calibration pair for one main request (REQ-14.0.4): the assessment made
 * before it and the outcome it found, its cache read against the prefix the
 * assessment expected. `null` when there was no prediction to test (UNKNOWN,
 * or no known prefix) or the request wasn't the main conversation's.
 *
 * @param a the assessment taken before the request was sent
 * @param r the request as it landed
 * @param ccVersion Claude Code's version, when known
 */
export function calibrationPair(a: Assessment, r: RequestRecord, ccVersion: string | null): AssessmentRecord | null {
  if (r.lane !== 'main' || a.pHit === null || a.interval === null || a.prefixTokens.tier === 'absent') return null;
  return {
    ts: r.tsStart,
    state: a.state,
    pHit: a.pHit,
    interval: [a.interval[0], a.interval[1]],
    ttl: a.ttl.tier !== 'absent' ? a.ttl.value : null,
    remainingSec: a.remainingSec,
    marginSec: a.marginSec,
    ccVersion,
    model: r.model,
    outcome: classifyProbe(r.usage.read, a.prefixTokens.value),
  };
}
