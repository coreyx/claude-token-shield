/**
 * The session model's vocabulary: tier-tagged values, the native snapshot,
 * request and event records, the facts adapters produce, and the reducer's
 * state (design.md, D1 and "Data model").
 *
 * Times are epoch milliseconds throughout the core. Claude Code's statusline
 * reports epoch seconds; `parseSnapshot` converts them on the way in.
 */

/**
 * How a value is known (analysis §2): `measured` reports a past fact,
 * `inferred` follows from measured facts and documented rules (Claude Code's
 * own `warm` and `expires_at` included), `estimated` depends on what can't be
 * observed.
 */
export type Tier = 'measured' | 'inferred' | 'estimated';

/** Why a value is absent: the field was missing, explicitly null, or the wrong type. */
export type AbsentReason = 'missing' | 'null' | 'malformed';

/**
 * A value with its certainty tier, or an explicit absence. Absence is never
 * zero-filled (REQ-1.0.7): anything derived from an absent value has to say so.
 */
export type Tiered<T> =
  | { readonly tier: Tier; readonly value: T }
  | { readonly tier: 'absent'; readonly reason: AbsentReason };

/** The cache lifetime Claude Code reports. */
export type Ttl = '5m' | '1h';

/** Claude Code's diagnosis of the most recent miss. */
export interface MissCause {
  /** One or more cause names, e.g. `tools_changed`, `ttl_expired_5m`, `likely_server_side`. */
  readonly causes: readonly string[];
  readonly toolsAdded?: number;
  readonly toolsRemoved?: number;
  /** Change in system prompt length, in characters (with `system_prompt_changed`). */
  readonly systemCharDelta?: number;
}

/** The statusline's `prompt_cache` object, whitelisted and tier-tagged. */
export interface PromptCache {
  readonly warm: Tiered<boolean>;
  readonly cachingObserved: Tiered<boolean>;
  readonly ttl: Tiered<Ttl>;
  /** When the cached prefix expires, epoch ms. Absent (`null`) when the last response reported no cache tokens. */
  readonly expiresAt: Tiered<number>;
  readonly requests: Tiered<number>;
  readonly misses: Tiered<number>;
  readonly expectedRebuilds: Tiered<number>;
  /** Cache reads as a fraction (0–1) of all input this session. */
  readonly hitRatio: Tiered<number>;
  readonly cacheWriteTokens: Tiered<number>;
  readonly missRecacheTokens: Tiered<number>;
  /** Tokens the next request re-caches if cold. Absent right after a compaction until the next request. */
  readonly recacheTokensIfCold: Tiered<number>;
  /** When the last miss happened, epoch ms. */
  readonly lastMissAt: Tiered<number>;
  readonly lastMissCause: Tiered<MissCause>;
  /** Diagnosed misses this session, by cause name. */
  readonly missCauses: Tiered<Readonly<Record<string, number>>>;
}

/** Token counts of one response. */
export interface Usage {
  readonly input: number;
  readonly read: number;
  /** Cache writes; the statusline reports them without a 5m/1h split. */
  readonly write: number;
  readonly output: number;
}

/** A subscription usage window. */
export interface RateWindow {
  /** 0–100. */
  readonly usedPercentage: number;
  /** Epoch ms. */
  readonly resetsAt: number;
}

/**
 * One statusline payload, reduced to whitelisted numbers, timestamps, enums,
 * model ids and cause names (REQ-1.0.2). `promptCache` is `null` when the
 * payload had no `prompt_cache` object: no main-conversation response yet.
 */
export interface NativeSnapshot {
  readonly v: 1;
  /** When the payload was received, epoch ms. */
  readonly receivedAt: number;
  readonly sessionId: Tiered<string>;
  readonly ccVersion: Tiered<string>;
  readonly model: Tiered<string>;
  readonly effort: Tiered<string>;
  readonly fastMode: Tiered<boolean>;
  readonly promptCache: PromptCache | null;
  readonly currentUsage: Tiered<Usage>;
  readonly rateLimits: {
    readonly fiveHour: Tiered<RateWindow>;
    readonly sevenDay: Tiered<RateWindow>;
  };
}

/** Which kind of request a record describes. Only `main` feeds the main conversation's assessment. */
export type Lane = 'main' | 'subagent' | 'compact' | 'probe' | 'keepalive';

/** One API request, as the mod or a transcript reports it. */
export interface RequestRecord {
  readonly id: string;
  readonly lane: Lane;
  /** Request start, epoch ms: the cache lifetime runs from here. */
  readonly tsStart: number;
  readonly tsStartTier: Tier;
  /** How long the request took, when known; bounds the error in an inferred start time. */
  readonly durationMs?: number;
  readonly model: string;
  readonly speed: 'standard' | 'fast';
  readonly effort?: string;
  readonly ttl?: Ttl;
  readonly usage: {
    readonly input: number;
    readonly read: number;
    readonly write5m: number;
    readonly write1h: number;
    readonly output: number;
  };
  readonly source: 'mod' | 'bridge' | 'transcript';
}

/**
 * Something that happened in the session which may affect the cache. The
 * event's impact (`WILL`, `MAY`, `NO_EFFECT`) is not stored here: the assessor
 * looks it up in `rules.json` for the context at hand.
 */
export interface EventRecord {
  /** Epoch ms. */
  readonly ts: number;
  /** A `rules.json` event kind, e.g. `model_switch`, `ttl_bucket_change`. */
  readonly kind: string;
  /** Ids only, never content: the models or TTLs on either side. */
  readonly detail?: { readonly from?: string; readonly to?: string };
}

/** A resumed or forked session's numbers, from `classic.SessionStart`. */
export interface ResumeInfo {
  readonly ts: number;
  readonly source: 'resume' | 'fork';
  readonly secondsSinceLastResponse?: number;
  readonly contextTokens?: number;
  readonly likelyExpired?: boolean;
  readonly estimatedCacheWriteUsd?: number;
  /** The session's last recorded TTL, which the mod adds; Claude Code's event doesn't carry one. */
  readonly ttl?: Ttl;
}

/** The inputs the reducer accepts; adapters turn engine events into these. */
export type Fact =
  | { readonly kind: 'snapshot'; readonly snapshot: NativeSnapshot }
  | { readonly kind: 'request'; readonly request: RequestRecord }
  | { readonly kind: 'event'; readonly event: EventRecord }
  | { readonly kind: 'resume'; readonly resume: ResumeInfo };

/** The session model: everything the assessor reads, and nothing more. */
export interface SessionState {
  /** The newest native snapshot, or `null` before the first. */
  readonly lastSnapshot: NativeSnapshot | null;
  /** Main-lane requests, oldest first, at most {@link REQUEST_LOG_LIMIT}. */
  readonly requests: readonly RequestRecord[];
  /** The last request that touched the main prefix (main, probe or keep-alive), which restarts its TTL. */
  readonly lastTouch: RequestRecord | null;
  /** Events since the last main request; a main request settles them. */
  readonly pending: readonly EventRecord[];
  /** Every event, oldest first, at most {@link EVENT_LOG_LIMIT}, for history. */
  readonly events: readonly EventRecord[];
  readonly resume: ResumeInfo | null;
}

/** Bound on the main-lane request log (design D1). */
export const REQUEST_LOG_LIMIT = 200;

/** Bound on the event log. */
export const EVENT_LOG_LIMIT = 200;
