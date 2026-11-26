import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { nextTurnCost, requestUsd } from '../../../plugin/core/cost/cost'
import { modelFamily, planShare, shareOf, snapshotRow, withPlanShare } from '../../../plugin/core/cost/planshare'
import type { SnapshotRow } from '../../../plugin/core/cost/planshare'
import { parsePrices } from '../../../plugin/core/data/load'
import { parseSnapshot } from '../../../plugin/core/model/snapshot'
import type { RequestRecord } from '../../../plugin/core/model/types'
import { payload, request, T0 } from '../model/fixtures'

const prices = parsePrices(readFileSync(fileURLToPath(new URL('../../../plugin/data/prices.json', import.meta.url)), 'utf8'))
const HOUR = 3_600_000
const NOW = Date.UTC(2026, 10, 20, 12)

/** A request costing about `usd` on Opus 5.5 (uncached input at $4/MTok), at `ts`. */
function spend(ts: number, usd: number, model = 'claude-opus-5-5', lane: RequestRecord['lane'] = 'main'): RequestRecord {
  return request(ts, { model, lane, usage: { input: Math.round(usd / 4e-6), read: 0, write5m: 0, write1h: 0, output: 0 } })
}

/**
 * A 5-hour window starting `startHoursAgo` before NOW: rows going from
 * `fromPct` to `toPct` in whole-percent steps, and `usd` of spending inside it.
 */
function window(startHoursAgo: number, fromPct: number, toPct: number, usd: number, model?: string) {
  const start = NOW - startHoursAgo * HOUR
  const resetsAt = start + 5 * HOUR
  const rows: SnapshotRow[] = []
  for (let pct = fromPct, i = 0; pct <= toPct; pct++, i++) rows.push({ receivedAt: start + i * 60_000, fiveHour: { usedPercentage: pct, resetsAt } })
  return { rows, requests: [spend(start + 30_000, usd, model)] }
}

/** Combines windows into one series. */
function series(...ws: ReturnType<typeof window>[]) {
  return { rows: ws.flatMap(w => w.rows), requests: ws.flatMap(w => w.requests) }
}

describe('planShare', () => {
  it('learns percentage points per dollar from whole-percent steps', () => {
    const { rows, requests } = series(window(30, 10, 13, 6), window(20, 0, 2, 4), window(10, 5, 9, 8))
    const m = planShare(rows, requests, prices, NOW)
    const opus = m.byFamily.opus!
    expect(opus.windows).toBe(3)
    expect(opus.ratio).toBeCloseTo((3 + 2 + 4) / (6 + 4 + 8), 3)
    expect(opus.low).toBeCloseTo(0.5, 2)
    expect(opus.high).toBeCloseTo(0.5, 2)
  })

  it('treats a reset as a new window, never a negative change', () => {
    const before = window(8, 70, 80, 10)
    // Same hour range continues past the reset: the percentage falls to 0 under a new resetsAt.
    const resetsAt = NOW + 2 * HOUR
    const after: SnapshotRow[] = [0, 1, 2].map(i => ({ receivedAt: NOW - 3 * HOUR + i * 60_000, fiveHour: { usedPercentage: i, resetsAt } }))
    const m = planShare([...before.rows, ...after], [...before.requests, spend(NOW - 3 * HOUR + 30_000, 2)], prices, NOW)
    expect(m.byFamily.opus!.windows).toBe(2)
    expect(m.byFamily.opus!.ratio).toBeCloseTo((10 + 2) / (10 + 2), 2)
  })

  it('skips windows with one row, a falling percentage, or no priced spending', () => {
    const one = { rows: [{ receivedAt: NOW - HOUR, fiveHour: { usedPercentage: 5, resetsAt: NOW + HOUR } }], requests: [spend(NOW - HOUR, 3)] }
    const falling = window(30, 10, 12, 5)
    falling.rows.reverse().forEach((r, i) => ((r as { receivedAt: number }).receivedAt = NOW - 30 * HOUR + i * 60_000))
    const unpriced = window(20, 0, 3, 5, 'some-other-model')
    const empty = { rows: window(10, 0, 3, 0).rows, requests: [] }
    const m = planShare([...one.rows, ...falling.rows, ...unpriced.rows, ...empty.rows], [...one.requests, ...falling.requests, ...unpriced.requests], prices, NOW)
    expect(m.byFamily).toEqual({})
  })

  it('ignores windows older than 14 days and rows without a 5-hour window', () => {
    const old = window(15 * 24, 0, 5, 5)
    const recent = window(10, 0, 5, 5)
    const m = planShare([...old.rows, ...recent.rows, { receivedAt: NOW, fiveHour: null }], [...old.requests, ...recent.requests], prices, NOW)
    expect(m.byFamily.opus!.windows).toBe(1)
  })

  it('assigns a window to the family that spent most, counting subagents', () => {
    const w = window(10, 0, 4, 1)
    const requests = [...w.requests, spend(NOW - 10 * HOUR + 40_000, 3, 'claude-sonnet-5-5', 'subagent')]
    const m = planShare(w.rows, requests, prices, NOW)
    expect(Object.keys(m.byFamily)).toEqual(['sonnet'])
  })
})

describe('shareOf and withPlanShare (AC 3.2)', () => {
  const learned = planShare(...(Object.values(series(window(30, 10, 13, 6), window(20, 0, 2, 4), window(10, 5, 9, 8))) as [SnapshotRow[], RequestRecord[]]), prices, NOW)
  const cost = nextTurnCost({ prefixTokens: 812470, model: 'claude-opus-5-5', ttl: '1h', provider: 'firstParty', at: NOW }, prices)

  it('estimates the share of a cost once three windows are learned', () => {
    const s = shareOf(6.5, 'claude-opus-5-5', learned)
    expect(s.status).toBe('estimated')
    if (s.status === 'estimated') {
      expect(s.pct).toBeCloseTo(6.5 * 0.5, 1)
      expect(s.low).toBeLessThanOrEqual(s.pct)
      expect(s.high).toBeGreaterThanOrEqual(s.pct)
    }
  })

  it('says "learning" below three windows, or for an unseen family', () => {
    const two = planShare(...(Object.values(series(window(20, 0, 2, 4), window(10, 5, 9, 8))) as [SnapshotRow[], RequestRecord[]]), prices, NOW)
    expect(shareOf(6.5, 'claude-opus-5-5', two)).toEqual({ status: 'learning', windows: 2 })
    expect(shareOf(6.5, 'claude-haiku-5-5', learned)).toEqual({ status: 'learning', windows: 0 })
  })

  it('attaches the share in subscription modes only', () => {
    expect(withPlanShare(cost, 'subscription', 'claude-opus-5-5', learned).planShare!.cold.status).toBe('estimated')
    expect(withPlanShare(cost, 'subscription-credits', 'claude-opus-5-5', learned).planShare).toBeDefined()
    expect(withPlanShare(cost, 'api', 'claude-opus-5-5', learned).planShare).toBeUndefined()
    expect(withPlanShare({ ...cost, usd: null }, 'subscription', 'claude-opus-5-5', learned).planShare).toBeUndefined()
  })
})

describe('helpers', () => {
  it('prices a past request with its output', () => {
    const r = request(NOW, { usage: { input: 1000, read: 100000, write5m: 0, write1h: 2000, output: 500 } })
    expect(requestUsd(r, prices)).toBeCloseTo((1000 + 100000 * 0.05 + 2000 * 2 + 500 * 5) * 4e-6)
    expect(requestUsd({ ...r, speed: 'fast' }, prices)).toBeCloseTo((1000 + 100000 * 0.05 + 2000 * 2 + 500 * 5) * 8e-6)
    expect(requestUsd({ ...r, model: 'unknown' }, prices)).toBeNull()
  })

  it('names model families', () => {
    expect(modelFamily('us.anthropic.claude-sonnet-5-5-v1:0')).toBe('sonnet')
    expect(modelFamily('claude-fable-5-2')).toBe('fable')
    expect(modelFamily('gpt-x')).toBe('other')
  })

  it('takes the 5-hour window from a snapshot', () => {
    const s = parseSnapshot(payload(), T0 * 1000)
    expect(snapshotRow(s)).toEqual({ receivedAt: T0 * 1000, fiveHour: { usedPercentage: 23.5, resetsAt: (T0 + 7200) * 1000 } })
    expect(snapshotRow(parseSnapshot(payload({ rate_limits: undefined }), T0 * 1000)).fiveHour).toBeNull()
  })
})
