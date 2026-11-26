import { expect, test } from 'claude-code/testing'

import { engine, SESSION, START, T0 } from './engine'
import type { Seen } from './engine'

const DATA = '/plugin-data'

/**
 * Writes the bridge's snapshot as of `at`: warm until `expiresAtSec`, or cold
 * once past it (as Claude Code reports it).
 */
function bridge(seen: Seen, at: number, expiresAtSec: number): void {
  const warm = at / 1000 < expiresAtSec
  const payload = {
    session_id: SESSION,
    model: { id: 'claude-opus-5-5' },
    version: '2.1.332',
    prompt_cache: { warm, caching_observed: true, ttl: '1h', expires_at: warm ? expiresAtSec : null, recache_tokens_if_cold: 812470 },
  }
  seen.files.set(`${DATA}/sessions/${SESSION}/snapshot.json`, { text: JSON.stringify({ v: 1, receivedAt: at, payload }), mtimeMs: at })
}

/** Moves time on in steps, the bridge refreshing the snapshot every 30 s as refreshInterval does. */
async function run(seen: Seen, ms: number, expiresAtSec: number): Promise<void> {
  for (let left = ms; left > 0; left -= 30_000) {
    const stepMs = Math.min(30_000, left)
    bridge(seen, seen.clock.now() + stepMs, expiresAtSec)
    await seen.clock.advance(stepMs)
  }
}

const BAND = { plugin: 'token-shield', component: 'AbovePrompt', requestId: 'band', props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 3, bodyColumns: 100, scroll: { offset: 0, bodyRows: 3 }, view: {} } } as const

test('the band shows in COLD and is absent in HOT (AC 9.3)', async ($, on) => {
  const seen = engine(on)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>beneath</Text>
  })
  bridge(seen, T0, T0 / 1000 + 48 * 60)
  await $.session.start(START)
  for (const surface of ['terminal', 'desktop'] as const) {
    const hot = await $.ui.mount({ ...BAND, surface })
    expect((await hot.find({ type: 'Text', text: /Token Shield/ })) ?? null).toBeNull()
    await hot.unmount()
  }
  await run(seen, 49 * 60_000, T0 / 1000 + 48 * 60)
  for (const surface of ['terminal', 'desktop'] as const) {
    const cold = await $.ui.mount({ ...BAND, surface })
    const row = await cold.find({ type: 'Text', text: /Token Shield/ })
    expect(row?.text).toMatch(/^Token Shield · cache cold; the next prompt re-caches 812,470 tokens \(≈ \$6\.50\)\. +→ Cheapest/)
    await cold.unmount()
  }
})

test('an idle session toasts EXPIRING within 5 s of the warn window (AC 9.5)', async ($, on) => {
  const seen = engine(on)
  const expires = T0 / 1000 + 630 // the 10-minute window opens 30 s after start
  bridge(seen, T0, expires)
  await $.session.start(START)
  expect(seen.toasts).toEqual([])
  await run(seen, 30_000, expires)
  await seen.clock.advance(1_000)
  expect(seen.toasts.length).toBe(1)
  expect(seen.toasts[0]).toMatch(/^Token Shield: cache expires at \d\d:\d\d\.$/)
})

test('HOT → EXPIRING → COLD gives exactly two toasts end to end (AC 9.1)', async ($, on) => {
  const seen = engine(on)
  const expires = T0 / 1000 + 630
  bridge(seen, T0, expires)
  await $.session.start(START)
  await run(seen, 13 * 60_000, expires)
  expect(seen.toasts.length).toBe(2)
  expect(seen.toasts[1]).toMatch(/cache expired at/)
})

test('muted warnings silence EXPIRING (AC 9.4)', { options: { mutedLevels: 'warning' } }, async ($, on) => {
  const seen = engine(on)
  const expires = T0 / 1000 + 630
  bridge(seen, T0, expires)
  await $.session.start(START)
  await run(seen, 60_000, expires)
  expect(seen.toasts).toEqual([])
})

test('the ASCII glyph setting reaches the status line (AC 22.3)', { options: { glyphs: 'ascii' } }, async ($, on) => {
  const seen = engine(on)
  bridge(seen, T0, T0 / 1000 + 48 * 60)
  await $.session.start(START)
  expect(seen.statuses[seen.statuses.length - 1]).toMatch(/^\[cache HOT 812k ->\d\d:40\]$/)
})
