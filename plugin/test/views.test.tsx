import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { engine, SESSION, START, T0 } from './engine'
import type { Seen } from './engine'

const view = (args: string) => ({ command: 'cache-view', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 100 } })
const PANE = (bodyColumns: number) =>
  ({ plugin: 'token-shield', component: 'Pane', requestId: 'token-shield', surface: 'terminal', props: { title: 'Token Shield', isFocused: true, bodyColumns, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } }) as const

/** The bridge's snapshot: warm on Opus 5.5 for another 48 minutes. */
function placeSnapshot(seen: Seen): void {
  const payload = { session_id: SESSION, model: { id: 'claude-opus-5-5' }, version: '2.1.332', prompt_cache: { warm: true, caching_observed: true, ttl: '1h', expires_at: T0 / 1000 + 48 * 60, recache_tokens_if_cold: 812470 } }
  seen.files.set(`/plugin-data/sessions/${SESSION}/snapshot.json`, { text: JSON.stringify({ v: 1, receivedAt: T0, payload }), mtimeMs: T0 })
}

/** Stand-ins, with each main request answering the usages given in turn. */
function beneath(on: On, usages: { read: number; write: number }[]) {
  const opened: string[] = []
  let i = 0
  on('ui.open', (_, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true as const } }
  })
  on('turn.complete', () => ({ text: '' }))
  on('turn.step', async function* (_, e) {
    const u = usages[Math.min(i++, usages.length - 1)]!
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn' as const,
      usage: { input_tokens: 10, output_tokens: 500, cache_read_input_tokens: u.read, cache_creation_input_tokens: u.write, ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: u.write, model: 'claude-opus-5-5' },
    }
  })
  return opened
}

/** Runs one main request and completes its turn. */
async function turn($: Engine, id: string): Promise<void> {
  const stream = $.turn.step({ turnId: id, index: 0, model: 'claude-opus-5-5', messageCount: 3 })
  for await (const _ of stream) {
    // Nothing streams.
  }
  await stream.result
  await $.turn.complete({ turnId: id, answer: '', durationMs: 1, isAborted: false, reason: 'answer' })
}

test('/cache-view opens the pane on the prefix map, with tabs to move between views (REQ-13)', async ($, on) => {
  const seen = engine(on)
  const opened = beneath(on, [
    { read: 780_000, write: 20_000 },
    { read: 800_000, write: 6_000 },
  ])
  placeSnapshot(seen)
  await $.session.start(START)
  await turn($, 't1')
  await seen.clock.advance(120_000)
  await turn($, 't2')
  const answer = await $.command.run(view(''))
  expect(answer).toEqual({ text: 'Token Shield: the Prefix map view is open in the Token Shield pane.', isTextDisplayOnly: true })
  expect(opened).toEqual(['token-shield'])
  for (const width of [80, 120]) {
    const pane = await $.ui.mount(PANE(width))
    expect((await pane.find({ key: 'tab:map' }))?.text).toBe('[Prefix map]')
    expect(await pane.find({ type: 'Text', text: /^Prefix map · the last 2 main requests$/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /^\d\d:\d\d:\d\d +80\dk █+/ })).toBeDefined()
    await pane.unmount()
  }
  const pane = await $.ui.mount(PANE(100))
  await pane.press({ key: 'tab:runway' })
  expect((await pane.find({ key: 'tab:runway' }))?.text).toBe('[Runway]')
  await pane.unmount()
})

test('/cache-view with an unknown view says which there are', async ($, on) => {
  engine(on)
  beneath(on, [])
  await $.session.start(START)
  expect((await $.command.run(view('graphs'))).text).toBe('Token Shield: /cache-view map|runway|levers|context|history')
})
