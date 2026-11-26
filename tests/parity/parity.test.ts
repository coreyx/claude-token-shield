/**
 * The parity suite (design.md "Testing approach"): every case in
 * fixtures/parity/ must give the same check view, segment, check text and exit
 * code here as in `go test ./internal/render`. Missing fixtures, or all of them
 * with UPDATE_PARITY=1, are written from tests/parity/cases.ts.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { initialState, reduce } from '../../plugin/core/model/reduce'
import { parseSnapshot } from '../../plugin/core/model/snapshot'
import type { Fact } from '../../plugin/core/model/types'
import { evaluate, EXIT_CODES } from '../../plugin/core/pipeline'
import { renderCheck } from '../../plugin/core/render/check'
import { glyphSet } from '../../plugin/core/render/format'
import { renderSegment } from '../../plugin/core/render/segment'
import { prices, rules, strings } from '../core/helpers'
import { CASES } from './cases'
import type { CaseInput } from './cases'

const dir = fileURLToPath(new URL('../../fixtures/parity/', import.meta.url))

/** Runs one case through the core: what the fixture records as expected. */
function run(c: CaseInput) {
  const facts: Fact[] = c.facts.map(f => (f.kind === 'snapshot' ? { kind: 'snapshot', snapshot: parseSnapshot(f.payload, f.receivedAt) } : f))
  const state = facts.reduce(reduce, initialState())
  const ev = evaluate(state, c.now, {
    rules,
    prices,
    env: c.env,
    mode: c.mode,
    ...(c.ccVersion !== undefined ? { ccVersion: c.ccVersion } : {}),
    ...(c.defaultModel !== undefined ? { defaultModel: c.defaultModel } : {}),
  })
  const glyphs = glyphSet(c.glyphs)
  return {
    view: JSON.parse(JSON.stringify(ev.view)),
    segment: renderSegment(ev.a, ev.cost, { glyphs, strings, display: rules.display, tzOffsetMin: c.tzOffsetMin, billing: ev.billing }),
    check: renderCheck(ev.view, c.width, { glyphs, strings, display: rules.display, tzOffsetMin: c.tzOffsetMin }),
    exitCode: EXIT_CODES[ev.a.state],
  }
}

describe('parity fixtures', () => {
  for (const c of CASES) {
    const path = `${dir}${c.name}.json`
    if (process.env.UPDATE_PARITY === '1' || !existsSync(path)) {
      mkdirSync(dir, { recursive: true })
      writeFileSync(path, `${JSON.stringify({ ...c, expect: run(c) }, null, 2)}\n`)
    }
  }

  const files = readdirSync(dir).filter(f => f.endsWith('.json'))

  it('has a fixture for every case and no stray ones', () => {
    expect(files.map(f => f.replace(/\.json$/, '')).sort()).toEqual(CASES.map(c => c.name).sort())
  })

  it.each(files)('%s', file => {
    const fixture = JSON.parse(readFileSync(`${dir}${file}`, 'utf8'))
    const got = run(fixture as CaseInput)
    expect(got).toEqual(fixture.expect)
  })

  it('covers every state and billing mode', () => {
    const fixtures = files.map(f => JSON.parse(readFileSync(`${dir}${f}`, 'utf8')))
    expect(new Set(fixtures.map(f => f.expect.view.state))).toEqual(new Set(['HOT', 'EXPIRING', 'UNCERTAIN', 'INVALIDATED', 'COLD', 'UNKNOWN']))
    expect(new Set(fixtures.map(f => f.expect.view.billing))).toEqual(new Set(['api', 'subscription', 'subscription-credits', 'provider']))
    const recs = new Set(fixtures.map(f => f.expect.view.recommendation.lever))
    for (const lever of ['none', 'continue', 'compact', 'rewind']) expect(recs).toContain(lever)
  })
})
