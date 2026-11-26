/**
 * Synthetic statusline payloads and records for the model tests. The shapes
 * follow Claude Code's documented statusline JSON; every value is made up.
 */

import type { RequestRecord } from '../../../plugin/core/model/types'

/** Epoch seconds for a fixed test instant: 2026-01-01T15:00:00Z. */
export const T0 = 1767279600

/** A full statusline payload with a warm 1h cache, overridable per test. */
export function payload(overrides: Record<string, unknown> = {}, cache: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    cwd: '/home/example/project',
    session_id: '11111111-2222-3333-4444-555555555555',
    session_name: 'example session title',
    transcript_path: '/home/example/.claude/projects/example/transcript.jsonl',
    model: { id: 'claude-opus-5-5', display_name: 'Opus' },
    workspace: { current_dir: '/home/example/project', project_dir: '/home/example/project', added_dirs: [] },
    version: '2.1.332',
    output_style: { name: 'default' },
    cost: { total_cost_usd: 1.5, total_duration_ms: 1000, total_api_duration_ms: 500, total_lines_added: 1, total_lines_removed: 0 },
    context_window: {
      total_input_tokens: 812470,
      total_output_tokens: 900,
      context_window_size: 1000000,
      used_percentage: 81,
      remaining_percentage: 19,
      current_usage: { input_tokens: 12, output_tokens: 900, cache_creation_input_tokens: 3000, cache_read_input_tokens: 809458 },
    },
    exceeds_200k_tokens: true,
    prompt_cache: {
      warm: true,
      caching_observed: true,
      ttl: '1h',
      expires_at: T0 + 3600,
      requests: 214,
      misses: 1,
      expected_rebuilds: 1,
      hit_ratio: 0.972,
      cache_write_tokens: 1200000,
      miss_recache_tokens: 396000,
      last_miss_at: T0 - 4000,
      last_miss_cause: { causes: ['tools_changed'], tools_added: 1, tools_removed: 0 },
      miss_causes: { tools_changed: 1 },
      recache_tokens_if_cold: 812470,
      ...cache,
    },
    fast_mode: false,
    effort: { level: 'high' },
    thinking: { enabled: true },
    rate_limits: {
      five_hour: { used_percentage: 23.5, resets_at: T0 + 7200 },
      seven_day: { used_percentage: 41.2, resets_at: T0 + 86400 },
    },
    ...overrides,
  }
}

/** A main-lane request starting at `tsStartMs`. */
export function request(tsStartMs: number, overrides: Partial<RequestRecord> = {}): RequestRecord {
  return {
    id: `req-${tsStartMs}`,
    lane: 'main',
    tsStart: tsStartMs,
    tsStartTier: 'measured',
    model: 'claude-opus-5-5',
    speed: 'standard',
    ttl: '1h',
    usage: { input: 10, read: 800000, write5m: 0, write1h: 2000, output: 500 },
    source: 'mod',
    ...overrides,
  }
}
