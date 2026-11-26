/**
 * Turns a raw statusline payload into a {@link NativeSnapshot}.
 *
 * Only documented fields are copied, each checked for type and shape. The
 * payload also carries paths, a session name, a transcript path and other
 * things Token Shield must never store (REQ-1.0.2); because this function
 * builds the snapshot field by field instead of copying the object, none of
 * them can leak through. Strings that survive are ids, enums and cause names,
 * each matched against a strict pattern.
 */

import type {
  AbsentReason,
  MissCause,
  NativeSnapshot,
  PromptCache,
  RateWindow,
  Tier,
  Tiered,
  Ttl,
  Usage,
} from './types';

/** Model ids, including provider forms such as `us.anthropic.claude-opus-5-5-v1:0` and `[1m]` suffixes. */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/[\]-]{0,127}$/;
/** Session ids are UUIDs or similar opaque tokens. */
const SESSION_ID = /^[A-Za-z0-9-]{1,128}$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const CAUSE = /^[a-z0-9_]{1,64}$/;
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

/**
 * Parses one statusline payload.
 *
 * @param payload the JSON Claude Code sent to the statusline command, already parsed
 * @param receivedAt when it arrived, epoch ms
 */
export function parseSnapshot(payload: unknown, receivedAt: number): NativeSnapshot {
  const root = isObject(payload) ? payload : {};
  const model = isObject(root.model) ? root.model.id : undefined;
  const effort = isObject(root.effort) ? root.effort.level : undefined;
  const limits = isObject(root.rate_limits) ? root.rate_limits : {};
  return {
    v: 1,
    receivedAt,
    sessionId: pattern(root.session_id, SESSION_ID, 'measured', 'session_id' in root),
    ccVersion: pattern(root.version, VERSION, 'measured', 'version' in root),
    model: pattern(model, MODEL_ID, 'measured', isObject(root.model) && 'id' in root.model),
    effort: enumValue(effort, EFFORTS, isObject(root.effort) && 'level' in root.effort),
    fastMode: bool(root.fast_mode, 'measured', 'fast_mode' in root),
    promptCache: isObject(root.prompt_cache) ? parsePromptCache(root.prompt_cache) : null,
    currentUsage: isObject(root.context_window)
      ? usage(root.context_window.current_usage, 'current_usage' in root.context_window)
      : absent('missing'),
    rateLimits: {
      fiveHour: rateWindow(limits.five_hour, 'five_hour' in limits),
      sevenDay: rateWindow(limits.seven_day, 'seven_day' in limits),
    },
  };
}

/** Parses the `prompt_cache` object. */
function parsePromptCache(pc: Record<string, unknown>): PromptCache {
  const has = (key: string): boolean => key in pc;
  return {
    warm: bool(pc.warm, 'inferred', has('warm')),
    cachingObserved: bool(pc.caching_observed, 'measured', has('caching_observed')),
    ttl: enumValue(pc.ttl, TTLS, has('ttl')) as Tiered<Ttl>,
    expiresAt: epochSeconds(pc.expires_at, 'inferred', has('expires_at')),
    requests: count(pc.requests, 'measured', has('requests')),
    misses: count(pc.misses, 'measured', has('misses')),
    expectedRebuilds: count(pc.expected_rebuilds, 'measured', has('expected_rebuilds')),
    hitRatio: fraction(pc.hit_ratio, has('hit_ratio')),
    cacheWriteTokens: count(pc.cache_write_tokens, 'measured', has('cache_write_tokens')),
    missRecacheTokens: count(pc.miss_recache_tokens, 'measured', has('miss_recache_tokens')),
    recacheTokensIfCold: count(pc.recache_tokens_if_cold, 'inferred', has('recache_tokens_if_cold')),
    lastMissAt: epochSeconds(pc.last_miss_at, 'measured', has('last_miss_at')),
    lastMissCause: missCause(pc.last_miss_cause, has('last_miss_cause')),
    missCauses: missCauses(pc.miss_causes, has('miss_causes')),
  };
}

const TTLS = new Set<string>(['5m', '1h']);

/** An absent value with its reason. */
function absent(reason: AbsentReason): { readonly tier: 'absent'; readonly reason: AbsentReason } {
  return { tier: 'absent', reason };
}

/**
 * The absence for a value that failed its check: `missing` when the key was
 * not there, `null` when it was explicitly null, `malformed` otherwise.
 */
function why(value: unknown, present: boolean): { readonly tier: 'absent'; readonly reason: AbsentReason } {
  if (!present) return absent('missing');
  return absent(value === null ? 'null' : 'malformed');
}

/** Whether a value is a plain object. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A finite number of 0 or more. */
function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** A string matching `re`. */
function pattern(value: unknown, re: RegExp, tier: Tier, present: boolean): Tiered<string> {
  return typeof value === 'string' && re.test(value) ? { tier, value } : why(value, present);
}

/** A string from a fixed set, measured. */
function enumValue(value: unknown, allowed: ReadonlySet<string>, present: boolean): Tiered<string> {
  return typeof value === 'string' && allowed.has(value) ? { tier: 'measured', value } : why(value, present);
}

/** A boolean. */
function bool(value: unknown, tier: Tier, present: boolean): Tiered<boolean> {
  return typeof value === 'boolean' ? { tier, value } : why(value, present);
}

/** A non-negative count. */
function count(value: unknown, tier: Tier, present: boolean): Tiered<number> {
  return isCount(value) ? { tier, value } : why(value, present);
}

/** A 0–1 fraction, measured. */
function fraction(value: unknown, present: boolean): Tiered<number> {
  return isCount(value) && value <= 1 ? { tier: 'measured', value } : why(value, present);
}

/** Epoch seconds from the statusline, converted to epoch ms. Zero is not a time. */
function epochSeconds(value: unknown, tier: Tier, present: boolean): Tiered<number> {
  return isCount(value) && value > 0 ? { tier, value: value * 1000 } : why(value, present);
}

/** `context_window.current_usage`, measured; all four counts must be valid. */
function usage(value: unknown, present: boolean): Tiered<Usage> {
  if (!isObject(value)) return why(value, present);
  const { input_tokens, cache_read_input_tokens, cache_creation_input_tokens, output_tokens } = value;
  if (!isCount(input_tokens) || !isCount(cache_read_input_tokens) || !isCount(cache_creation_input_tokens) || !isCount(output_tokens)) {
    return absent('malformed');
  }
  return {
    tier: 'measured',
    value: { input: input_tokens, read: cache_read_input_tokens, write: cache_creation_input_tokens, output: output_tokens },
  };
}

/** One `rate_limits` window, measured. */
function rateWindow(value: unknown, present: boolean): Tiered<RateWindow> {
  if (!isObject(value)) return why(value, present);
  const { used_percentage, resets_at } = value;
  if (!isCount(used_percentage) || !isCount(resets_at) || resets_at === 0) return absent('malformed');
  return { tier: 'measured', value: { usedPercentage: used_percentage, resetsAt: resets_at * 1000 } };
}

/** `last_miss_cause`: Claude Code's inference, kept as cause names and counts only. */
function missCause(value: unknown, present: boolean): Tiered<MissCause> {
  if (!isObject(value)) return why(value, present);
  const { causes, tools_added, tools_removed, system_char_delta } = value;
  if (!Array.isArray(causes) || causes.length === 0 || !causes.every(c => typeof c === 'string' && CAUSE.test(c))) {
    return absent('malformed');
  }
  const cause: { -readonly [K in keyof MissCause]: MissCause[K] } = { causes: [...(causes as string[])] };
  if (isCount(tools_added)) cause.toolsAdded = tools_added;
  if (isCount(tools_removed)) cause.toolsRemoved = tools_removed;
  // A system prompt can shrink, so the delta may be negative.
  if (typeof system_char_delta === 'number' && Number.isFinite(system_char_delta)) cause.systemCharDelta = system_char_delta;
  return { tier: 'inferred', value: cause };
}

/** `miss_causes`: counts by cause name. */
function missCauses(value: unknown, present: boolean): Tiered<Readonly<Record<string, number>>> {
  if (!isObject(value)) return why(value, present);
  const out: Record<string, number> = {};
  for (const [name, n] of Object.entries(value)) {
    if (!CAUSE.test(name) || !isCount(n)) return absent('malformed');
    out[name] = n;
  }
  return { tier: 'inferred', value: out };
}

/** The value of a tiered field, or `undefined` when absent. */
export function valueOf<T>(field: Tiered<T>): T | undefined {
  return field.tier === 'absent' ? undefined : field.value;
}
