import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { engine, prompt, SESSION, START, T0 } from './engine'
import type { Seen } from './engine'

const check = (args = '') => ({ command: 'cache-check', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 100 } })

/** The bridge's snapshot: warm on Opus 5.5 for another 48 minutes. */
function placeSnapshot(seen: Seen): void {
  const payload = { session_id: SESSION, model: { id: 'claude-opus-5-5' }, version: '2.1.332', prompt_cache: { warm: true, caching_observed: true, ttl: '1h', expires_at: T0 / 1000 + 48 * 60, recache_tokens_if_cold: 812470 } }
  seen.files.set(`/plugin-data/sessions/${SESSION}/snapshot.json`, { text: JSON.stringify({ v: 1, receivedAt: T0, payload }), mtimeMs: T0 })
}

/** Stand-ins for a turn: one main request and its completion. */
function turns(on: On): void {
  on('turn.complete', () => ({ text: '' }))
  on('ui.place', (_, e) => ({ value: { isPlaced: true as const, requestId: e.id } }))
  on('turn.step', async function* (_, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn' as const,
      usage: { input_tokens: 12, output_tokens: 900, cache_read_input_tokens: 809_458, cache_creation_input_tokens: 3_000, ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 3_000, model: 'claude-opus-5-5' },
    }
  })
}

/** A prompt, its request and its completion. */
async function exchange($: Engine, id: string): Promise<void> {
  await $.prompt.submit(prompt(`prompt ${id}`))
  const stream = $.turn.step({ turnId: id, index: 0, model: 'claude-opus-5-5', messageCount: 3 })
  for await (const _ of stream) {
    // Nothing streams.
  }
  await stream.result
  await $.turn.complete({ turnId: id, answer: '', durationMs: 1, isAborted: false, reason: 'answer' })
}

/** Debug-log entries naming a failure. */
const failures = (seen: Seen, where: string) => seen.logs.filter(l => l.to === 'debug' && l.text.startsWith(`Token Shield: ${where} failed`))

test('a failing snapshot reader leaves prompts, commands and the status line working, with one log entry (AC 21.3)', async ($, on) => {
  const seen = engine(on, { failStat: p => p.endsWith('/snapshot.json') })
  turns(on)
  placeSnapshot(seen)
  await $.session.start(START)
  for (let i = 0; i < 3; i++) {
    await exchange($, `t${i}`)
    await seen.clock.advance(20_000)
  }
  expect((await $.prompt.submit(prompt('still sends'))).text).toBe('still sends')
  expect((await $.command.run(check())).text).toMatch(/^Cache {2}/)
  expect(seen.statuses.at(-1)).toMatch(/cache/)
  expect(failures(seen, 'snapshot reader')).toHaveLength(1)
})

test('a failing history writer leaves turns, the status line and commands working, with one log entry (AC 21.3)', async ($, on) => {
  const seen = engine(on, { failWrite: p => p.includes('/history/') })
  turns(on)
  placeSnapshot(seen)
  await $.session.start(START)
  const before = seen.statuses.length
  for (let i = 0; i < 3; i++) {
    await exchange($, `t${i}`)
    await seen.clock.advance(31_000)
  }
  // Each completed turn still redraws the status line.
  expect(seen.statuses.length).toBeGreaterThanOrEqual(before + 3)
  expect((await $.command.run(check())).text).toMatch(/^Cache {2}/)
  expect(failures(seen, 'history writer')).toHaveLength(1)
})

test('a malformed history record is reported once, and the commands and pane still answer (AC 21.3)', async ($, on) => {
  const seen = engine(on)
  turns(on)
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  // A record written by something else: no usage at all.
  seen.files.set(`/plugin-data/history/${SESSION}/000000.json`, {
    text: JSON.stringify({ v: 1, session_id: SESSION, seq: 0, records: [{ type: 'request', request: { lane: 'main', tsStart: T0 - 60_000, model: 'claude-opus-5-5' } }, { type: 'request', request: { lane: 'main', tsStart: T0 - 30_000, model: 'claude-opus-5-5' } }] }),
    mtimeMs: T0,
  })
  placeSnapshot(seen)
  await $.session.start(START)
  for (let i = 0; i < 2; i++) {
    const answer = await $.command.run(check('history'))
    expect(answer.isTextDisplayOnly).toBe(true)
    expect(answer.text).toMatch(/^Token Shield: /)
  }
  await $.command.run({ command: 'cache-view', args: 'history', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
  const pane = await $.ui.mount({ plugin: 'token-shield', component: 'Pane', requestId: 'token-shield', surface: 'terminal', props: { title: 'Token Shield', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } })
  expect(await pane.find({ type: 'Text', text: /^History: loading/ })).toBeDefined()
  await pane.unmount()
  expect((await $.prompt.submit(prompt('still sends'))).text).toBe('still sends')
  expect(failures(seen, 'cache-check')).toHaveLength(1)
  expect(failures(seen, 'history dashboard')).toHaveLength(1)
})
