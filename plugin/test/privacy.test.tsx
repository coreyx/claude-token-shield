import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { engine, prompt, SESSION, START, T0 } from './engine'
import type { Seen } from './engine'

/** Text that must never reach anything Token Shield writes (REQ-1.0.2, 20.0.4). */
const PROMPT = 'PROMPT-SECRET-refactor the made-up billing module'
const ANSWER = 'ANSWER-SECRET-here is the made-up refactor'
const TOOL = 'TOOL-SECRET-/home/example/project/billing.ts'
const SECRETS = [PROMPT, ANSWER, TOOL, 'PROMPT-SECRET', 'ANSWER-SECRET', 'TOOL-SECRET']

const BAND = { plugin: 'token-shield', component: 'AbovePrompt', requestId: 'band', surface: 'terminal', props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 3, bodyColumns: 100, scroll: { offset: 0, bodyRows: 3 }, view: {} } } as const
const PANE = { plugin: 'token-shield', component: 'Pane', requestId: 'token-shield', surface: 'terminal', props: { title: 'Token Shield', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } } as const
const run = (command: string, args = '') => ({ command, args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 100 } })

/** The bridge's snapshot: warm on Opus 5.5 with `minutes` left. */
function placeSnapshot(seen: Seen, at: number, minutes: number): void {
  const payload = { session_id: SESSION, model: { id: 'claude-opus-5-5' }, version: '2.1.332', prompt_cache: { warm: true, caching_observed: true, ttl: '1h', expires_at: Math.floor(at / 1000) + minutes * 60, recache_tokens_if_cold: 812470 } }
  seen.files.set(`/plugin-data/sessions/${SESSION}/snapshot.json`, { text: JSON.stringify({ v: 1, receivedAt: at, payload }), mtimeMs: at })
}

/** A prompt, a main request whose answer and tool use carry the secrets, and its completion. */
async function exchange($: Engine, id: string): Promise<void> {
  // A prompt the gate holds (a lost cache) is sent again, as the person would.
  const first = await $.prompt.submit(prompt(`${PROMPT} ${id}`))
  const sent = first.drop !== undefined ? await $.prompt.submit(prompt(`${PROMPT} ${id}`)) : first
  expect(sent.text).toBe(`${PROMPT} ${id}`)
  const stream = $.turn.step({ turnId: id, index: 0, model: 'claude-opus-5-5', messageCount: 3 })
  for await (const _ of stream) {
    // Nothing streams.
  }
  await stream.result
  await $.turn.complete({ turnId: id, answer: ANSWER, durationMs: 4_000, isAborted: false, reason: 'answer' })
}

test('no prompt, answer or tool text reaches anything Token Shield writes, across every surface (AC 1.2, 20.3)', { timeoutMs: 60_000 }, async ($, on) => {
  const seen = engine(on, { env: { HOME: '/home/example' } })
  on('turn.complete', () => ({ text: '' }))
  on('command.run', () => ({ text: '' }))
  on('classic.PreModelSwitch', () => ({}))
  on('classic.PostModelSwitch', () => ({}))
  on('classic.SessionStart', () => ({}))
  on('ui.place', (_, e) => ({ value: { isPlaced: true as const, requestId: e.id } }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.panes', () => ({ value: [] as never }))
  on('prompt.fill', () => ({ isFilled: true }))
  on('session.usage', () => ({ value: { startedAt: T0, rateLimits: [], context: { window: 1_000_000, breakdown: { categories: [{ name: 'Messages', tokens: 800_000, color: '', isDeferred: false, kind: 'used' }] } } } as never }))
  on('model.fork', () => ({ value: { isAnswered: true as const, text: ANSWER, usage: { input_tokens: 9, output_tokens: 2, cache_read_input_tokens: 809_458, cache_creation_input_tokens: 3_003 } } }))
  on('turn.step', async function* (_, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: ANSWER,
      toolUses: [{ name: 'Edit', input: { file_path: TOOL, old_string: PROMPT, new_string: ANSWER } }],
      stopReason: 'end_turn' as const,
      usage: { input_tokens: 12, output_tokens: 900, cache_read_input_tokens: 809_458, cache_creation_input_tokens: 3_000, ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 3_000, model: 'claude-opus-5-5' },
    }
  })
  placeSnapshot(seen, T0, 48)
  await $.session.start(START)
  await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 600, context_tokens: 812470, prompt_cache_likely_expired: false })

  // Every surface: turns, the status line and band, toasts, the check in each mode, the pane's views,
  // the levers, the probe, a keep-alive, the TTL advisor and setting, the guard, history and calibration.
  await exchange($, 't1')
  for (const args of ['', '--verbose', '--diff', 'history', 'history --calibration', 'ttl']) await $.command.run(run('cache-check', args))
  const band = await $.ui.mount(BAND)
  await $.command.run(run('cache-check', '--probe --force'))
  await band.press({ key: 'confirm' })
  await $.command.run(run('cache-check', 'keepalive for 120m max $5'))
  await band.press({ key: 'confirm' })
  await exchange($, 't2')
  await $.command.run(run('cache-check', 'ttl 1h'))
  await band.press({ key: 'cancel' })
  await band.unmount()
  for (const view of ['map', 'runway', 'levers', 'context', 'history']) {
    await $.command.run(run('cache-view', view))
    const pane = await $.ui.mount(PANE)
    await pane.unmount()
  }
  await $.classic.PreModelSwitch({ from_model: 'claude-opus-5-5', to_model: 'claude-sonnet-5-5', requested_model: 'sonnet', source: 'command', context_tokens: 812470, prompt_cache_warm: true, cache_ttl: '1h', estimated_cache_write_usd: 6.5, pricing: 'catalog' })
  await $.classic.PostModelSwitch({ from_model: 'claude-opus-5-5', to_model: 'claude-sonnet-5-5', requested_model: 'sonnet', source: 'command', context_tokens: 812470, prompt_cache_warm: true, cache_ttl: '1h', estimated_cache_write_usd: 6.5, pricing: 'catalog' })
  await $.command.run(run('compact'))
  await exchange($, 't3')
  await seen.clock.advance(65 * 60_000)
  // The gate holds this one: cold now. Its text is still never kept.
  await $.prompt.submit(prompt(`${PROMPT} held`))
  await $.session.end({ reason: 'other', sessionId: SESSION, resume: { id: SESSION } })

  const written = [...seen.files.entries()].filter(([p]) => !p.endsWith(`/sessions/${SESSION}/snapshot.json`))
  // The scan covers real output: history, the heartbeat and the mirrored config at least.
  expect(written.some(([p]) => p.includes('/history/'))).toBe(true)
  expect(written.some(([p]) => p.endsWith('mod-heartbeat.json'))).toBe(true)
  for (const [path, file] of written) {
    for (const secret of SECRETS) expect(file.text.includes(secret), `${path} holds ${secret}`).toBe(false)
  }
  // Nor does any toast or debug-log line repeat them.
  for (const line of [...seen.toasts, ...seen.logs.map(l => l.text)]) {
    for (const secret of SECRETS) expect(line.includes(secret), `"${line}" holds ${secret}`).toBe(false)
  }
})
