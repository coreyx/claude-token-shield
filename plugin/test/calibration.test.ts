import { expect, test } from 'claude-code/testing'

import { engine, SESSION, START, T0 } from './engine'
import type { Seen } from './engine'

const check = (args: string) => ({ command: 'cache-check', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 100 } })
const DRIFT = 'Token Shield: recent cache behavior differs from its stated rates; intervals widened.'

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

/** An earlier session's chunk of HOT predictions: `hits` read, `misses` not. */
function placePredictions(seen: Seen, hits: number, misses: number): void {
  const rec = (i: number, outcome: string) => ({
    type: 'assessment',
    assessment: { ts: T0 - 86_400_000 + i * 60_000, state: 'HOT', pHit: 0.99, interval: [0.985, 0.998], ttl: '1h', remainingSec: 2400, marginSec: 40, ccVersion: '2.1.332', model: 'claude-opus-5-5', outcome },
  })
  const records = [...Array.from({ length: hits }, (_, i) => rec(i, 'HIT')), ...Array.from({ length: misses }, (_, i) => rec(hits + i, 'MISS'))]
  seen.files.set('/plugin-data/history/earlier-session/000000.json', { text: JSON.stringify({ v: 1, session_id: 'earlier-session', seq: 0, records }), mtimeMs: T0 })
}

/** Lets the background calibration finish. */
async function settle(seen: Seen): Promise<void> {
  for (let i = 0; i < 5; i++) await seen.clock.advance(1)
}

test('each main request records the prediction before it, and the table counts every one (AC 14.3)', async ($, on) => {
  const seen = engine(on)
  on('turn.complete', () => ({ text: '' }))
  on('turn.step', async function* (_, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn' as const,
      usage: { input_tokens: 12, output_tokens: 900, cache_read_input_tokens: 809_458, cache_creation_input_tokens: 3_000, ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 3_000, model: 'claude-opus-5-5' },
    }
  })
  placeSnapshot(seen)
  await $.session.start(START)
  for (let i = 0; i < 3; i++) {
    const stream = $.turn.step({ turnId: `t${i}`, index: 0, model: 'claude-opus-5-5', messageCount: 3 + i })
    for await (const _ of stream) {
      // Nothing streams.
    }
    await stream.result
    // A subagent's request is not the main conversation's, and records no prediction.
    const sub = $.turn.step({ turnId: `s${i}`, index: 0, model: 'claude-opus-5-5', messageCount: 2, agentId: 'agent-1' })
    for await (const _ of sub) {
      // Nothing streams.
    }
    await sub.result
    await $.turn.complete({ turnId: `t${i}`, answer: '', durationMs: 1, isAborted: false, reason: 'answer' })
  }
  const { text } = await $.command.run(check('history --calibration'))
  expect(text).toMatch(/^Calibration  3 predictions · Brier 0\.\d{4}/)
  expect(text).toMatch(/\nHOT          1h   > 10 min      3      /)
  const chunk = [...seen.files.entries()].find(([p]) => p.startsWith(`/plugin-data/history/${SESSION}/`))!
  const assessments = (JSON.parse(chunk[1].text).records as { type: string; assessment?: { outcome: string } }[]).filter(r => r.type === 'assessment')
  expect(assessments.map(a => a.assessment!.outcome)).toEqual(['HIT', 'HIT', 'HIT'])
})

test('HOT misses above the interval raise exactly one drift alert, not again at the next start (AC 14.4)', async ($, on) => {
  const seen = engine(on)
  on('ui.place', (_, e) => ({ value: { isPlaced: true as const, requestId: e.id } }))
  placeSnapshot(seen)
  placePredictions(seen, 36, 4)
  await $.session.start(START)
  await settle(seen)
  expect(seen.toasts.filter(t => t === DRIFT)).toHaveLength(1)
  await $.session.end({ reason: 'other', sessionId: SESSION, resume: { id: SESSION } })
  await $.session.start(START)
  await settle(seen)
  expect(seen.toasts.filter(t => t === DRIFT)).toHaveLength(1)
  // The widened intervals reach the check.
  const { text } = await $.command.run(check('--verbose'))
  expect(text).toMatch(/calibrated/)
})

test('too few predictions keep the priors and raise nothing', async ($, on) => {
  const seen = engine(on)
  placeSnapshot(seen)
  placePredictions(seen, 5, 5)
  await $.session.start(START)
  await settle(seen)
  expect(seen.toasts.filter(t => t === DRIFT)).toEqual([])
  expect((await $.command.run(check('history --calibration'))).text).toMatch(/10 of 30 HOT predictions so far: the stated rates are still the priors\./)
})
