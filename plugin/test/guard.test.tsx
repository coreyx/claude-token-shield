import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { engine, prompt, SESSION, START, T0 } from './engine'
import type { Seen } from './engine'

/**
 * The bridge's snapshot: warm or cold on a model with a 1h TTL, optionally
 * with rate limits (a subscription), taken at `at`.
 */
function placeSnapshot(seen: Seen, o: { warm?: boolean; model?: string; subscription?: boolean; at?: number } = {}): void {
  const at = o.at ?? T0
  const warm = o.warm ?? true
  const payload = {
    session_id: SESSION,
    model: { id: o.model ?? 'claude-opus-5-5' },
    version: '2.1.332',
    prompt_cache: { warm, caching_observed: true, ttl: '1h', expires_at: warm ? T0 / 1000 + 48 * 60 : null, recache_tokens_if_cold: 812470 },
    ...(o.subscription === true ? { rate_limits: { five_hour: { used_percentage: 12, resets_at: T0 / 1000 + 3600 }, seven_day: { used_percentage: 30, resets_at: T0 / 1000 + 86400 } } } : {}),
  }
  seen.files.set(`/plugin-data/sessions/${SESSION}/snapshot.json`, { text: JSON.stringify({ v: 1, receivedAt: at, payload }), mtimeMs: at })
}

/** Stand-ins for what lies beneath the guard: Claude Code's own switch flow, commands and settings. */
function beneath(on: On, o: { deny?: boolean } = {}): void {
  on('classic.PreModelSwitch', () => (o.deny === true ? { permissionDecision: 'deny' as const, permissionDecisionReason: 'organization policy' } : {}))
  on('classic.PostModelSwitch', () => ({}))
  on('command.run', () => ({ text: '' }))
  on('config.set', (_, e) => ({ value: e.value }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>beneath</Text>
  })
}

/** A PreModelSwitch event as Claude Code fires it, Opus to Sonnet with a warm 812k cache by default. */
const pre = (over: Partial<Parameters<Engine['classic']['PreModelSwitch']>[0]> = {}) => ({
  from_model: 'claude-opus-5-5',
  to_model: 'claude-sonnet-5-5',
  requested_model: 'sonnet',
  source: 'command' as const,
  context_tokens: 812470,
  prompt_cache_warm: true,
  cache_ttl: '1h' as const,
  estimated_cache_write_usd: 6.5,
  pricing: 'catalog' as const,
  ...over,
})

const BAND = { plugin: 'token-shield', component: 'AbovePrompt', requestId: 'band', surface: 'terminal', props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 3, bodyColumns: 100, scroll: { offset: 0, bodyRows: 3 }, view: {} } } as const

const SWITCH_TOAST =
  'Token Shield: switching to claude-sonnet-5-5 rebuilds the cache (812,470 tokens) ≈ $6.50. Cheaper for a one-off task: run it in a subagent on claude-sonnet-5-5.'

test('a warm 812k switch keeps Claude Code confirmation and adds the labelled cost for 30 s (AC 10.1, 10.4, 10.6)', async ($, on) => {
  const seen = engine(on)
  beneath(on)
  placeSnapshot(seen)
  await $.session.start(START)
  const result = await $.classic.PreModelSwitch(pre())
  expect(result).toEqual({})
  expect(seen.toasts).toEqual([SWITCH_TOAST])
  expect(seen.toastTimeouts).toEqual([30_000])
  const band = await $.ui.mount(BAND)
  expect((await band.find({ type: 'Text', text: /^Token Shield: switching/ }))?.text).toBe(SWITCH_TOAST)
  await band.unmount()
})

test('a cold switch shows nothing (AC 10.2)', async ($, on) => {
  const seen = engine(on)
  beneath(on)
  placeSnapshot(seen, { warm: false })
  await $.session.start(START)
  const before = seen.toasts.length
  expect(await $.classic.PreModelSwitch(pre({ prompt_cache_warm: false }))).toEqual({})
  expect(seen.toasts.length).toBe(before)
})

test('a paired event burst gives one toast, for the target requested', async ($, on) => {
  const seen = engine(on)
  beneath(on)
  placeSnapshot(seen)
  await $.session.start(START)
  await $.classic.PreModelSwitch(pre({ to_model: 'claude-haiku-5-5', requested_model: 'haiku', estimated_cache_write_usd: 0.12 }))
  await $.classic.PreModelSwitch(pre({ to_model: 'claude-sonnet-5-5', requested_model: 'haiku' }))
  expect(seen.toasts).toHaveLength(1)
  expect(seen.toasts[0]).toContain('switching to claude-haiku-5-5')
  expect(seen.logs.some(l => /not shown \(not-requested\)/.test(l.text))).toBe(true)
})

test('the picker pair, with no request, gives one toast', async ($, on) => {
  const seen = engine(on)
  beneath(on)
  placeSnapshot(seen)
  await $.session.start(START)
  await $.classic.PreModelSwitch(pre({ requested_model: null, source: 'picker' }))
  await $.classic.PreModelSwitch(pre({ requested_model: null, source: 'picker', to_model: 'claude-haiku-5-5' }))
  expect(seen.toasts).toHaveLength(1)
})

test('a same-model pick shows nothing', async ($, on) => {
  const seen = engine(on)
  beneath(on)
  placeSnapshot(seen)
  await $.session.start(START)
  await $.classic.PreModelSwitch(pre({ to_model: 'claude-opus-5-5', requested_model: 'opus' }))
  expect(seen.toasts).toEqual([])
})

test('with switchConfirm on, a warm over-threshold switch asks with the labelled reason (AC 10.5)', { options: { switchConfirm: 'on' } }, async ($, on) => {
  const seen = engine(on)
  beneath(on)
  placeSnapshot(seen)
  await $.session.start(START)
  expect(await $.classic.PreModelSwitch(pre())).toEqual({
    permissionDecision: 'ask',
    permissionDecisionReason: 'Token Shield: this switch rebuilds the cache (812,470 tokens), ≈ $6.50.',
  })
})

test('with switchConfirm on, a cold or under-threshold switch adds no confirmation (AC 10.6)', { options: { switchConfirm: 'on' } }, async ($, on) => {
  const seen = engine(on)
  beneath(on)
  placeSnapshot(seen)
  await $.session.start(START)
  expect(await $.classic.PreModelSwitch(pre({ context_tokens: 40_000, estimated_cache_write_usd: 0.5 }))).toEqual({})
  await seen.clock.advance(5_000)
  expect(await $.classic.PreModelSwitch(pre({ prompt_cache_warm: false }))).toEqual({})
})

test('a deny from beneath stands; the guard never allows or denies', { options: { switchConfirm: 'on' } }, async ($, on) => {
  const seen = engine(on)
  beneath(on, { deny: true })
  placeSnapshot(seen)
  await $.session.start(START)
  expect(await $.classic.PreModelSwitch(pre())).toEqual({ permissionDecision: 'deny', permissionDecisionReason: 'organization policy' })
})

/** Starts a warm session, shows a switch, and returns a check for the guard band. */
async function shownSwitch($: Engine, on: On) {
  const seen = engine(on)
  beneath(on)
  placeSnapshot(seen)
  await $.session.start(START)
  const band = await $.ui.mount(BAND)
  await $.classic.PreModelSwitch(pre())
  const guardShown = async () => (await band.find({ type: 'Text', text: /^Token Shield: switching/ })) !== undefined
  expect(await guardShown()).toBe(true)
  return { seen, band, guardShown }
}

test('the guard band clears when the switch completes', async ($, on) => {
  const { band, guardShown } = await shownSwitch($, on)
  await $.classic.PostModelSwitch({ from_model: 'claude-opus-5-5', to_model: 'claude-sonnet-5-5', requested_model: 'sonnet', source: 'command', context_tokens: 812470, prompt_cache_warm: true, cache_ttl: '1h', estimated_cache_write_usd: 6.5, pricing: 'catalog' })
  expect(await guardShown()).toBe(false)
  await band.unmount()
})

test('the guard band clears on the next prompt', async ($, on) => {
  const { band, guardShown } = await shownSwitch($, on)
  await $.prompt.submit(prompt('carry on'))
  expect(await guardShown()).toBe(false)
  await band.unmount()
})

test('the guard band clears when a later snapshot shows the switch was cancelled', async ($, on) => {
  const { seen, band, guardShown } = await shownSwitch($, on)
  // A redraw alone keeps it: the cache is still warm.
  await seen.clock.advance(6_000)
  expect(await guardShown()).toBe(true)
  // Claude Code fires nothing on cancel; the next snapshot still reports Opus.
  placeSnapshot(seen, { at: seen.clock.now() })
  await seen.clock.advance(5_000)
  expect(await guardShown()).toBe(false)
  await band.unmount()
})

const effort = (args: string) => ({ command: 'effort', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 100 } })

test('an effort change on Opus 5.5 with a subscription shows nothing (AC 10.3)', async ($, on) => {
  const seen = engine(on)
  beneath(on)
  placeSnapshot(seen, { subscription: true })
  await $.session.start(START)
  await $.command.run(effort('high'))
  expect(seen.toasts).toEqual([])
})

test('an effort change on Sonnet 5 shows the rebuild cost before the next request (AC 10.3)', async ($, on) => {
  const seen = engine(on, { model: 'claude-sonnet-5' })
  beneath(on)
  placeSnapshot(seen, { model: 'claude-sonnet-5' })
  await $.session.start(START)
  await $.command.run(effort('high'))
  // One toast for the action: the INVALIDATED transition it causes stays quiet.
  expect(seen.toasts).toHaveLength(1)
  expect(seen.toasts[0]).toMatch(/^Token Shield: this effort change rebuilds the cache on the next request ≈ \$\d+\.\d\d\.$/)
})

test('the matching config.set is weighed like the command', async ($, on) => {
  const seen = engine(on, { model: 'claude-sonnet-5' })
  beneath(on)
  placeSnapshot(seen, { model: 'claude-sonnet-5' })
  await $.session.start(START)
  await $.config.set({ key: 'fastMode', value: true, previous: false, provider: { plugin: 'engine', tier: 'core' }, origin: { kind: 'composer' } })
  expect(seen.toasts).toHaveLength(1)
  expect(seen.toasts[0]).toMatch(/^Token Shield: toggling fast mode rebuilds the cache/)
})

test('fast mode warns while warm; a plugin reload gives an info toast; nothing once cold', async ($, on) => {
  const seen = engine(on)
  beneath(on)
  placeSnapshot(seen)
  await $.session.start(START)
  const run = (command: string) => $.command.run({ command, args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
  await run('reload-plugins')
  // One toast for the action: the UNCERTAIN transition it causes stays quiet.
  expect(seen.toasts).toEqual(['Token Shield: reloading plugins may rebuild the cache if tool definitions change.'])
  placeSnapshot(seen, { warm: false, at: T0 + 10_000 })
  await seen.clock.advance(10_000)
  await run('fast')
  expect(seen.toasts.filter(x => /fast mode/.test(x))).toEqual([])
})
