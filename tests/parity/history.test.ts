/**
 * History parity: every case in fixtures/history/ must give the same summary
 * JSON and the same text here as in `go test ./internal/summary`. Missing
 * fixtures, or all of them with UPDATE_PARITY=1, are written from the cases
 * below.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { adviceReport } from '../../plugin/core/history/advice'
import { baseline, installTime } from '../../plugin/core/history/baseline'
import { sinceRange, summarize } from '../../plugin/core/history/summarize'
import type { SessionHistory } from '../../plugin/core/history/summarize'
import type { ProviderKey } from '../../plugin/core/data/types'
import type { EventRecord, RequestRecord } from '../../plugin/core/model/types'
import { glyphSet } from '../../plugin/core/render/format'
import { renderHistory } from '../../plugin/core/render/history'
import { prices, rules, strings } from '../core/helpers'
import { request } from '../core/model/fixtures'

const dir = fileURLToPath(new URL('../../fixtures/history/', import.meta.url))

/** One history case's inputs. */
interface HistoryCase {
  readonly name: string
  readonly now: number
  readonly tzOffsetMin: number
  readonly width: number
  readonly glyphs: 'unicode' | 'ascii'
  readonly provider: ProviderKey
  readonly since?: string
  readonly session?: string
  readonly misses: boolean
  readonly sessions: readonly SessionHistory[]
  /** Sessions backfilled from transcripts, for the baseline. */
  readonly backfill?: readonly SessionHistory[]
}

const NOW = Date.UTC(2026, 0, 31, 12, 0)
const DAY = 86_400_000
const MIN = 60_000
const hit = (ts: number, over: Partial<RequestRecord> = {}) => request(ts, { usage: { input: 10, read: 802_500, write5m: 0, write1h: 2_000, output: 500 }, ...over })
const miss = (ts: number, over: Partial<RequestRecord> = {}) => request(ts, { usage: { input: 10, read: 0, write1h: 802_500, write5m: 0, output: 500 }, ...over })
const partial = (ts: number) => request(ts, { usage: { input: 10, read: 400_000, write1h: 402_500, write5m: 0, output: 500 } })
const S1 = '11111111-2222-3333-4444-555555555555'
const S2 = '66666666-7777-8888-9999-000000000000'
const base = { now: NOW, tzOffsetMin: 0, width: 100, glyphs: 'unicode' as const, provider: 'firstParty' as const, misses: false }
const t0 = NOW - 2 * DAY
const events: EventRecord[] = [
  { ts: t0 + 79 * MIN, kind: 'model_switch', detail: { from: 'claude-opus-5-5', to: 'claude-sonnet-5-5' } },
  { ts: t0 + 89 * MIN, kind: 'compaction' },
  { ts: t0 + 100 * MIN + 2_000, kind: 'native_miss', detail: { to: 'likely_server_side' } },
  { ts: t0 + 105 * MIN, kind: 'reload_plugins' },
]

const CASES: readonly HistoryCase[] = [
  {
    ...base,
    name: 'every-cause',
    sessions: [
      {
        sessionId: S1,
        requests: [hit(t0), miss(t0 + 70 * MIN), miss(t0 + 80 * MIN), miss(t0 + 90 * MIN), miss(t0 + 100 * MIN), partial(t0 + 101 * MIN), miss(t0 + 106 * MIN), hit(t0 + 107 * MIN)],
        events,
        skipped: 0,
      },
    ],
  },
  { ...base, name: 'gap-70m-avoidable', sessions: [{ sessionId: S1, requests: [hit(t0), miss(t0 + 70 * MIN)], events: [], skipped: 0 }] },
  { ...base, name: 'gap-3h-not-avoidable', sessions: [{ sessionId: S1, requests: [hit(t0), miss(t0 + 180 * MIN)], events: [], skipped: 0 }] },
  {
    ...base,
    name: 'since-7d-misses',
    since: '7d',
    misses: true,
    sessions: [
      { sessionId: S1, requests: [hit(NOW - 10 * DAY), miss(NOW - 10 * DAY + 90 * MIN), hit(NOW - 10 * DAY + 91 * MIN)], events: [], skipped: 0 },
      { sessionId: S2, requests: [hit(NOW - 2 * DAY), hit(NOW - 2 * DAY + 10 * MIN), miss(NOW - 2 * DAY + 100 * MIN)], events: [], skipped: 0 },
    ],
  },
  {
    ...base,
    name: 'one-session-unpriced-skipped-ascii',
    glyphs: 'ascii',
    width: 72,
    session: S2,
    tzOffsetMin: -300,
    sessions: [
      { sessionId: S1, requests: [hit(t0), miss(t0 + 90 * MIN)], events: [], skipped: 1 },
      { sessionId: S2, requests: [hit(t0, { model: 'claude-unknown-9' }), miss(t0 + 90 * MIN, { model: 'claude-unknown-9' }), miss(t0 + 200 * MIN, { ttl: '5m' })], events: [], skipped: 2 },
    ],
  },
  { ...base, name: 'bedrock-5m', provider: 'bedrock', sessions: [{ sessionId: S1, requests: [hit(t0, { ttl: '5m' }), miss(t0 + 8 * MIN, { ttl: '5m' }), miss(t0 + 30 * MIN, { ttl: '5m' })], events: [], skipped: 0 }] },
  {
    ...base,
    name: 'advice-judged',
    sessions: [
      {
        sessionId: S1,
        requests: [hit(t0), miss(t0 + 70 * MIN), hit(t0 + 71 * MIN), hit(t0 + 72 * MIN), miss(t0 + 130 * MIN, { usage: { input: 10, read: 0, write1h: 40_000, write5m: 0, output: 500 } })],
        events: [],
        skipped: 0,
        recommendations: [
          { ts: t0 + 69 * MIN, state: 'COLD', lever: 'compact', pHit: 0.01, readUsd: 0.17, writeUsd: 6.42, quotes: [{ lever: 'continue', nowUsd: 6.36, perTurnUsd: 0.17 }, { lever: 'compact', nowUsd: 1.2, perTurnUsd: 0.02 }] },
          { ts: t0 + 70 * MIN + 30_000, state: 'HOT', lever: 'continue', pHit: 0.99, readUsd: 0.17, writeUsd: 6.42, quotes: [{ lever: 'continue', nowUsd: 0.23, perTurnUsd: 0.17 }, { lever: 'compact', nowUsd: 1.2, perTurnUsd: 0.02 }] },
          { ts: t0 + 129 * MIN, state: 'COLD', lever: 'compact', pHit: 0.01, readUsd: 0.17, writeUsd: 6.42, quotes: [{ lever: 'continue', nowUsd: 6.36, perTurnUsd: 0.17 }, { lever: 'compact', nowUsd: 1.2, perTurnUsd: 0.02 }] },
          { ts: t0 + 140 * MIN, state: 'HOT', lever: 'none', pHit: 0.99, readUsd: 0.17, writeUsd: 6.42, quotes: [] },
        ],
        levers: [
          { ts: t0 + 69 * MIN + 30_000, lever: 'continue' },
          { ts: t0 + 70 * MIN + 40_000, lever: 'continue' },
          { ts: t0 + 129 * MIN + 30_000, lever: 'compact' },
        ],
      },
    ],
  },
  {
    ...base,
    name: 'baseline-before-and-since',
    sessions: [{ sessionId: S2, requests: [hit(NOW - 5 * DAY), miss(NOW - 5 * DAY + 70 * MIN), hit(NOW - 5 * DAY + 71 * MIN)], events: [], skipped: 0 }],
    backfill: [
      {
        sessionId: S1,
        requests: [
          hit(NOW - 60 * DAY, { source: 'transcript', tsStartTier: 'inferred' }),
          miss(NOW - 60 * DAY + 70 * MIN, { source: 'transcript', tsStartTier: 'inferred' }),
          hit(NOW - 40 * DAY, { source: 'transcript', tsStartTier: 'inferred' }),
          miss(NOW - 40 * DAY + 80 * MIN, { source: 'transcript', tsStartTier: 'inferred' }),
          miss(NOW - 40 * DAY + 160 * MIN, { source: 'transcript', tsStartTier: 'inferred' }),
        ],
        events: [],
        skipped: 0,
      },
    ],
  },
  { ...base, name: 'empty-window', since: '1d', sessions: [{ sessionId: S1, requests: [hit(t0), miss(t0 + 90 * MIN)], events: [], skipped: 0 }] },
]

/** Runs one case through the core: what the fixture records as expected. */
function run(c: HistoryCase) {
  const range = sinceRange(c.since, c.now)!
  const filter = { misses: c.misses, ...(c.session !== undefined ? { session: c.session } : {}) }
  const summary = summarize(c.sessions, range, filter, prices, c.provider)
  const advice = adviceReport(c.sessions, range, filter, prices)
  const base = c.backfill !== undefined ? baseline(c.backfill, installTime(c.sessions), summary, prices, c.provider) : null
  return {
    summary: JSON.parse(JSON.stringify(summary)),
    advice: JSON.parse(JSON.stringify(advice)),
    baseline: JSON.parse(JSON.stringify(base)),
    text: renderHistory(summary, c.width, { glyphs: glyphSet(c.glyphs), strings, display: rules.display, tzOffsetMin: c.tzOffsetMin }, advice, base),
  }
}

describe('history parity fixtures', () => {
  for (const c of CASES) {
    const path = `${dir}${c.name}.json`
    if (process.env.UPDATE_PARITY === '1' || !existsSync(path)) {
      mkdirSync(dir, { recursive: true })
      writeFileSync(path, `${JSON.stringify({ ...c, expect: run(c) }, null, 2)}\n`)
    }
  }

  it('has a fixture for every case and no stray ones', () => {
    const files = readdirSync(dir).filter(f => f.endsWith('.json'))
    expect(files.map(f => f.replace(/\.json$/, '')).sort()).toEqual(CASES.map(c => c.name).sort())
  })

  for (const c of CASES) {
    it(`${c.name} matches its fixture`, () => {
      const fixture = JSON.parse(readFileSync(`${dir}${c.name}.json`, 'utf8')) as { expect: ReturnType<typeof run> }
      expect(run(c)).toEqual(fixture.expect)
    })
  }
})
