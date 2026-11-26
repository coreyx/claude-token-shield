import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { engine, prompt, SESSION, START, T0 } from './engine'
import type { Seen } from './engine'

const HOME = '/home/example'
const SETTINGS = `${HOME}/.claude/settings.json`

/** The bridge's snapshot: warm on Opus 5.5 for another 48 minutes. */
function placeSnapshot(seen: Seen): void {
  const payload = {
    session_id: SESSION,
    model: { id: 'claude-opus-5-5' },
    version: '2.1.332',
    prompt_cache: { warm: true, caching_observed: true, ttl: '1h', expires_at: T0 / 1000 + 48 * 60, recache_tokens_if_cold: 812470 },
  }
  seen.files.set(`/plugin-data/sessions/${SESSION}/snapshot.json`, { text: JSON.stringify({ v: 1, receivedAt: T0, payload }), mtimeMs: T0 })
}

/**
 * Stand-ins for what levers reach, recording every command run, setting
 * set, prompt fill and model call, so a test can show nothing ran unasked.
 */
function actions(on: On, o: { failCommand?: boolean; configRows?: string[] } = {}) {
  const did = { commands: [] as string[], configSets: [] as string[], fills: [] as string[], models: 0, placed: [] as string[] }
  on('command.run', (_, e) => {
    did.commands.push(e.command)
    return o.failCommand === true ? { text: 'compaction failed: nothing to compact', exitCode: 1 } : { text: '' }
  })
  on('config.set', (_, e) => {
    did.configSets.push(`${e.key}=${String(e.value)}`)
    return { value: e.value }
  })
  on('config.describe', (_, e) => ({ label: e.label, isHidden: !(o.configRows ?? []).includes(e.key) && e.provider.plugin === 'engine' }))
  on('prompt.fill', (_, e) => {
    did.fills.push(e.text)
    return { isFilled: true }
  })
  // Any model call counts; none should happen, so each one fails loudly as well.
  const modelCall = (): never => {
    did.models += 1
    throw new Error('Token Shield made a model call')
  }
  on('model.fork', modelCall)
  on('model.complete', modelCall)
  on('model.classify', modelCall)
  on('ui.place', (_, e) => {
    did.placed.push(e.id)
    return { value: { isPlaced: true as const, requestId: e.id } }
  })
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
  return did
}

const check = (args = '') => ({ command: 'cache-check', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 100 } })
const BAR = { plugin: 'token-shield', component: 'Placed', requestId: 'token-shield-levers', surface: 'desktop', props: { id: 'token-shield-levers', plugin: 'token-shield' } } as const
const BAND = { plugin: 'token-shield', component: 'AbovePrompt', requestId: 'band', surface: 'terminal', props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 3, bodyColumns: 100, scroll: { offset: 0, bodyRows: 3 }, view: {} } } as const

/** Starts a session with the snapshot in place and the lever bar placed. */
async function started($: Engine, on: On, o: Parameters<typeof actions>[1] = {}) {
  const seen = engine(on, { env: { HOME } })
  const did = actions(on, o)
  placeSnapshot(seen)
  await $.session.start(START)
  await $.command.run(check())
  return { seen, did }
}

test('one compact press runs /compact, as typing it would, with no confirmation (AC 5.1, 17.1)', async ($, on) => {
  const { did } = await started($, on)
  const bar = await $.ui.mount(BAR)
  await bar.press({ key: 'compact' })
  expect(did.commands).toEqual(['compact'])
  await bar.unmount()
})

test('clear arms on one press and runs on a second within 3 s (AC 17.2)', async ($, on) => {
  const { seen, did } = await started($, on)
  const bar = await $.ui.mount(BAR)
  await bar.press({ key: 'clear' })
  expect(did.commands).toEqual([])
  const armed = await bar.find({ type: 'Text', text: 'CONFIRM?' })
  expect(armed?.props).toMatchObject({ inverse: true, bold: true })
  await seen.clock.advance(2_000)
  await bar.press({ key: 'clear' })
  expect(did.commands).toEqual(['clear'])
  await bar.unmount()
})

test('an armed clear disarms after 3 s, and the next press arms again (AC 17.3)', async ($, on) => {
  const { seen, did } = await started($, on)
  const bar = await $.ui.mount(BAR)
  await bar.press({ key: 'clear' })
  await seen.clock.advance(3_000)
  expect(await bar.find({ type: 'Text', text: 'CONFIRM?' })).toBeUndefined()
  expect((await bar.find({ key: 'clear' }))?.text).toBe('/clear')
  await bar.press({ key: 'clear' })
  expect(did.commands).toEqual([])
  expect(await bar.find({ type: 'Text', text: 'CONFIRM?' })).toBeDefined()
  await bar.unmount()
})

test('a failed lever is reported and changes nothing else (REQ-5.0.5)', async ($, on) => {
  const { seen, did } = await started($, on, { failCommand: true })
  const bar = await $.ui.mount(BAR)
  await bar.press({ key: 'compact' })
  expect(did.commands).toEqual(['compact'])
  expect(seen.toasts.some(t => /^Token Shield: \/compact didn't run \(compaction failed: nothing to compact\); nothing was changed\.$/.test(t))).toBe(true)
  expect(did.configSets).toEqual([])
  await bar.unmount()
})

test('a TTL lever shows key, scope and value, and the file is unchanged until Confirm (AC 5.2)', async ($, on) => {
  const { seen, did } = await started($, on)
  const before = '{\n  "theme": "dark"\n}\n'
  seen.files.set(SETTINGS, { text: before, mtimeMs: T0 })
  const { text } = await $.command.run(check('ttl 1h'))
  expect(text).toBe('Token Shield · set promptCacheTtl to "1h" in your user settings (~/.claude/settings.json)?')
  expect(seen.files.get(SETTINGS)?.text).toBe(before)
  await seen.clock.advance(60_000)
  expect(seen.files.get(SETTINGS)?.text).toBe(before)
  const band = await $.ui.mount(BAND)
  await band.press({ key: 'confirm' })
  expect(JSON.parse(seen.files.get(SETTINGS)!.text)).toEqual({ theme: 'dark', promptCacheTtl: '1h' })
  expect(did.configSets).toEqual([])
  expect(seen.toasts).toContain('Token Shield: promptCacheTtl is now "1h" in ~/.claude/settings.json.')
  await band.unmount()
})

test('Cancel leaves the settings file as it was', async ($, on) => {
  const { seen } = await started($, on)
  await $.command.run(check('ttl 5m --subagent'))
  const band = await $.ui.mount(BAND)
  await band.press({ key: 'cancel' })
  expect(seen.files.has(SETTINGS)).toBe(false)
  expect(seen.toasts).toContain('Token Shield: setting unchanged.')
  await band.unmount()
})

test('a settings file changed after it was shown is not written', async ($, on) => {
  const { seen } = await started($, on)
  seen.files.set(SETTINGS, { text: '{}', mtimeMs: T0 })
  await $.command.run(check('ttl 1h'))
  seen.files.set(SETTINGS, { text: '{ "theme": "light" }', mtimeMs: T0 + 1 })
  const band = await $.ui.mount(BAND)
  await band.press({ key: 'confirm' })
  expect(seen.files.get(SETTINGS)?.text).toBe('{ "theme": "light" }')
  expect(seen.toasts.some(t => /changed after it was shown/.test(t))).toBe(true)
  await band.unmount()
})

test('a settings file it cannot read faithfully gets the JSON to paste instead', async ($, on) => {
  const { seen } = await started($, on)
  const withComment = '{ // mine\n  "theme": "dark" }'
  seen.files.set(SETTINGS, { text: withComment, mtimeMs: T0 })
  await $.command.run(check('ttl 1h'))
  const band = await $.ui.mount(BAND)
  await band.press({ key: 'confirm' })
  expect(seen.files.get(SETTINGS)?.text).toBe(withComment)
  expect(seen.toasts.some(t => t.endsWith('add {"promptCacheTtl":"1h"}'))).toBe(true)
  await band.unmount()
})

test('no control is offered for a subagent (AC 17.4)', async ($, on) => {
  const seen = engine(on, { env: { HOME } })
  const did = actions(on)
  placeSnapshot(seen)
  await $.session.start(START)
  const stream = $.turn.step({ turnId: 'sub', index: 0, model: 'claude-opus-5-5', messageCount: 3, agentId: 'agent-1' })
  for await (const _ of stream) {
    // Nothing streams.
  }
  await stream.result
  expect(did.placed).toEqual([])
  const other = await $.ui.mount({ ...BAR, props: { id: 'token-shield-levers', plugin: 'another-plugin' } })
  expect(await other.find({ key: 'clear' })).toBeUndefined()
  await other.unmount()
})

// Hours of mock time tick every 5 s: allowed a minute on a slow CI runner.
test('a default-config session starts no compaction, clear, rewind, setting or API request by itself (AC 5.3)', { timeoutMs: 60_000 }, async ($, on) => {
  const seen = engine(on, { env: { HOME } })
  const did = actions(on)
  placeSnapshot(seen)
  await $.session.start(START)
  for (let turn = 0; turn < 3; turn++) {
    await $.prompt.submit(prompt('next step'))
    const stream = $.turn.step({ turnId: `t${turn}`, index: 0, model: 'claude-opus-5-5', messageCount: 3 + turn })
    for await (const _ of stream) {
      // Nothing streams.
    }
    await stream.result
    await $.turn.complete({ turnId: `t${turn}`, answer: '', durationMs: 1, isAborted: false, reason: 'answer' })
    await seen.clock.advance(40 * 60_000)
  }
  await seen.clock.advance(3 * 3_600_000)
  expect(did.commands).toEqual([])
  expect(did.configSets).toEqual([])
  expect(did.fills).toEqual([])
  expect(did.models).toBe(0)
  expect(seen.files.has(SETTINGS)).toBe(false)
})
