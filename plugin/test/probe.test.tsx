import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { engine, SESSION, START, T0 } from './engine'
import type { Seen } from './engine'

const BAND = { plugin: 'token-shield', component: 'AbovePrompt', requestId: 'band', surface: 'terminal', props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 3, bodyColumns: 100, scroll: { offset: 0, bodyRows: 3 }, view: {} } } as const
const check = (args: string) => ({ command: 'cache-check', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 100 } })

/** The bridge's snapshot on Opus 5.5, 1h TTL: `expiresInSec` from T0, or cold. */
function placeSnapshot(seen: Seen, expiresInSec: number | 'cold'): void {
  const warm = expiresInSec !== 'cold'
  const payload = {
    session_id: SESSION,
    model: { id: 'claude-opus-5-5' },
    version: '2.1.332',
    prompt_cache: { warm, caching_observed: true, ttl: '1h', expires_at: warm ? T0 / 1000 + expiresInSec : null, recache_tokens_if_cold: 812470 },
  }
  seen.files.set(`/plugin-data/sessions/${SESSION}/snapshot.json`, { text: JSON.stringify({ v: 1, receivedAt: T0, payload }), mtimeMs: T0 })
}

type Fork = { isAnswered: true; text: string; usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number } } | { isAnswered: false; reason: 'nothing-to-fork' } | { isAnswered: false; reason: 'api-error'; status: number; error: string }

/** Stand-ins, with the fork answering `answer` and counting its calls. */
function beneath(on: On, answer: Fork) {
  const forks: { prompt: string; effort?: unknown }[] = []
  on('model.fork', (_, e) => {
    forks.push({ prompt: e.prompt, ...(e.effort !== undefined ? { effort: e.effort } : {}) })
    return { value: answer as never }
  })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>beneath</Text>
  })
  on('ui.place', (_, e) => ({ value: { isPlaced: true as const, requestId: e.id } }))
  return forks
}

const HIT: Fork = { isAnswered: true, text: 'OK', usage: { input_tokens: 9, output_tokens: 2, cache_read_input_tokens: 809_458, cache_creation_input_tokens: 3_003 } }

test('--probe in UNCERTAIN shows both prices and the side effect, and sends nothing until Confirm (AC 7.1)', async ($, on) => {
  const seen = engine(on)
  const forks = beneath(on, HIT)
  placeSnapshot(seen, 3)
  await $.session.start(START)
  expect(seen.statuses[seen.statuses.length - 1]).toMatch(/UNCERTAIN/)
  const { text } = await $.command.run(check('--probe'))
  expect(text).toMatch(/^Token Shield · probe now\? It re-sends the cached prefix \(812,470 tokens\) with a one-line prompt: ≈ \$0\.\d\d if warm, ≈ \$6\.50 if cold, and the cache is warm afterwards either way\.$/)
  await seen.clock.advance(60_000)
  expect(forks).toEqual([])
})

test('Cancel sends nothing', async ($, on) => {
  const seen = engine(on)
  const forks = beneath(on, HIT)
  placeSnapshot(seen, 3)
  await $.session.start(START)
  await $.command.run(check('--probe'))
  const band = await $.ui.mount(BAND)
  await band.press({ key: 'cancel' })
  expect(forks).toEqual([])
  expect(seen.toasts).toContain('Token Shield: probe cancelled; nothing was sent.')
  await band.unmount()
})

test('a confirmed probe on a warm cache reports a hit, the measured usage, its cost and an expiry one TTL later (AC 7.2)', async ($, on) => {
  const seen = engine(on)
  const forks = beneath(on, HIT)
  placeSnapshot(seen, 3)
  await $.session.start(START)
  await $.command.run(check('--probe'))
  const band = await $.ui.mount(BAND)
  await band.press({ key: 'confirm' })
  // One minimal fork, at the session's own effort.
  expect(forks).toEqual([{ prompt: 'Reply with OK.' }])
  const at = T0 + 3_600_000
  const until = new Date(at - new Date(at).getTimezoneOffset() * 60_000).toISOString().slice(11, 16)
  const result = seen.toasts.find(t => t.startsWith('Token Shield: probe hit'))
  expect(result).toMatch(new RegExp(`^Token Shield: probe hit: 809,458 tokens read from cache, 3,003 written, 9 uncached; cost \\$0\\.\\d\\d\\. Warm until ${until}\\.$`))
  // Recorded for calibration on the probe lane.
  await seen.clock.advance(31_000)
  const chunk = [...seen.files.entries()].find(([p]) => p.startsWith(`/plugin-data/history/${SESSION}/`))
  expect(JSON.parse(chunk![1].text).records.some((r: { type: string; request?: { lane: string } }) => r.type === 'request' && r.request?.lane === 'probe')).toBe(true)
  await band.unmount()
})

test('--probe on COLD with HIGH confidence is declined with the reason; --force reaches Confirm (AC 7.3)', async ($, on) => {
  const seen = engine(on)
  const forks = beneath(on, HIT)
  placeSnapshot(seen, 'cold')
  await $.session.start(START)
  expect((await $.command.run(check('--probe'))).text).toBe(
    'Token Shield: no probe: the cache is already lost, so a probe would just pay the rebuild. Add --force to probe anyway.',
  )
  expect((await $.command.run(check('--probe --force'))).text).toMatch(/^Token Shield · probe now\?/)
  expect(forks).toEqual([])
})

test('--probe on HOT with more than 5 minutes left is declined', async ($, on) => {
  const seen = engine(on)
  beneath(on, HIT)
  placeSnapshot(seen, 48 * 60)
  await $.session.start(START)
  expect((await $.command.run(check('--probe'))).text).toMatch(/^Token Shield: no probe: the cache is warm with more than 5 minutes left/)
})

test('nothing to fork is reported and changes nothing (REQ-7.0.5)', async ($, on) => {
  const seen = engine(on)
  beneath(on, { isAnswered: false, reason: 'nothing-to-fork' })
  placeSnapshot(seen, 3)
  await $.session.start(START)
  const before = seen.statuses[seen.statuses.length - 1]
  await $.command.run(check('--probe'))
  const band = await $.ui.mount(BAND)
  await band.press({ key: 'confirm' })
  expect(seen.toasts.some(t => /^Token Shield: no probe was possible/.test(t))).toBe(true)
  expect(seen.statuses[seen.statuses.length - 1]).toBe(before)
  await band.unmount()
})

test('an API error from the fork is reported and changes nothing', async ($, on) => {
  const seen = engine(on)
  beneath(on, { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded_error' })
  placeSnapshot(seen, 3)
  await $.session.start(START)
  const before = seen.statuses[seen.statuses.length - 1]
  await $.command.run(check('--probe'))
  const band = await $.ui.mount(BAND)
  await band.press({ key: 'confirm' })
  expect(seen.toasts).toContain("Token Shield: the probe didn't complete (API error 529); nothing changed.")
  expect(seen.statuses[seen.statuses.length - 1]).toBe(before)
  await band.unmount()
})
