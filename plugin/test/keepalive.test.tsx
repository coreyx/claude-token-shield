import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { engine, prompt, SESSION, START, T0 } from './engine'
import type { Seen } from './engine'

const BAND = { plugin: 'token-shield', component: 'AbovePrompt', requestId: 'band', surface: 'terminal', props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 3, bodyColumns: 100, scroll: { offset: 0, bodyRows: 3 }, view: {} } } as const
const check = (args: string) => ({ command: 'cache-check', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 100 } })

/** The bridge's snapshot on Opus 5.5: warm for `expiresInSec` more, or cold. */
function placeSnapshot(seen: Seen, ttl: '5m' | '1h', expiresInSec: number | 'cold'): void {
  const warm = expiresInSec !== 'cold'
  const payload = {
    session_id: SESSION,
    model: { id: 'claude-opus-5-5' },
    version: '2.1.332',
    prompt_cache: { warm, caching_observed: true, ttl, expires_at: warm ? T0 / 1000 + expiresInSec : null, recache_tokens_if_cold: 812470 },
  }
  seen.files.set(`/plugin-data/sessions/${SESSION}/snapshot.json`, { text: JSON.stringify({ v: 1, receivedAt: T0, payload }), mtimeMs: T0 })
}

/**
 * Stand-ins, with the fork answering each refresh with the next usage in
 * `usages` (cycling), so refresh costs vary as real ones do.
 */
function beneath(on: On, usages: { read: number; write: number; output: number }[]) {
  const forks: number[] = []
  on('model.fork', () => {
    const u = usages[forks.length % usages.length]!
    forks.push(forks.length)
    return { value: { isAnswered: true as const, text: 'OK', usage: { input_tokens: 9, output_tokens: u.output, cache_read_input_tokens: u.read, cache_creation_input_tokens: u.write } } }
  })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>beneath</Text>
  })
  on('ui.place', (_, e) => ({ value: { isPlaced: true as const, requestId: e.id } }))
  return forks
}

/** Refresh usages a little either side of the quote: more writes, longer replies. */
const VARIED = [
  { read: 809_458, write: 3_012, output: 2 },
  { read: 806_100, write: 6_400, output: 12 },
  { read: 811_000, write: 1_500, output: 4 },
  { read: 804_000, write: 8_500, output: 30 },
]

/** The dollars a stop toast reports. */
const spentIn = (toasts: readonly string[]) => Number(/it spent \$(\d+\.\d\d)/.exec(toasts.find(t => /keep-alive (stopped|finished)/.test(t)) ?? '')?.[1] ?? NaN)

test('the estimate is shown before it starts, and nothing is sent until Confirm (REQ-15.0.2)', async ($, on) => {
  const seen = engine(on)
  const forks = beneath(on, VARIED)
  placeSnapshot(seen, '1h', 10 * 60)
  await $.session.start(START)
  const { text } = await $.command.run(check('keepalive for 90m max $1'))
  expect(text).toMatch(/^Token Shield · keep the cache warm until \d\d:\d\d, spending at most \$1\.00\? About 2 refreshes at ≈ \$0\.\d\d each, ≈ \$0\.\d\d in all\. Sending a prompt stops it\.$/)
  await seen.clock.advance(30 * 60_000)
  expect(forks).toEqual([])
})

test('a $1 keep-alive never spends more than $1 with varied refresh costs (AC 15.1)', { timeoutMs: 60_000 }, async ($, on) => {
  const seen = engine(on)
  const forks = beneath(on, VARIED)
  placeSnapshot(seen, '5m', 4 * 60)
  await $.session.start(START)
  await $.command.run(check('keepalive for 120m max $1'))
  const band = await $.ui.mount(BAND)
  await band.press({ key: 'confirm' })
  expect((await band.find({ type: 'Text', text: /keeping the cache warm/ }))?.text).toMatch(/\$0\.00 of \$1\.00 spent/)
  await seen.clock.advance(5 * 60_000)
  expect((await band.find({ type: 'Text', text: /keeping the cache warm/ }))?.text).toMatch(/\$0\.[1-9]\d of \$1\.00 spent/)
  await seen.clock.advance(120 * 60_000)
  expect(forks.length).toBeGreaterThan(2)
  expect(seen.toasts.some(t => /keep-alive stopped: the next refresh could pass the \$1\.00 budget/.test(t))).toBe(true)
  expect(spentIn(seen.toasts)).toBeLessThanOrEqual(1)
  // Each refresh is recorded on its own lane.
  const records = [...seen.files.entries()].filter(([p]) => p.includes('/history/')).flatMap(([, f]) => JSON.parse(f.text).records as { type: string; request?: { lane: string } }[])
  expect(records.filter(r => r.request?.lane === 'keepalive')).toHaveLength(forks.length)
  await band.unmount()
})

test('sending a prompt stops it before its next refresh (AC 15.2)', async ($, on) => {
  const seen = engine(on)
  const forks = beneath(on, VARIED)
  placeSnapshot(seen, '1h', 10 * 60)
  await $.session.start(START)
  await $.command.run(check('keepalive for 90m'))
  const band = await $.ui.mount(BAND)
  await band.press({ key: 'confirm' })
  await seen.clock.advance(5 * 60_000)
  await $.prompt.submit(prompt("I'm back"))
  expect(seen.toasts.some(t => t.startsWith("Token Shield: keep-alive stopped because you're back; it spent $0.00."))).toBe(true)
  await seen.clock.advance(120 * 60_000)
  expect(forks).toEqual([])
  expect(await band.find({ type: 'Text', text: /keeping the cache warm/ })).toBeUndefined()
  await band.unmount()
})

test('a refresh that misses stops it: the cache was already lost', async ($, on) => {
  const seen = engine(on)
  const forks = beneath(on, [{ read: 0, write: 812_000, output: 2 }])
  placeSnapshot(seen, '1h', 60)
  await $.session.start(START)
  await $.command.run(check('keepalive for 90m max $10'))
  const band = await $.ui.mount(BAND)
  await band.press({ key: 'confirm' })
  await seen.clock.advance(120 * 60_000)
  expect(forks).toHaveLength(1)
  expect(seen.toasts.some(t => /keep-alive stopped: a refresh found the cache already lost/.test(t))).toBe(true)
  await band.unmount()
})

test('Stop and the stop command end it; Cancel never starts it; a lost cache is refused', async ($, on) => {
  const seen = engine(on)
  const forks = beneath(on, VARIED)
  placeSnapshot(seen, '1h', 10 * 60)
  await $.session.start(START)
  const band = await $.ui.mount(BAND)

  await $.command.run(check('keepalive'))
  await band.press({ key: 'cancel' })
  expect(seen.toasts).toContain('Token Shield: keep-alive not started.')

  await $.command.run(check('keepalive'))
  await band.press({ key: 'confirm' })
  await band.press({ key: 'stop' })
  expect(seen.toasts).toContain('Token Shield: keep-alive stopped; it spent $0.00.')
  expect((await $.command.run(check('keepalive stop'))).text).toBe('Token Shield: no keep-alive is running.')
  expect((await $.command.run(check('keepalive whenever'))).text).toMatch(/^Token Shield: \/cache-check keepalive \[until HH:MM/)
  await seen.clock.advance(60 * 60_000)
  expect(forks).toEqual([])
  await band.unmount()

  placeSnapshot(seen, '1h', 'cold')
  await seen.clock.advance(6_000)
  expect((await $.command.run(check('keepalive'))).text).toBe('Token Shield: no keep-alive: the cache is already lost, so a refresh would pay the rebuild.')
})

test('the EXPIRING band offers Keep warm, which asks before anything runs', async ($, on) => {
  const seen = engine(on)
  const forks = beneath(on, VARIED)
  placeSnapshot(seen, '1h', 8 * 60)
  await $.session.start(START)
  const band = await $.ui.mount(BAND)
  await band.press({ key: 'keepalive' })
  expect((await band.find({ type: 'Text', text: /keep the cache warm until/ }))?.text).toMatch(/^Token Shield · keep the cache warm until/)
  expect(forks).toEqual([])
  await band.unmount()
})
