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

test('the runway shows now inside the warn window, and redraws while shown (AC 13.2)', async ($, on) => {
  const seen = engine(on)
  beneath(on, [])
  on('ui.panes', () => ({ value: [{ id: 'token-shield', title: 'Token Shield', isShown: true, isFocused: true, isPlaced: true }] as never }))
  // Warm for 8 more minutes: inside the 10-minute warn window.
  const payload = { session_id: SESSION, model: { id: 'claude-opus-5-5' }, version: '2.1.332', prompt_cache: { warm: true, caching_observed: true, ttl: '1h', expires_at: T0 / 1000 + 8 * 60, recache_tokens_if_cold: 812470 } }
  seen.files.set(`/plugin-data/sessions/${SESSION}/snapshot.json`, { text: JSON.stringify({ v: 1, receivedAt: T0, payload }), mtimeMs: T0 })
  await $.session.start(START)
  await $.command.run(view('runway'))
  const pane = await $.ui.mount(PANE(100))
  expect(await pane.find({ type: 'Text', text: /^Expiry runway · cache EXPIRING$/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /^Act before \d\d:\d\d ≈ \$0\.\d\d · after ≈ \$6\.50$/ })).toBeDefined()
  const before = (await pane.find({ type: 'Text', text: /▲now/ }))!.text!.indexOf('▲')
  await seen.clock.advance(4 * 60_000)
  const after = (await pane.find({ type: 'Text', text: /▲now/ }))!.text!.indexOf('▲')
  expect(after).toBeGreaterThan(before)
  await pane.unmount()
})

test('the context view counts the prefix off the render path, and the map gains its layer ruler (REQ-13.0.4)', async ($, on) => {
  const seen = engine(on)
  beneath(on, [{ read: 780_000, write: 20_000 }])
  let counted = 0
  on('session.usage', () => {
    counted += 1
    return {
      value: {
        startedAt: T0,
        rateLimits: [],
        context: {
          window: 1_000_000,
          breakdown: {
            categories: [
              { name: 'System prompt', tokens: 3_000, color: '', isDeferred: false, kind: 'used' },
              { name: 'System tools', tokens: 15_000, color: '', isDeferred: false, kind: 'used' },
              { name: 'Memory files', tokens: 4_000, color: '', isDeferred: false, kind: 'used' },
              { name: 'Messages', tokens: 780_000, color: '', isDeferred: false, kind: 'used' },
            ],
          },
        },
      } as never,
    }
  })
  placeSnapshot(seen)
  await $.session.start(START)
  await turn($, 't1')
  await $.command.run(view('context'))
  expect(counted).toBe(1)
  const pane = await $.ui.mount(PANE(100))
  expect(await pane.find({ type: 'Text', text: /^Messages +█+ +780k {2}changes each turn$/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /^System tools +█+ +15k {2}stable$/ })).toBeDefined()
  await pane.press({ key: 'tab:map' })
  expect(await pane.find({ type: 'Text', text: /s system\+tools 18k {2}p project 4k {2}c conversation 780k/ })).toBeDefined()
  await pane.unmount()
})
