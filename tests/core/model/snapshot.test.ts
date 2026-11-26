import { describe, expect, it } from 'vitest'

import { parseSnapshot, valueOf } from '../../../plugin/core/model/snapshot'
import { payload, T0 } from './fixtures'

const NOW = T0 * 1000

describe('parseSnapshot', () => {
  it('reports warm, TTL and expiry as given (AC 1.1)', () => {
    const s = parseSnapshot(payload(), NOW)
    const pc = s.promptCache!
    expect(pc.warm).toEqual({ tier: 'inferred', value: true })
    expect(pc.ttl).toEqual({ tier: 'measured', value: '1h' })
    expect(pc.expiresAt).toEqual({ tier: 'inferred', value: (T0 + 3600) * 1000 })
    expect(s.receivedAt).toBe(NOW)
  })

  it('copies every documented cache field with its tier', () => {
    const pc = parseSnapshot(payload(), NOW).promptCache!
    expect(valueOf(pc.cachingObserved)).toBe(true)
    expect(valueOf(pc.requests)).toBe(214)
    expect(valueOf(pc.misses)).toBe(1)
    expect(valueOf(pc.expectedRebuilds)).toBe(1)
    expect(valueOf(pc.hitRatio)).toBe(0.972)
    expect(valueOf(pc.cacheWriteTokens)).toBe(1200000)
    expect(valueOf(pc.missRecacheTokens)).toBe(396000)
    expect(pc.recacheTokensIfCold).toEqual({ tier: 'inferred', value: 812470 })
    expect(valueOf(pc.lastMissAt)).toBe((T0 - 4000) * 1000)
    expect(pc.lastMissCause).toEqual({ tier: 'inferred', value: { causes: ['tools_changed'], toolsAdded: 1, toolsRemoved: 0 } })
    expect(valueOf(pc.missCauses)).toEqual({ tools_changed: 1 })
  })

  it('copies the session fields', () => {
    const s = parseSnapshot(payload(), NOW)
    expect(valueOf(s.sessionId)).toBe('11111111-2222-3333-4444-555555555555')
    expect(valueOf(s.ccVersion)).toBe('2.1.332')
    expect(valueOf(s.model)).toBe('claude-opus-5-5')
    expect(valueOf(s.effort)).toBe('high')
    expect(valueOf(s.fastMode)).toBe(false)
    expect(valueOf(s.currentUsage)).toEqual({ input: 12, read: 809458, write: 3000, output: 900 })
    expect(valueOf(s.rateLimits.fiveHour)).toEqual({ usedPercentage: 23.5, resetsAt: (T0 + 7200) * 1000 })
    expect(valueOf(s.rateLimits.sevenDay)).toEqual({ usedPercentage: 41.2, resetsAt: (T0 + 86400) * 1000 })
  })

  it('stores no paths, names or other free text (REQ-1.0.2)', () => {
    const stored = JSON.stringify(parseSnapshot(payload(), NOW))
    for (const text of ['/home/example', 'example session title', 'transcript.jsonl', 'Opus', 'default']) {
      expect(stored).not.toContain(text)
    }
  })

  it('has no prompt cache before the first response (AC 1.5)', () => {
    expect(parseSnapshot(payload({ prompt_cache: undefined }), NOW).promptCache).toBeNull()
  })

  it('never turns a missing expiry into 0 (AC 1.7)', () => {
    const missing = payload()
    delete (missing.prompt_cache as Record<string, unknown>).expires_at
    expect(parseSnapshot(missing, NOW).promptCache!.expiresAt).toEqual({ tier: 'absent', reason: 'missing' })
    expect(parseSnapshot(payload({}, { expires_at: null }), NOW).promptCache!.expiresAt).toEqual({ tier: 'absent', reason: 'null' })
    expect(parseSnapshot(payload({}, { expires_at: 0 }), NOW).promptCache!.expiresAt).toEqual({ tier: 'absent', reason: 'malformed' })
    expect(parseSnapshot(payload({}, { expires_at: '2026-01-01' }), NOW).promptCache!.expiresAt.tier).toBe('absent')
  })

  it('keeps recache tokens absent while null after a compaction', () => {
    expect(parseSnapshot(payload({}, { recache_tokens_if_cold: null }), NOW).promptCache!.recacheTokensIfCold).toEqual({
      tier: 'absent',
      reason: 'null',
    })
  })

  it.each<[string, Record<string, unknown>, Record<string, unknown>, (s: ReturnType<typeof parseSnapshot>) => unknown]>([
    ['model id with spaces', { model: { id: 'my model' } }, {}, s => s.model],
    ['version text', { version: 'latest' }, {}, s => s.ccVersion],
    ['effort level', { effort: { level: 'turbo' } }, {}, s => s.effort],
    ['fast mode', { fast_mode: 'yes' }, {}, s => s.fastMode],
    ['session id', { session_id: '../etc' }, {}, s => s.sessionId],
    ['hit ratio above 1', {}, { hit_ratio: 97.2 }, s => s.promptCache!.hitRatio],
    ['negative count', {}, { misses: -1 }, s => s.promptCache!.misses],
    ['ttl', {}, { ttl: '30m' }, s => s.promptCache!.ttl],
    ['warm', {}, { warm: 1 }, s => s.promptCache!.warm],
    ['cause name', {}, { last_miss_cause: { causes: ['Tools Changed'] } }, s => s.promptCache!.lastMissCause],
    ['empty causes', {}, { last_miss_cause: { causes: [] } }, s => s.promptCache!.lastMissCause],
    ['cause counts', {}, { miss_causes: { tools_changed: -2 } }, s => s.promptCache!.missCauses],
    ['cause count key', {}, { miss_causes: { 'bad key': 1 } }, s => s.promptCache!.missCauses],
    ['usage', { context_window: { current_usage: { input_tokens: 1 } } }, {}, s => s.currentUsage],
    ['rate window', { rate_limits: { five_hour: { used_percentage: 5, resets_at: 0 } } }, {}, s => s.rateLimits.fiveHour],
  ])('marks a malformed %s absent, not zero', (_name, overrides, cache, pick) => {
    expect(pick(parseSnapshot(payload(overrides, cache), NOW))).toEqual({ tier: 'absent', reason: 'malformed' })
  })

  it('accepts provider model ids', () => {
    const s = parseSnapshot(payload({ model: { id: 'us.anthropic.claude-opus-5-5-v1:0' } }), NOW)
    expect(valueOf(s.model)).toBe('us.anthropic.claude-opus-5-5-v1:0')
  })

  it('keeps a negative system prompt delta and drops unknown cause extras', () => {
    const s = parseSnapshot(
      payload({}, { last_miss_cause: { causes: ['system_prompt_changed'], system_char_delta: -120, note: 'free text' } }),
      NOW,
    )
    expect(valueOf(s.promptCache!.lastMissCause)).toEqual({ causes: ['system_prompt_changed'], systemCharDelta: -120 })
  })

  it('reports null usage and missing windows as absent', () => {
    const s = parseSnapshot(payload({ context_window: { current_usage: null }, rate_limits: undefined }), NOW)
    expect(s.currentUsage).toEqual({ tier: 'absent', reason: 'null' })
    expect(s.rateLimits.fiveHour).toEqual({ tier: 'absent', reason: 'missing' })
    expect(parseSnapshot(payload({ context_window: undefined }), NOW).currentUsage).toEqual({ tier: 'absent', reason: 'missing' })
    expect(parseSnapshot(payload({ effort: undefined, model: undefined }), NOW).effort).toEqual({ tier: 'absent', reason: 'missing' })
  })

  it('treats a payload that is not an object as empty', () => {
    const s = parseSnapshot('not json', NOW)
    expect(s.promptCache).toBeNull()
    expect(s.model).toEqual({ tier: 'absent', reason: 'missing' })
  })
})
