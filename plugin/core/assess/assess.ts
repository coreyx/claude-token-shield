/**
 * The assessor: classifies the main conversation's cache into one of six
 * states in a fixed precedence, and attaches the chance the next request reads
 * it, an interval, a confidence level and the reasons, each with its tier
 * (design.md D3; analysis §5–§6).
 *
 * Pure: the same state, time and parameters always give the same assessment.
 */

import { compareVersions } from '../model/ids';
import { valueOf } from '../model/snapshot';
import type { SessionState, Tiered, Ttl } from '../model/types';
import { eventImpact } from './events';
import type {
  Assessment,
  AssessParams,
  CacheState,
  Confidence,
  Driver,
  PendingEvent,
  UnknownReason,
} from './types';

export const TTL_SEC: Readonly<Record<Ttl, number>> = { '5m': 300, '1h': 3600 };

/**
 * When the start time of the last request was not measured and its duration is
 * unknown, the start could be off by up to a typical long generation.
 */
const UNMEASURED_START_ERR_SEC = 30;

/** How far either side of the estimate the prior interval reaches, on the log-odds scale (≈ 90%). */
const LOGIT_HALF_WIDTH = 1.2;

/**
 * Assesses the main conversation's cache at `now`.
 *
 * @param state the session model
 * @param now epoch ms
 * @param p rules, environment, version and learned rates
 */
export function assess(state: SessionState, now: number, p: AssessParams): Assessment {
  const { rules } = p;
  const snap = state.lastSnapshot;
  const pc = snap?.promptCache ?? null;
  const touch = state.lastTouch;
  const drivers: Driver[] = [];

  // A resumed or forked session before its first snapshot or request: its
  // timing follows from how long ago the last response was and the last
  // recorded TTL (REQ-11, inferred). Any snapshot or request supersedes it.
  const resume = snap === null && touch === null ? state.resume : null;
  const ttl: Tiered<Ttl> = resume?.ttl !== undefined ? { tier: 'inferred', value: resume.ttl } : pickTtl(pc?.ttl, touch?.ttl);
  const ttlValue = valueOf(ttl);
  const resumeExpiry =
    resume?.ttl !== undefined && resume.secondsSinceLastResponse !== undefined
      ? resume.ts - resume.secondsSinceLastResponse * 1000 + TTL_SEC[resume.ttl] * 1000
      : undefined;
  const resumeKnown = resume !== null && (resume.likelyExpired === true || resumeExpiry !== undefined);
  const nativeExpiry = pc?.expiresAt;
  const ownExpiry = touch !== null && ttlValue !== undefined ? touch.tsStart + TTL_SEC[ttlValue] * 1000 : undefined;
  const nativeExpiryMs = nativeExpiry !== undefined ? valueOf(nativeExpiry) : undefined;
  const expiresAt: Tiered<number> =
    nativeExpiryMs !== undefined
      ? (nativeExpiry as Tiered<number>)
      : ownExpiry !== undefined
        ? { tier: 'inferred', value: ownExpiry }
        : resumeExpiry !== undefined
          ? { tier: 'inferred', value: resumeExpiry }
          : { tier: 'absent', reason: 'missing' };

  // The timing error is small when the expiry or the start time was reported;
  // otherwise it is as large as the request could have run.
  const tErr =
    nativeExpiryMs !== undefined || touch?.tsStartTier === 'measured'
      ? rules.timing.nativeTimeErrSec
      : (touch?.durationMs ?? UNMEASURED_START_ERR_SEC * 1000) / 1000;
  const marginSec = rules.timing.skewSec + tErr + rules.timing.baseMarginSec;
  const expiryMs = valueOf(expiresAt);
  const remainingSec = expiryMs !== undefined ? (expiryMs - now) / 1000 : null;
  const driftSec =
    nativeExpiryMs !== undefined && ownExpiry !== undefined && Math.abs(nativeExpiryMs - ownExpiry) / 1000 > marginSec
      ? Math.round(Math.abs(nativeExpiryMs - ownExpiry) / 1000)
      : null;

  const windows = p.warnWindowsSec ?? rules.warnWindowsSec;
  // With the TTL unknown, use the shorter window so a warning is never late.
  const warnWindowSec = ttlValue !== undefined ? windows[ttlValue] : Math.min(windows['1h'], windows['5m']);
  const picked = pickPrefix(pc?.recacheTokensIfCold, touch);
  const prefixTokens: Tiered<number> =
    picked.tier === 'absent' && resume?.contextTokens !== undefined ? { tier: 'inferred', value: resume.contextTokens } : picked;
  const stale = snap !== null && now - snap.receivedAt > rules.timing.staleSnapshotSec * 1000;
  const nativeUnavailable = snap === null;
  const model = (snap !== null ? valueOf(snap.model) : undefined) ?? touch?.model;
  const pending: PendingEvent[] = state.pending.map(event => ({
    event,
    impact: eventImpact(event, rules, model !== undefined ? { ...p.env, model } : p.env),
  }));

  const epsWithin = p.learned?.epsWithin ?? rules.priors.epsWithin;
  const epsAfter = p.learned?.epsAfter ?? rules.priors.epsAfter;
  const lowEvidence = p.learned === undefined || p.learned.n < rules.priors.minCalibrationN;

  const base = {
    at: now,
    ttl,
    expiresAt,
    remainingSec,
    marginSec,
    warnWindowSec,
    prefixTokens,
    pending,
    stale,
    driftSec,
    nativeUnavailable,
    drivers,
  };

  /** Builds an `UNKNOWN` assessment: no probability, only what is missing. */
  const unknown = (reason: UnknownReason, driver: Driver): Assessment => {
    drivers.push(driver);
    return { ...base, state: 'UNKNOWN', pHit: null, interval: null, lowEvidence: true, confidence: 'LOW', unknownReason: reason };
  };

  // 1. UNKNOWN: unsupported version, no response yet, or caching not observed.
  const version = p.ccVersion ?? (snap !== null ? valueOf(snap.ccVersion) : undefined);
  if (version !== undefined && compareVersions(version, rules.minClaudeCodeVersion) < 0) {
    return unknown('version', { key: 'driver.version', params: { version, min: rules.minClaudeCodeVersion }, tier: 'measured' });
  }
  if ((snap !== null && pc === null) || (snap === null && touch === null && !resumeKnown)) {
    return unknown('no_response', { key: 'driver.no_response', params: {}, tier: 'measured' });
  }
  if (pc !== null && valueOf(pc.cachingObserved) === false) {
    return unknown('caching_off', { key: 'driver.caching_off', params: {}, tier: 'measured' });
  }

  // Reasons common to every known state, in reading order.
  if (ttlValue !== undefined) {
    const fromNative = pc !== null && valueOf(pc.ttl) !== undefined;
    drivers.push({ key: 'driver.ttl', params: { ttl: ttlValue, source: fromNative ? 'prompt_cache.ttl' : 'request' }, tier: 'measured' });
  }
  if (expiryMs !== undefined) {
    drivers.push({ key: 'driver.expiry', params: { source: nativeExpiryMs !== undefined ? 'claude-code' : 'shield' }, tier: 'inferred' });
    drivers.push({ key: 'driver.remaining', params: { seconds: Math.round(remainingSec!), margin: Math.round(marginSec) }, tier: 'inferred' });
  } else {
    drivers.push({ key: 'driver.expiry_unknown', params: {}, tier: 'inferred' });
  }
  if (pending.length === 0) drivers.push({ key: 'driver.pending_none', params: {}, tier: 'measured' });
  for (const pe of pending) drivers.push({ key: 'driver.event', params: { kind: pe.event.kind, impact: pe.impact }, tier: 'inferred' });
  if (stale) drivers.push({ key: 'driver.stale', params: { seconds: Math.round((now - snap!.receivedAt) / 1000) }, tier: 'measured' });
  if (driftSec !== null) drivers.push({ key: 'driver.drift', params: { seconds: driftSec }, tier: 'inferred' });
  if (nativeUnavailable) drivers.push({ key: 'driver.native_unavailable', params: {}, tier: 'measured' });
  if (resume !== null) drivers.push({ key: 'driver.resume', params: {}, tier: 'inferred' });
  if (p.learned?.drift === true) drivers.push({ key: 'driver.calibration_drift', params: {}, tier: 'estimated' });

  /** Lowers a confidence to at most `cap`. */
  const capAt = (c: Confidence, cap: Confidence): Confidence => (RANK[c] < RANK[cap] ? c : cap);
  /** Caps that apply to any time-based decision. */
  const timingCaps = (c: Confidence): Confidence => {
    let out = c;
    if (nativeUnavailable || (nativeExpiryMs === undefined && touch?.tsStartTier !== 'measured')) out = capAt(out, 'MEDIUM');
    if (driftSec !== null || p.learned?.drift === true) out = capAt(out, 'MEDIUM');
    if (stale) out = 'LOW';
    return out;
  };

  /** Builds a known-state assessment. */
  const known = (cacheState: CacheState, pHit: number, interval: readonly [number, number], confidence: Confidence): Assessment => {
    drivers.push({
      key: 'driver.eps',
      params: { eps: cacheState === 'COLD' || cacheState === 'INVALIDATED' ? epsAfter : epsWithin, n: p.learned?.n ?? 0, evidence: lowEvidence ? 'low' : 'calibrated' },
      tier: 'estimated',
    });
    return { ...base, state: cacheState, pHit, interval, lowEvidence, confidence };
  };

  // 2. INVALIDATED: a documented invalidating event since the last request. Decided by a rule, so HIGH.
  const will = pending.find(pe => pe.impact === 'WILL');
  if (will !== undefined) {
    return { ...known('INVALIDATED', epsAfter, nearZero(epsAfter), 'HIGH'), cause: will.event };
  }

  // 3. COLD: Claude Code says the cache is cold, or the expiry is past by more than the margin.
  const warmFalse = pc !== null && valueOf(pc.warm) === false;
  if (warmFalse) drivers.push({ key: 'driver.warm_false', params: {}, tier: 'inferred' });
  // Claude Code judged a resumed session's cache likely expired.
  const resumeCold = resume !== null && resume.likelyExpired === true;
  if (warmFalse || resumeCold || (remainingSec !== null && remainingSec < -marginSec)) {
    return known('COLD', epsAfter, nearZero(epsAfter), warmFalse ? 'HIGH' : timingCaps('HIGH'));
  }

  // 4. UNCERTAIN: at the boundary, a possibly-invalidating event pending, or stale inputs.
  const may = pending.filter(pe => pe.impact === 'MAY');
  const boundary = remainingSec !== null && Math.abs(remainingSec) <= marginSec;
  if (boundary || may.length > 0 || stale) {
    const pTime = boundary ? boundaryProbability(remainingSec!, marginSec, epsWithin, epsAfter) : 1 - epsWithin;
    const { alpha, beta } = rules.priors.mayEvent;
    const pHit = may.reduce(acc => acc * (1 - alpha / (alpha + beta)), pTime);
    // A MAY event's probability is a prior until learned, which is weak evidence.
    const confidence = timingCaps(may.length > 0 && lowEvidence ? 'LOW' : 'MEDIUM');
    return known('UNCERTAIN', pHit, logitBand(pHit), confidence);
  }

  // 5–6. EXPIRING inside the warn window, else HOT.
  const timeState: CacheState = remainingSec !== null && remainingSec <= warnWindowSec ? 'EXPIRING' : 'HOT';
  const confidence = expiryMs === undefined ? 'MEDIUM' : timingCaps('HIGH');
  return known(timeState, 1 - epsWithin, nearOne(epsWithin), confidence);
}

const RANK: Readonly<Record<Confidence, number>> = { LOW: 0, MEDIUM: 1, HIGH: 2 };

/** The TTL from the snapshot, else from the last request that touched the prefix. */
function pickTtl(native: Tiered<Ttl> | undefined, fromRequest: Ttl | undefined): Tiered<Ttl> {
  if (native !== undefined && native.tier !== 'absent') return native;
  if (fromRequest !== undefined) return { tier: 'measured', value: fromRequest };
  return native ?? { tier: 'absent', reason: 'missing' };
}

/**
 * The prefix size: Claude Code's `recache_tokens_if_cold` first, else the last
 * request's full window (input, reads, writes and output, which all join the
 * next request's prefix) as an inference.
 */
function pickPrefix(native: Tiered<number> | undefined, touch: SessionState['lastTouch']): Tiered<number> {
  if (native !== undefined && native.tier !== 'absent') return native;
  if (touch !== null) {
    const u = touch.usage;
    return { tier: 'inferred', value: u.input + u.read + u.write5m + u.write1h + u.output };
  }
  return native ?? { tier: 'absent', reason: 'missing' };
}

/** A logistic curve across the boundary band, from `1 − εwithin` well before expiry to `εafter` well after. */
function boundaryProbability(remainingSec: number, marginSec: number, epsWithin: number, epsAfter: number): number {
  const s = 1 / (1 + Math.exp(-(3 * remainingSec) / marginSec));
  return epsAfter + (1 - epsWithin - epsAfter) * s;
}

/** Prior interval near 1: misses inside the TTL are rare but not impossible. */
function nearOne(eps: number): readonly [number, number] {
  return [Math.max(0, 1 - 3 * eps), 1 - eps / 2];
}

/** Prior interval near 0: reads past expiry are rare but happen. */
function nearZero(eps: number): readonly [number, number] {
  return [eps / 2, Math.min(1, 3 * eps)];
}

/** A band of ±{@link LOGIT_HALF_WIDTH} around `p` on the log-odds scale. */
function logitBand(p: number): readonly [number, number] {
  const clamped = Math.min(Math.max(p, 1e-6), 1 - 1e-6);
  const logit = Math.log(clamped / (1 - clamped));
  const sig = (x: number): number => 1 / (1 + Math.exp(-x));
  return [sig(logit - LOGIT_HALF_WIDTH), sig(logit + LOGIT_HALF_WIDTH)];
}
