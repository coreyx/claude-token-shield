import { expect, test } from 'claude-code/testing'

import { engine, prompt, SESSION, START, T0 } from './engine'
import type { Seen } from './engine'

const HISTORY = `/plugin-data/history/${SESSION}`
const BAND = { plugin: 'token-shield', component: 'AbovePrompt', requestId: 'band', surface: 'terminal', props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 3, bodyColumns: 100, scroll: { offset: 0, bodyRows: 3 }, view: {} } } as const

/** An earlier run's history chunk: one main request on a 1h TTL. */
function placeHistory(seen: Seen, seq = 0): void {
  const request = {
    id: 'r1',
    lane: 'main',
    tsStart: T0 - 3 * 3_600_000,
    tsStartTier: 'measured',
    model: 'claude-opus-5-5',
    speed: 'standard',
    ttl: '1h',
    usage: { input: 12, read: 809_000, write5m: 0, write1h: 3_000, output: 450 },
    source: 'mod',
  }
  seen.files.set(`${HISTORY}/${String(seq).padStart(6, '0')}.json`, {
    text: JSON.stringify({ v: 1, session_id: SESSION, seq, records: [{ type: 'request', request }] }),
    mtimeMs: T0,
  })
}

/** A classic SessionStart for a resume, `idleSec` after the last response. */
const resumed = (idleSec: number, likelyExpired: boolean) => ({
  source: 'resume' as const,
  seconds_since_last_response: idleSec,
  context_tokens: 812470,
  prompt_cache_likely_expired: likelyExpired,
  estimated_cache_write_usd: 6.5,
})

test('a session last active 3 hours ago shows the cold cost and the four options before the first prompt (AC 11.1)', async ($, on) => {
  const seen = engine(on)
  on('classic.SessionStart', () => ({}))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>beneath</Text>
  })
  placeHistory(seen)
  await $.session.start(START)
  await $.classic.SessionStart(resumed(3 * 3600, true))
  const band = await $.ui.mount(BAND)
  expect((await band.find({ type: 'Text', text: /^Token Shield: resuming/ }))?.text).toBe(
    'Token Shield: resuming re-caches 812,470 tokens ≈ $6.50 (idle 3h 00m). Options: continue, /compact, /clear with a handoff, or /recap first.',
  )
  expect(seen.statuses[seen.statuses.length - 1]).toMatch(/cache COLD/)
  // The band stays through redraws until the first prompt, then goes.
  await seen.clock.advance(30_000)
  expect(await band.find({ type: 'Text', text: /^Token Shield: resuming/ })).toBeDefined()
  await $.prompt.submit(prompt('where were we?'))
  expect(await band.find({ type: 'Text', text: /^Token Shield: resuming/ })).toBeUndefined()
  await band.unmount()
})

test('a session last active 10 minutes ago on a 1h TTL shows "warm until HH:MM" and no warning (AC 11.2)', async ($, on) => {
  const seen = engine(on)
  on('classic.SessionStart', () => ({}))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>beneath</Text>
  })
  placeHistory(seen)
  await $.session.start(START)
  await $.classic.SessionStart(resumed(600, false))
  expect(seen.statuses[seen.statuses.length - 1]).toMatch(/^● cache HOT · 812k · warm until \d\d:\d\d$/)
  // The last response 10 minutes back, plus an hour, in this machine's time zone as the host reads it.
  const at = T0 + 50 * 60_000
  const local = new Date(at - new Date(at).getTimezoneOffset() * 60_000)
  const until = local.toISOString().slice(11, 16)
  expect(seen.statuses[seen.statuses.length - 1]).toContain(`warm until ${until}`)
  expect(seen.toasts).toEqual([`Token Shield: still warm until ${until}.`])
  const band = await $.ui.mount(BAND)
  expect(await band.find({ type: 'Text', text: /Token Shield/ })).toBeUndefined()
  await band.unmount()
})

test('the first request after a resume carries no Token Shield text (AC 11.3)', async ($, on) => {
  const seen = engine(on)
  on('classic.SessionStart', () => ({}))
  await $.session.start(START)
  const start = await $.classic.SessionStart(resumed(3 * 3600, true))
  expect(start).toEqual({})
  // The gate guards the first prompt of a cold resume; sent again, it goes through as typed.
  expect((await $.prompt.submit(prompt('continue from the plan'))).drop).toBeDefined()
  const sent = await $.prompt.submit(prompt('continue from the plan'))
  expect(sent).toEqual({ text: 'continue from the plan' })
  expect(seen.toasts.every(t => t.startsWith('Token Shield'))).toBe(true)
})

test('a resumed session keeps its earlier history: new records start the next chunk', async ($, on) => {
  const seen = engine(on)
  on('classic.SessionStart', () => ({}))
  on('command.run', () => ({ text: '' }))
  placeHistory(seen, 0)
  placeHistory(seen, 1)
  const earlier = seen.files.get(`${HISTORY}/000001.json`)!.text
  await $.session.start(START)
  await $.command.run({ command: 'rewind', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
  await seen.clock.advance(31_000)
  expect(seen.files.get(`${HISTORY}/000001.json`)!.text).toBe(earlier)
  expect(JSON.parse(seen.files.get(`${HISTORY}/000002.json`)!.text).records[0].event.kind).toBe('rewind')
})
