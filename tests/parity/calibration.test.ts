/**
 * Calibration parity: every case in fixtures/calibration/ must give the same
 * calibration JSON and the same text here as in `go test ./internal/render`.
 * Missing fixtures, or all of them with UPDATE_PARITY=1, are written from the
 * cases below.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { calibrate } from '../../plugin/core/history/calibrate'
import type { AssessmentRecord } from '../../plugin/core/history/calibrate'
import { glyphSet } from '../../plugin/core/render/format'
import { renderCalibration } from '../../plugin/core/render/history'
import { rules, strings } from '../core/helpers'

const dir = fileURLToPath(new URL('../../fixtures/calibration/', import.meta.url))

/** One calibration case's inputs. */
interface CalibrationCase {
  readonly name: string
  readonly width: number
  readonly glyphs: 'unicode' | 'ascii'
  readonly records: readonly AssessmentRecord[]
}

const rec = (over: Partial<AssessmentRecord> = {}): AssessmentRecord => ({
  ts: Date.UTC(2026, 0, 20, 12, 0),
  state: 'HOT',
  pHit: 0.99,
  interval: [0.985, 0.998],
  ttl: '1h',
  remainingSec: 2400,
  marginSec: 40,
  ccVersion: '2.1.332',
  model: 'claude-opus-5-5',
  outcome: 'HIT',
  ...over,
})
const times = (n: number, r: AssessmentRecord) => Array.from({ length: n }, (_, i) => ({ ...r, ts: r.ts + i * 60_000 }))

const CASES: readonly CalibrationCase[] = [
  { name: 'empty', width: 100, glyphs: 'unicode', records: [] },
  {
    name: 'mixed-priors',
    width: 100,
    glyphs: 'unicode',
    records: [
      ...times(12, rec()),
      ...times(3, rec({ state: 'EXPIRING', remainingSec: 300, pHit: 0.97, interval: [0.95, 0.99] })),
      ...times(4, rec({ state: 'COLD', remainingSec: -3000, pHit: 0.01, interval: [0.005, 0.03], outcome: 'MISS' })),
      rec({ state: 'UNCERTAIN', remainingSec: 10, pHit: 0.5, interval: [0.3, 0.7], outcome: 'PARTIAL', ttl: '5m', ccVersion: '2.1.330', model: 'claude-sonnet-5-5' }),
      rec({ state: 'HOT', remainingSec: null, ttl: null, ccVersion: null, model: null }),
    ],
  },
  { name: 'hot-drift', width: 100, glyphs: 'unicode', records: [...times(36, rec()), ...times(4, rec({ outcome: 'MISS' }))] },
  {
    name: 'calibrated-ascii-narrow',
    width: 70,
    glyphs: 'ascii',
    records: [...times(40, rec()), ...times(35, rec({ state: 'COLD', remainingSec: -4000, pHit: 0.01, interval: [0.005, 0.03], outcome: 'MISS' }))],
  },
]

const PRIORS = { epsWithin: rules.priors.epsWithin, epsAfter: rules.priors.epsAfter, minCalibrationN: rules.priors.minCalibrationN }

/** Runs one case through the core: what the fixture records as expected. */
function run(c: CalibrationCase) {
  const calibration = calibrate(c.records, PRIORS)
  return {
    calibration: JSON.parse(JSON.stringify(calibration)),
    text: renderCalibration(calibration, PRIORS.minCalibrationN, c.width, { glyphs: glyphSet(c.glyphs), strings, display: rules.display, tzOffsetMin: 0 }),
  }
}

describe('calibration parity fixtures', () => {
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
