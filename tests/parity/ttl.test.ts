/**
 * TTL advisor parity: every case in fixtures/ttl/ must give the same advice
 * JSON and the same text here as in `go test ./internal/render`. Missing
 * fixtures, or all of them with UPDATE_PARITY=1, are written from the cases
 * below.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import type { ProviderKey } from '../../plugin/core/data/types'
import { sinceRange } from '../../plugin/core/history/summarize'
import type { SessionHistory } from '../../plugin/core/history/summarize'
import { adviseTtl } from '../../plugin/core/history/ttl'
import type { RequestRecord } from '../../plugin/core/model/types'
import { glyphSet } from '../../plugin/core/render/format'
import { renderTtlAdvice } from '../../plugin/core/render/history'
import { prices, rules, strings } from '../core/helpers'
import { request } from '../core/model/fixtures'

const dir = fileURLToPath(new URL('../../fixtures/ttl/', import.meta.url))

/** One TTL case's inputs. */
interface TtlCase {
  readonly name: string
  readonly now: number
  readonly since?: string
  readonly width: number
  readonly glyphs: 'unicode' | 'ascii'
  readonly provider: ProviderKey
  readonly sessions: readonly SessionHistory[]
}

const MIN = 60_000
const DAY = 86_400_000
const NOW = Date.UTC(2026, 0, 31, 12, 0)

/** A session whose requests in a lane come `gapsMin` minutes apart. */
function session(i: number, gapsMin: readonly number[], lane: RequestRecord['lane'] = 'main', model = 'claude-opus-5-5'): SessionHistory {
  let ts = NOW - (i + 1) * DAY
  const requests = [request(ts, { lane, model })]
  for (const g of gapsMin) {
    ts += g * MIN
    requests.push(request(ts, { lane, model, usage: { input: 10, read: 400_000, write5m: 0, write1h: 4_000, output: 500 } }))
  }
  return { sessionId: `s${i}`, requests, events: [], skipped: 0 }
}

const merge = (a: SessionHistory, b: SessionHistory): SessionHistory => ({ ...a, requests: [...a.requests, ...b.requests] })

const CASES: readonly TtlCase[] = [
  {
    name: 'api-1h-wins',
    now: NOW,
    width: 100,
    glyphs: 'unicode',
    provider: 'firstParty',
    sessions: Array.from({ length: 12 }, (_, i) => merge(session(i, [12, 25, 48, 70]), session(i, [2], 'subagent', 'claude-haiku-5-5'))),
  },
  { name: 'short-gaps-5m', now: NOW, width: 100, glyphs: 'unicode', provider: 'firstParty', sessions: Array.from({ length: 10 }, (_, i) => session(i, [1, 2, 3, 4])) },
  { name: 'not-enough-data', now: NOW, width: 100, glyphs: 'unicode', provider: 'firstParty', sessions: Array.from({ length: 4 }, (_, i) => session(i, [20, 30])) },
  {
    name: 'bedrock-subagents-ascii',
    now: NOW,
    since: '14d',
    width: 80,
    glyphs: 'ascii',
    provider: 'bedrock',
    sessions: Array.from({ length: 13 }, (_, i) => merge(session(i, [3, 40]), session(i, [1, 2], 'subagent', 'claude-sonnet-5-5'))),
  },
]

/** Runs one case through the core: what the fixture records as expected. */
function run(c: TtlCase) {
  const advice = adviseTtl(c.sessions, sinceRange(c.since, c.now)!, prices, c.provider)
  return {
    advice: JSON.parse(JSON.stringify(advice)),
    text: renderTtlAdvice(advice, c.width, { glyphs: glyphSet(c.glyphs), strings, display: rules.display, tzOffsetMin: 0 }),
  }
}

describe('TTL advisor parity fixtures', () => {
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
