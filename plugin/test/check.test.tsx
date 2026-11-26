import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { engine, SESSION, START, T0 } from './engine'
import type { Seen } from './engine'

const DATA = '/plugin-data'

/** The bridge's snapshot: warm on Opus 5.5 for another 48 minutes. */
function placeSnapshot(seen: Seen, dataDir = DATA): void {
  const payload = {
    session_id: SESSION,
    model: { id: 'claude-opus-5-5' },
    version: '2.1.332',
    prompt_cache: { warm: true, caching_observed: true, ttl: '1h', expires_at: T0 / 1000 + 48 * 60, recache_tokens_if_cold: 812470 },
  }
  seen.files.set(`${dataDir}/sessions/${SESSION}/snapshot.json`, { text: JSON.stringify({ v: 1, receivedAt: T0, payload }), mtimeMs: T0 })
}

/** Stand-ins for the calls /cache-check and its UI make, recording each. */
function uiCalls(on: On) {
  const calls = { placed: [] as string[], opened: [] as string[], filled: [] as string[], models: 0 }
  on('ui.place', (_, e) => {
    calls.placed.push(e.id)
    return { value: { isPlaced: true as const, requestId: e.id } }
  })
  on('ui.open', (_, e) => {
    calls.opened.push(e.id)
    return { value: { isPlaced: true as const } }
  })
  on('prompt.fill', (_, e) => {
    calls.filled.push(e.text)
    return { isFilled: true }
  })
  on('model.fork', () => {
    calls.models += 1
    return { value: { isAnswered: false, reason: 'nothing-to-fork' as const } }
  })
  on('command.run', () => ({ text: '' }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>beneath</Text>
  })
  on('turn.step', async function* (_, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn' as const,
      usage: { input_tokens: 12, output_tokens: 900, cache_read_input_tokens: 809458, cache_creation_input_tokens: 3000, ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 3000, model: 'claude-opus-5-5' },
    }
  })
  return calls
}

const check = (args = '') => ({ command: 'cache-check', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 100 } })

/** Runs one model request through the plugin. */
async function step($: Engine): Promise<void> {
  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 3 })
  for await (const _ of stream) {
    // Nothing streams; the plugin records the result.
  }
  await stream.result
}

test('/cache-check answers display-only, places the lever bar, and calls no model (AC 6.1, 6.2)', async ($, on) => {
  const seen = engine(on)
  const calls = uiCalls(on)
  placeSnapshot(seen)
  await $.session.start(START)
  const answer = await $.command.run(check())
  expect(answer.isTextDisplayOnly).toBe(true)
  expect(answer.text).toMatch(/^Cache  HOT  · expected read ≥ 99%/)
  expect(answer.context ?? []).toEqual([])
  expect(calls.placed).toEqual(['token-shield-levers'])
  expect(calls.models).toBe(0)
})

test('mid-turn it answers empty and opens the pane instead (design D7)', async ($, on) => {
  const seen = engine(on)
  const calls = uiCalls(on)
  placeSnapshot(seen)
  await $.session.start(START)
  await step($)
  const answer = await $.command.run(check())
  expect(answer).toEqual({ text: '', isTextDisplayOnly: true })
  expect(calls.opened).toEqual(['token-shield'])
  const pane = await $.ui.mount({ plugin: 'token-shield', component: 'Pane', requestId: 'token-shield', surface: 'terminal', props: { title: 'Token Shield', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} } })
  expect((await pane.find({ type: 'Text', text: /^Cache  HOT/ }))?.text).toMatch(/expected read/)
  await pane.unmount()
})

test('verbose output tags every figure and shows the timeline and both expiries (AC 2.2, 6.3)', async ($, on) => {
  const seen = engine(on)
  uiCalls(on)
  placeSnapshot(seen)
  await $.session.start(START)
  await step($)
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 1, isAborted: false, reason: 'answer' })
  const { text } = await $.command.run(check('--verbose'))
  expect(text).toContain('Timeline (main conversation)')
  expect(text).toMatch(/Claude Code \d\d:\d\d:\d\d · Token Shield \d\d:\d\d:\d\d/)
  for (const line of (text ?? '').split('\n').slice(2).filter(l => /\d/.test(l) && !l.includes('start     gap'))) {
    expect(line).toMatch(/\[(measured|inferred|estimated)\]$/)
  }
})

test('--diff after a model switch names it (AC 6.4)', async ($, on) => {
  const seen = engine(on)
  uiCalls(on)
  on('classic.PostModelSwitch', () => ({}))
  placeSnapshot(seen)
  await $.session.start(START)
  await $.classic.PostModelSwitch({ from_model: 'claude-opus-5-5', to_model: 'claude-sonnet-5-5', requested_model: 'sonnet', source: 'command', context_tokens: 812470, prompt_cache_warm: true, cache_ttl: '1h', estimated_cache_write_usd: 3.25, pricing: 'catalog' })
  const { text } = await $.command.run(check('--diff'))
  expect(text).toContain('model: claude-opus-5-5 → claude-sonnet-5-5')
})

test('/cache-check setup asks in the band and runs tshield setup on Confirm', async ($, on) => {
  const seen = engine(on, { binary: true })
  uiCalls(on)
  placeSnapshot(seen, '/home/example/.token-shield')
  await $.session.start(START)
  const { text } = await $.command.run(check('setup'))
  expect(text).toMatch(/set up the statusline bridge\?/)
  const band = await $.ui.mount({ plugin: 'token-shield', component: 'AbovePrompt', requestId: 'band', surface: 'terminal', props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 3, bodyColumns: 100, scroll: { offset: 0, bodyRows: 3 }, view: {} } })
  await band.press({ key: 'confirm' })
  expect(seen.runs.some(r => r[1] === 'setup' && r[2] === '--yes')).toBe(true)
  expect(seen.toasts.some(t => /setup didn't complete|bridge is set up/.test(t))).toBe(true)
  await band.unmount()
})

test('an unknown option says what works', async ($, on) => {
  const seen = engine(on)
  uiCalls(on)
  placeSnapshot(seen)
  await $.session.start(START)
  expect((await $.command.run(check('--bogus'))).text).toMatch(/unknown \/cache-check option --bogus/)
})
