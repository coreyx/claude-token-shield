import { expect, test } from 'claude-code/testing'

import { engine, prompt, SESSION, START, T0 } from './engine'
import type { Seen } from './engine'

/** The bridge's snapshot on Opus 5.5 with a 1h TTL: cold, or warm for 48 more minutes. */
function placeSnapshot(seen: Seen, warm: boolean): void {
  const payload = {
    session_id: SESSION,
    model: { id: 'claude-opus-5-5' },
    version: '2.1.332',
    prompt_cache: { warm, caching_observed: true, ttl: '1h', expires_at: warm ? T0 / 1000 + 48 * 60 : null, recache_tokens_if_cold: 812470 },
  }
  seen.files.set(`/plugin-data/sessions/${SESSION}/snapshot.json`, { text: JSON.stringify({ v: 1, receivedAt: T0, payload }), mtimeMs: T0 })
}

const TYPED = 'Refactor the parser  — keep the 🧭 emoji, and the trailing spaces  '

test('a fresh install holds a prompt in the COLD fixture and shows $6.50 (AC 12.1, 12.5)', async ($, on) => {
  const seen = engine(on)
  placeSnapshot(seen, false)
  await $.session.start(START)
  const r = await $.prompt.submit(prompt(TYPED))
  expect(r.drop).toMatch(/^Token Shield: cache COLD \(idle past its TTL\)\. This prompt is expected to re-cache 812,470 tokens ≈ \$6\.50\. Press Enter again within 60 s to send it anyway, or \/\w+ first\.$/)
  expect(r.text).toBeUndefined()
})

test('the same prompt again within 60 s goes through byte-identical; after 61 s it is held again (AC 12.2, 12.3)', async ($, on) => {
  const seen = engine(on)
  placeSnapshot(seen, false)
  await $.session.start(START)
  expect((await $.prompt.submit(prompt(TYPED))).drop).toBeDefined()
  await seen.clock.advance(59_000)
  const released = await $.prompt.submit(prompt(TYPED))
  expect(released.drop).toBeUndefined()
  expect(released.text).toBe(TYPED)
  expect(released.context ?? []).toEqual([])

  expect((await $.prompt.submit(prompt(TYPED))).drop).toBeDefined()
  await seen.clock.advance(61_000)
  expect((await $.prompt.submit(prompt(TYPED))).drop).toBeDefined()
})

test('a different prompt after a hold is held in its own right', async ($, on) => {
  const seen = engine(on)
  placeSnapshot(seen, false)
  await $.session.start(START)
  expect((await $.prompt.submit(prompt('first'))).drop).toBeDefined()
  expect((await $.prompt.submit(prompt('first, edited'))).drop).toBeDefined()
  expect((await $.prompt.submit(prompt('first, edited'))).text).toBe('first, edited')
})

test('UNKNOWN is never held (AC 12.4)', async ($, on) => {
  engine(on)
  await $.session.start(START)
  for (let i = 0; i < 3; i++) expect((await $.prompt.submit(prompt(TYPED))).text).toBe(TYPED)
})

test('HOT, commands and meta prompts pass untouched', async ($, on) => {
  const seen = engine(on)
  placeSnapshot(seen, true)
  await $.session.start(START)
  expect((await $.prompt.submit(prompt(TYPED))).text).toBe(TYPED)
  placeSnapshot(seen, false)
  await seen.clock.advance(31_000)
  expect((await $.prompt.submit({ ...prompt('/compact'), command: { name: 'compact', args: '' } })).text).toBe('/compact')
  expect((await $.prompt.submit({ ...prompt('system note'), isMeta: true })).text).toBe('system note')
})

test('set to warn, the gate toasts the cost and lets the prompt through (REQ-12.0.4)', { options: { gate: 'warn' } }, async ($, on) => {
  const seen = engine(on)
  placeSnapshot(seen, false)
  await $.session.start(START)
  expect((await $.prompt.submit(prompt(TYPED))).text).toBe(TYPED)
  expect(seen.toasts).toContain('Token Shield: cache COLD. This prompt is expected to re-cache 812,470 tokens ≈ $6.50.')
})

test('set to off, the gate neither holds nor warns', { options: { gate: 'off' } }, async ($, on) => {
  const seen = engine(on)
  placeSnapshot(seen, false)
  await $.session.start(START)
  const before = seen.toasts.length
  expect((await $.prompt.submit(prompt(TYPED))).text).toBe(TYPED)
  expect(seen.toasts.length).toBe(before)
})

test('a hold shows the band with the reason and the recommended lever', async ($, on) => {
  const seen = engine(on)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>beneath</Text>
  })
  placeSnapshot(seen, false)
  await $.session.start(START)
  await $.prompt.submit(prompt(TYPED))
  const band = await $.ui.mount({ plugin: 'token-shield', component: 'AbovePrompt', requestId: 'band', surface: 'terminal', props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 3, bodyColumns: 100, scroll: { offset: 0, bodyRows: 3 }, view: {} } })
  expect((await band.find({ type: 'Text', text: /Press Enter again/ }))?.text).toMatch(/≈ \$6\.50.*  → /)
  await band.unmount()
})

test('the submit hook adds at most 20 ms at p95 (AC 21.2)', async ($, on) => {
  const seen = engine(on)
  placeSnapshot(seen, false)
  await $.session.start(START)
  const long = 'x'.repeat(50_000)
  const times: number[] = []
  for (let i = 0; i < 200; i++) {
    // Alternate a hold and its release, and move time on so the cached evaluation goes stale half the time.
    const start = performance.now()
    await $.prompt.submit(prompt(i % 4 < 2 ? long : TYPED))
    times.push(performance.now() - start)
    if (i % 2 === 1) await seen.clock.advance(1_500)
  }
  times.sort((a, b) => a - b)
  const p95 = times[Math.floor(times.length * 0.95)]!
  expect(p95).toBeLessThanOrEqual(20)
})
