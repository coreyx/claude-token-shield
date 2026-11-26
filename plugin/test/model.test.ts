import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { engine, prompt, SESSION, START, T0 } from './engine'
import type { Seen } from './engine'

const DATA = '/plugin-data'

/** Places the bridge's snapshot for the test session: warm on Opus 5.5 until 16:40:02. */
function placeSnapshot(seen: Seen, cache: Record<string, unknown> = {}, at = T0): void {
  const payload = {
    session_id: SESSION,
    model: { id: 'claude-opus-5-5' },
    version: '2.1.332',
    prompt_cache: { warm: true, caching_observed: true, ttl: '1h', expires_at: T0 / 1000 + 48 * 60, recache_tokens_if_cold: 812470, ...cache },
  }
  seen.files.set(`${DATA}/sessions/${SESSION}/snapshot.json`, { text: JSON.stringify({ v: 1, receivedAt: at, payload }), mtimeMs: at })
}

/** The engine stand-in for model requests: a response with the given usage and text. */
function stepsAnswer(on: On, answer: string): void {
  on('turn.step', async function* (_, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer,
      toolUses: [],
      stopReason: 'end_turn' as const,
      usage: {
        input_tokens: 12,
        output_tokens: 900,
        cache_read_input_tokens: 809458,
        cache_creation_input_tokens: 3000,
        ephemeral_5m_input_tokens: 0,
        ephemeral_1h_input_tokens: 3000,
        model: 'claude-opus-5-5',
      },
    }
  })
}

/** Runs one model request through the plugin and reads it to its end. */
async function step($: Engine, index: number): Promise<void> {
  const stream = $.turn.step({ turnId: 't1', index, model: 'claude-opus-5-5', messageCount: 3 })
  for await (const _ of stream) {
    // The stand-in streams nothing; the result is what the plugin records.
  }
  await stream.result
}

const last = (seen: Seen) => seen.statuses[seen.statuses.length - 1] ?? ''

/** A slash command typed at the composer. */
const command = (name: string, args = '') => ({ command: name, args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 100 } })

/** A setting changed in the config menu. */
const setting = (key: string, value: string) => ({ key, value, previous: '', provider: { plugin: 'core', tier: 'builtin' as const }, origin: { kind: 'composer' as const } })

/** What classic.PostModelSwitch carries for a warm switch. */
const switched = { from_model: 'claude-opus-5-5', to_model: 'claude-sonnet-5-5', requested_model: 'sonnet', source: 'command' as const, context_tokens: 812470, prompt_cache_warm: true, cache_ttl: '1h' as const, estimated_cache_write_usd: 3.25, pricing: 'catalog' as const }

test('a snapshot and steps give the right state on the status line (AC 1.1)', async ($, on) => {
  const seen = engine(on)
  stepsAnswer(on, 'done')
  placeSnapshot(seen)
  await $.session.start(START)
  expect(last(seen)).toMatch(/^● cache HOT · 812k · warm until \d\d:40$/)
  await step($, 0)
  await seen.clock.advance(5_000)
  expect(last(seen)).toMatch(/cache HOT/)
})

test('an unrelated setting or command changes nothing (AC 2.3)', async ($, on) => {
  const seen = engine(on)
  on('config.set', (_, e) => ({ value: e.value }))
  on('command.run', () => ({ text: '' }))
  placeSnapshot(seen)
  await $.session.start(START)
  await $.config.set(setting('mcpServers', '{}'))
  await $.command.run(command('memory'))
  expect(last(seen)).toMatch(/cache HOT/)
})

test('a model switch invalidates the cache and names the cause (AC 2.4)', async ($, on) => {
  const seen = engine(on)
  on('classic.PostModelSwitch', () => ({}))
  placeSnapshot(seen)
  await $.session.start(START)
  await $.classic.PostModelSwitch(switched)
  expect(last(seen)).toMatch(/^✕ cache INVALIDATED · model switch · re-cache 812k/)
})

test('an effort change keeps the cache on Opus 5.5 with first-party auth (AC 2.5)', async ($, on) => {
  const seen = engine(on)
  on('command.run', () => ({ text: '' }))
  placeSnapshot(seen)
  await $.session.start(START)
  await $.command.run(command('effort', 'high'))
  expect(last(seen)).toMatch(/cache HOT/)
})

test('a TTL change between snapshots is recorded once (AC 1.3)', async ($, on) => {
  const seen = engine(on)
  placeSnapshot(seen)
  await $.session.start(START)
  for (const [i, ttl] of (['5m', '5m'] as const).entries()) {
    placeSnapshot(seen, { ttl, expires_at: T0 / 1000 + 240 }, T0 + (i + 1) * 5_000)
    await seen.clock.advance(5_000)
  }
  await seen.clock.advance(30_000)
  const history = [...seen.files.entries()].filter(([p]) => p.startsWith(`${DATA}/history/${SESSION}/`))
  const records = history.flatMap(([, f]) => JSON.parse(f.text).records as { type: string; event?: { kind: string } }[])
  expect(records.filter(r => r.type === 'event' && r.event?.kind === 'ttl_bucket_change').length).toBe(1)
})

test('history and the heartbeat hold no prompt or response text (AC 1.2, 20.3)', async ($, on) => {
  const seen = engine(on)
  stepsAnswer(on, 'SECRET-ANSWER-TEXT')
  on('turn.complete', (_, e) => ({ text: 'answer' in e ? e.answer : '' }))
  placeSnapshot(seen)
  await $.session.start(START)
  await $.prompt.submit(prompt('SECRET-PROMPT-TEXT'))
  await step($, 0)
  await $.turn.complete({ turnId: 't1', answer: 'SECRET-ANSWER-TEXT', durationMs: 1000, isAborted: false, reason: 'answer' })
  const written = [...seen.files.entries()].filter(([p]) => p.includes('/history/') || p.includes('/sessions/'))
  const chunk = written.find(([p]) => p.includes('/history/'))
  expect(chunk).toBeDefined()
  expect(JSON.parse(chunk![1].text).records[0].type).toBe('request')
  for (const [, f] of written) {
    expect(f.text).not.toContain('SECRET-PROMPT-TEXT')
    expect(f.text).not.toContain('SECRET-ANSWER-TEXT')
  }
  expect(seen.files.has(`${DATA}/sessions/${SESSION}/mod-heartbeat.json`)).toBe(true)
})
