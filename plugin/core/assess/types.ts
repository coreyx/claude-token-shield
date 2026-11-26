/**
 * What the assessor takes and returns (design.md, D3 and D19).
 */

import type { Impact, ProviderKey, Rules } from '../data/types';
import type { EventRecord, Tier, Tiered, Ttl } from '../model/types';

/** The six cache states, in the classifier's fixed precedence. */
export type CacheState = 'UNKNOWN' | 'INVALIDATED' | 'COLD' | 'UNCERTAIN' | 'EXPIRING' | 'HOT';

/** Trust in the estimate, separate from the probability itself. */
export type Confidence = 'HIGH' | 'MEDIUM' | 'LOW';

/** Why the state is `UNKNOWN`. */
export type UnknownReason = 'no_response' | 'caching_off' | 'version';

/** The environment that decides how some events affect the cache. */
export interface AssessEnv {
  /** Where requests go: decides whether per-message effort keeps the cache. */
  readonly provider: ProviderKey;
  /** Whether MCP tool search is on, so tool changes append instead of rewriting the prefix. */
  readonly toolSearch: boolean;
  /** `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` is set, which turns per-message effort off. */
  readonly experimentalBetasDisabled: boolean;
}

/** Rates learned from the user's own history (D19); absent until calibration has data. */
export interface LearnedRates {
  /** Observed miss rate inside the TTL, or its Wilson upper bound during drift. */
  readonly epsWithin: number;
  /** Observed read rate past expiry. */
  readonly epsAfter: number;
  /** Requests the rates rest on. */
  readonly n: number;
  /** Calibration drift: `HOT` misses exceed the stated interval. */
  readonly drift: boolean;
}

/** Everything `assess` needs besides the session state and the time. */
export interface AssessParams {
  readonly rules: Rules;
  readonly env: AssessEnv;
  /** Claude Code's version from the engine (`$.session.version()`); preferred over the snapshot's. */
  readonly ccVersion?: string;
  /** Configured warn windows in seconds; `rules.json` defaults when absent. */
  readonly warnWindowsSec?: { readonly '1h': number; readonly '5m': number };
  readonly learned?: LearnedRates;
}

/** One reason behind the assessment, in order, with how it is known. */
export interface Driver {
  /** A string catalog key (`driver.*`). */
  readonly key: string;
  readonly params: Readonly<Record<string, string | number>>;
  readonly tier: Tier;
}

/** A pending event with the impact the rules give it here. */
export interface PendingEvent {
  readonly event: EventRecord;
  readonly impact: Impact;
}

/** The assessor's answer for the main conversation's cache. */
export interface Assessment {
  readonly state: CacheState;
  /** Assessed at, epoch ms. */
  readonly at: number;
  /** Chance the next request reads the cache; `null` in `UNKNOWN`. */
  readonly pHit: number | null;
  /** Interval around `pHit`; `null` in `UNKNOWN`. */
  readonly interval: readonly [number, number] | null;
  /** The interval rests on priors only (fewer than the minimum calibrated requests). */
  readonly lowEvidence: boolean;
  readonly confidence: Confidence;
  readonly unknownReason?: UnknownReason;
  /** The first invalidating event, when the state is `INVALIDATED`. */
  readonly cause?: EventRecord;
  readonly ttl: Tiered<Ttl>;
  /** Expiry used, epoch ms. */
  readonly expiresAt: Tiered<number>;
  /** Seconds until expiry (negative once past); `null` when no expiry is known. */
  readonly remainingSec: number | null;
  readonly marginSec: number;
  readonly warnWindowSec: number;
  /** Tokens the next request re-caches if cold. */
  readonly prefixTokens: Tiered<number>;
  readonly pending: readonly PendingEvent[];
  /** The newest snapshot is older than the staleness limit (REQ-2.0.9). */
  readonly stale: boolean;
  /** Native and own expiry disagree by more than the margin (REQ-2.0.10); seconds of difference. */
  readonly driftSec: number | null;
  /** No native snapshot: the assessment runs on the mod's own observations (D2, 2nd column). */
  readonly nativeUnavailable: boolean;
  readonly drivers: readonly Driver[];
}
