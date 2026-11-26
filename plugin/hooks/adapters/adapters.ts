/**
 * Adapters: engine events in, the core's facts out (design D1). Each copies
 * only ids, numbers and enums, field by field, so no prompt, response, path or
 * other content can reach the session model or history (REQ-1.0.2, 20.0.4).
 * The hooks that call these return `next(e)` untouched.
 */

import type { EventRecord, RequestRecord, ResumeInfo, Ttl } from '../../core/model/types'

/** The usage a turn step reports, as far as the adapter needs it. */
export interface StepUsage {
  readonly input_tokens: number
  readonly output_tokens: number
  readonly cache_read_input_tokens: number
  readonly cache_creation_input_tokens: number
  readonly ephemeral_5m_input_tokens?: number
  readonly ephemeral_1h_input_tokens?: number
  readonly model: string
}

/**
 * A request record from a `turn.step`: the main lane when the step has no
 * `agentId`. The start is when the hook saw the step dispatch, which is when
 * the cache lifetime starts counting (AgentRequest.at).
 *
 * @returns `null` when no response arrived or it carried no usage
 */
export function stepRequest(
  step: { readonly turnId: string; readonly index: number; readonly model: string; readonly effort?: string | number; readonly agentId?: string },
  usage: StepUsage | null,
  startedAt: number,
  endedAt: number,
): RequestRecord | null {
  if (usage === null) return null
  const w5 = usage.ephemeral_5m_input_tokens
  const w1 = usage.ephemeral_1h_input_tokens
  // Without a split, Claude Code prices writes as five minutes; so do we.
  const write5m = w5 ?? (w1 === undefined ? usage.cache_creation_input_tokens : 0)
  const write1h = w1 ?? 0
  const ttl: Ttl | undefined = write1h > 0 ? '1h' : write5m > 0 ? '5m' : undefined
  return {
    id: `${step.turnId}:${step.index}`,
    lane: step.agentId === undefined ? 'main' : 'subagent',
    tsStart: startedAt,
    tsStartTier: 'measured',
    durationMs: Math.max(0, endedAt - startedAt),
    model: usage.model || step.model,
    speed: 'standard',
    ...(typeof step.effort === 'string' ? { effort: step.effort } : {}),
    ...(ttl !== undefined ? { ttl } : {}),
    usage: {
      input: usage.input_tokens,
      read: usage.cache_read_input_tokens,
      write5m,
      write1h,
      output: usage.output_tokens,
    },
    source: 'mod',
  }
}

/** Slash commands whose effect on the cache the rules know, by name. */
const COMMAND_EVENTS: Readonly<Record<string, string>> = {
  effort: 'effort_change',
  fast: 'fast_toggle',
  'reload-plugins': 'reload_plugins',
  rewind: 'rewind',
  recap: 'recap',
}

/**
 * The event a slash command implies, or `null` for one with no cache effect
 * to record here (model switches arrive through classic.PostModelSwitch and
 * compaction through session.compact, each with better detail).
 */
export function commandEvent(command: string, at: number): EventRecord | null {
  const kind = COMMAND_EVENTS[command]
  return kind === undefined ? null : { ts: at, kind }
}

/** The event a settings change implies: effort and fast mode rebuild on some models. */
export function configEvent(key: string, at: number): EventRecord | null {
  if (/effort/i.test(key)) return { ts: at, kind: 'effort_change' }
  if (/^fast/i.test(key)) return { ts: at, kind: 'fast_toggle' }
  return null
}

/** A finished main-conversation compaction: an expected rebuild, not a miss. */
export function compactionEvent(trigger: string, agentId: string | undefined, skipped: boolean, at: number): EventRecord | null {
  if (agentId !== undefined || skipped || trigger === 'precompute') return null
  return { ts: at, kind: 'compaction', detail: { to: trigger } }
}

/** A completed model switch, with the two model ids. */
export function switchEvent(from: string, to: string, at: number): EventRecord {
  return { ts: at, kind: 'model_switch', detail: { from, to } }
}

/** A resumed or forked session's numbers from classic.SessionStart, or `null` for any other start. */
export function resumeInfo(
  e: {
    readonly source: string
    readonly seconds_since_last_response?: number
    readonly context_tokens?: number
    readonly prompt_cache_likely_expired?: boolean
    readonly estimated_cache_write_usd?: number
  },
  at: number,
  ttl?: Ttl,
): ResumeInfo | null {
  if (e.source !== 'resume' && e.source !== 'fork') return null
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
  const info: { -readonly [K in keyof ResumeInfo]: ResumeInfo[K] } = { ts: at, source: e.source }
  const secs = n(e.seconds_since_last_response)
  const tokens = n(e.context_tokens)
  const usd = n(e.estimated_cache_write_usd)
  if (secs !== undefined) info.secondsSinceLastResponse = secs
  if (tokens !== undefined) info.contextTokens = tokens
  if (typeof e.prompt_cache_likely_expired === 'boolean') info.likelyExpired = e.prompt_cache_likely_expired
  if (usd !== undefined) info.estimatedCacheWriteUsd = usd
  if (ttl !== undefined) info.ttl = ttl
  return info
}
