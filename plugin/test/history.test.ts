import { expect, test } from 'claude-code/testing'

import { engine, SESSION, START, T0 } from './engine'
import type { Seen } from './engine'

const MIN = 60_000
const DAY = 86_400_000
const OTHER = '66666666-7777-8888-9999-000000000000'
const check = (args: string) => ({ command: 'cache-check', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 100 } })

/** A main request at `ts` that read `read` of the prefix and wrote `write`. */
function request(ts: number, read: number, write: number) {
  return { id: `r${ts}`, lane: 'main', tsStart: ts, tsStartTier: 'measured', model: 'claude-opus-5-5', speed: 'standard', ttl: '1h', usage: { input: 10, read, write5m: 0, write1h: write, output: 500 }, source: 'mod' }
}

/** Writes a session's history chunk as the mod would. */
function placeChunk(seen: Seen, session: string, seq: number, requests: unknown[]): void {
  seen.files.set(`/plugin-data/history/${session}/${String(seq).padStart(6, '0')}.json`, {
    text: JSON.stringify({ v: 1, session_id: session, seq, records: requests.map(request => ({ type: 'request', request })) }),
    mtimeMs: T0,
  })
}

const hit = (ts: number) => request(ts, 802_500, 2_000)
const miss = (ts: number) => request(ts, 0, 802_500)

test('/cache-check history shows this session, a 70-minute gap avoidable and a 3-hour one not (AC 14.2)', async ($, on) => {
  const seen = engine(on)
  const t0 = T0 - DAY
  placeChunk(seen, SESSION, 0, [hit(t0), miss(t0 + 70 * MIN)])
  placeChunk(seen, SESSION, 1, [hit(t0 + 71 * MIN), miss(t0 + 251 * MIN)])
  placeChunk(seen, OTHER, 0, [hit(t0), miss(t0 + 70 * MIN)])
  await $.session.start(START)
  const { text, isTextDisplayOnly } = await $.command.run(check('history'))
  expect(isTextDisplayOnly).toBe(true)
  expect(text).toMatch(/^History  .* · sessions 1 · requests 4\n/)
  const rows = text!.split('\n').filter(l => /^\d\d-\d\d \d\d:\d\d/.test(l))
  expect(rows).toHaveLength(3)
  expect(rows.filter(l => l.includes('miss')).map(l => l.endsWith('avoidable'))).toEqual([true, false])
})

test('--all --since 7d --misses lists only misses from the last seven days across sessions (AC 6.5)', async ($, on) => {
  const seen = engine(on)
  const old = T0 - 10 * DAY
  const recent = T0 - 2 * DAY
  placeChunk(seen, SESSION, 0, [hit(old), miss(old + 90 * MIN)])
  placeChunk(seen, OTHER, 0, [hit(recent), hit(recent + 10 * MIN), miss(recent + 100 * MIN)])
  await $.session.start(START)
  const { text } = await $.command.run(check('history --all --since 7d --misses'))
  const rows = text!.split('\n').filter(l => /^\d\d-\d\d \d\d:\d\d/.test(l))
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatch(/^\d\d-\d\d \d\d:\d\d  66666666  claude-opus-5-5      miss     TTL expiry/)
})

test('an unreadable or newer chunk is skipped and counted, and bad options say how to ask', async ($, on) => {
  const seen = engine(on)
  placeChunk(seen, SESSION, 0, [hit(T0 - DAY), miss(T0 - DAY + 90 * MIN)])
  seen.files.set(`/plugin-data/history/${SESSION}/000001.json`, { text: '{oops', mtimeMs: T0 })
  seen.files.set(`/plugin-data/history/${SESSION}/000002.json`, { text: '{"v":7,"records":[]}', mtimeMs: T0 })
  await $.session.start(START)
  expect((await $.command.run(check('history'))).text).toMatch(/2 history chunks skipped/)
  for (const bad of ['history --since soon', 'history --all --session x', 'history --what']) {
    expect((await $.command.run(check(bad))).text).toMatch(/^Token Shield: \/cache-check history \[--session/)
  }
})

test('each recommendation is stored with every alternative and its cost, and the lever taken is recorded (AC 4.5)', async ($, on) => {
  const seen = engine(on)
  on('command.run', () => ({ text: '' }))
  on('turn.complete', () => ({ text: '' }))
  on('turn.step', async function* (_, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn' as const,
      usage: { input_tokens: 12, output_tokens: 900, cache_read_input_tokens: 0, cache_creation_input_tokens: 40_000, ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 40_000, model: 'claude-opus-5-5' },
    }
  })
  // Cold on a big prefix: Token Shield recommends a lever and quotes the rest.
  const payload = { session_id: SESSION, model: { id: 'claude-opus-5-5' }, version: '2.1.332', prompt_cache: { warm: false, caching_observed: true, ttl: '1h', expires_at: null, recache_tokens_if_cold: 812470 } }
  seen.files.set(`/plugin-data/sessions/${SESSION}/snapshot.json`, { text: JSON.stringify({ v: 1, receivedAt: T0, payload }), mtimeMs: T0 })
  placeChunk(seen, SESSION, 0, [hit(T0 - 3 * 3_600_000)])
  await $.session.start(START)
  await seen.clock.advance(60_000)
  await $.command.run({ command: 'compact', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 3 })
  for await (const _ of stream) {
    // Nothing streams.
  }
  await stream.result
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 1, isAborted: false, reason: 'answer' })
  const records = [...seen.files.entries()]
    .filter(([p]) => p.startsWith(`/plugin-data/history/${SESSION}/`))
    .flatMap(([, f]) => JSON.parse(f.text).records as { type: string; recommendation?: { lever: string; quotes: { lever: string; nowUsd: number | null }[] }; lever?: { lever: string } }[])
  const rec = records.find(r => r.type === 'recommendation')!.recommendation!
  expect(rec.quotes.map(q => q.lever)).toEqual(expect.arrayContaining(['continue', 'compact', 'clear']))
  expect(rec.quotes.find(q => q.lever === 'continue')!.nowUsd).toBeGreaterThan(1)
  expect(records.filter(r => r.type === 'lever_taken').map(r => r.lever!.lever)).toEqual(['compact'])
  expect((await $.command.run(check('history'))).text).toMatch(/\nAdvice          (cheapest in hindsight \d+ of \d+ \(\d+%\)|none judged yet)/)
})
