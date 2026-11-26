/**
 * The probe's pure half (REQ-7, design D12): whether to offer one, what it
 * would cost either way, and what its measured usage says about the cache.
 * The mod confirms and runs it through `$.model.fork`.
 */

import type { Assessment } from '../assess/types';
import type { NextTurnCost } from '../cost/cost';
import type { RequestRecord, Ttl } from '../model/types';

/** With more than this left on a HOT cache, a probe would only re-buy what is known. */
export const HOT_PROBE_MIN_SEC = 300;

/** The prompt the fork answers: as small as a request can be. */
export const PROBE_PROMPT = 'Reply with OK.';

/** Whether to offer a probe, and at what price either way. */
export type ProbeQuote =
  | { readonly action: 'decline'; readonly reasonKey: 'probe.decline_lost' | 'probe.decline_hot' }
  | { readonly action: 'confirm'; readonly warmUsd: number | null; readonly coldUsd: number | null; readonly tokens: number | null };

/**
 * Decides whether to offer a probe (REQ-7.0.4). Declined, unless forced,
 * when the cache is COLD or INVALIDATED with HIGH confidence ("a probe would
 * just pay the rebuild") or HOT with more than 5 minutes left; otherwise
 * quoted at both prices for the confirm band (REQ-7.0.1).
 *
 * @param a the current assessment
 * @param cost the next turn's cost, if known
 * @param force whether `--force` was given
 */
export function probeQuote(a: Assessment, cost: NextTurnCost | null, force: boolean): ProbeQuote {
  if (!force) {
    if ((a.state === 'COLD' || a.state === 'INVALIDATED') && a.confidence === 'HIGH') return { action: 'decline', reasonKey: 'probe.decline_lost' };
    if (a.state === 'HOT' && a.remainingSec !== null && a.remainingSec > HOT_PROBE_MIN_SEC) return { action: 'decline', reasonKey: 'probe.decline_hot' };
  }
  return {
    action: 'confirm',
    warmUsd: cost?.usd?.warm ?? null,
    coldUsd: cost?.usd?.cold ?? null,
    tokens: cost?.prefixTokens ?? (a.prefixTokens.tier !== 'absent' ? a.prefixTokens.value : null),
  };
}

/** What a probe found. */
export type ProbeOutcome = 'HIT' | 'MISS' | 'PARTIAL';

/**
 * Classifies a probe by how much of the prefix it read from cache (D12):
 * at least 95% is a hit, at most 5% a miss, anything between partial.
 *
 * @param read `cache_read_input_tokens`
 * @param prefix the prefix size the probe re-sent
 */
export function classifyProbe(read: number, prefix: number): ProbeOutcome {
  if (prefix <= 0) return read > 0 ? 'HIT' : 'MISS';
  const share = read / prefix;
  if (share >= 0.95) return 'HIT';
  if (share <= 0.05) return 'MISS';
  return 'PARTIAL';
}

/** A fork's usage, as `$.model.fork` reports it. */
export interface ForkUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_read_input_tokens: number;
  readonly cache_creation_input_tokens: number;
}

/**
 * The probe as a request record on the `probe` lane, so history keeps it for
 * calibration and the model's expiry moves to one TTL after it (REQ-7.0.3).
 * The fork reports writes without their TTL, so they are put under the
 * session's own.
 *
 * @param usage the fork's measured usage
 * @param startedAt when the fork was sent, epoch ms
 * @param durationMs how long it took
 * @param model the session's model
 * @param ttl the session's TTL
 * @param lane `probe`, or `keepalive` for a keep-alive's refresh
 */
export function probeRecord(
  usage: ForkUsage,
  startedAt: number,
  durationMs: number,
  model: string,
  ttl: Ttl | undefined,
  lane: 'probe' | 'keepalive' = 'probe',
): RequestRecord {
  const write = usage.cache_creation_input_tokens;
  return {
    id: `${lane}-${startedAt}`,
    lane,
    tsStart: startedAt,
    tsStartTier: 'measured',
    durationMs,
    model,
    speed: 'standard',
    ...(ttl !== undefined ? { ttl } : {}),
    usage: {
      input: usage.input_tokens,
      read: usage.cache_read_input_tokens,
      write5m: ttl === '5m' ? write : 0,
      write1h: ttl === '5m' ? 0 : write,
      output: usage.output_tokens,
    },
    source: 'mod',
  };
}
