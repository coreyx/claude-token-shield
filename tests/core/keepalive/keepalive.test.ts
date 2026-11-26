import { describe, expect, it } from 'vitest'

import { DEFAULT_CONFIG } from '../../../plugin/core/config/config'
import { leadMs, nextRefreshAt, parseKeepAlive, plan, QUOTE_MARGIN, tickDecision } from '../../../plugin/core/keepalive/keepalive'

const NOW = Date.UTC(2026, 0, 1, 15, 52)

describe('parseKeepAlive', () => {
  it('takes the defaults when nothing is given', () => {
    expect(parseKeepAlive([], NOW, 0, DEFAULT_CONFIG)).toEqual({ until: NOW + 60 * 60_000, budgetUsd: 1 })
  })

  it('reads until a time of day in the session time zone, rolling to tomorrow when it has passed', () => {
    expect(parseKeepAlive(['until', '17:30'], NOW, 0, DEFAULT_CONFIG)?.until).toBe(Date.UTC(2026, 0, 1, 17, 30))
    expect(parseKeepAlive(['until', '09:00'], NOW, 0, DEFAULT_CONFIG)?.until).toBe(Date.UTC(2026, 0, 2, 9, 0))
    // 15:52 UTC is 07:52 at UTC-8, so 08:30 there is 16:30 UTC today.
    expect(parseKeepAlive(['until', '8:30'], NOW, -480, DEFAULT_CONFIG)?.until).toBe(Date.UTC(2026, 0, 1, 16, 30))
  })

  it('reads a length and a budget', () => {
    expect(parseKeepAlive(['for', '90m', 'max', '$2.50'], NOW, 0, DEFAULT_CONFIG)).toEqual({ until: NOW + 90 * 60_000, budgetUsd: 2.5 })
    expect(parseKeepAlive(['max', '3'], NOW, 0, DEFAULT_CONFIG)?.budgetUsd).toBe(3)
  })

  it('refuses what it cannot read', () => {
    for (const words of [['until'], ['until', '25:00'], ['until', 'soon'], ['for', '0m'], ['for', '2h'], ['max', '$0'], ['max', 'lots'], ['forever', 'x']]) {
      expect(parseKeepAlive(words, NOW, 0, DEFAULT_CONFIG)).toBeNull()
    }
  })
})

describe('schedule', () => {
  it('refreshes 2 minutes before a 1h expiry and 30 seconds before a 5m one', () => {
    expect(leadMs('1h')).toBe(120_000)
    expect(leadMs('5m')).toBe(30_000)
    expect(nextRefreshAt(NOW, '1h')).toBe(NOW + 58 * 60_000)
    expect(nextRefreshAt(NOW, '5m')).toBe(NOW + 270_000)
  })

  it('plans the refreshes that fit before the end and within the budget', () => {
    const expiresAt = NOW + 10 * 60_000
    const p = plan(expiresAt, '1h', { until: NOW + 90 * 60_000, budgetUsd: 1 }, 0.17, NOW)
    expect(p).toEqual({ refreshes: 2, totalUsd: 0.34, firstAt: NOW + 8 * 60_000 })
    // Every 4.5 minutes: five fit in the budget with the 20% allowance ($0.85), a sixth would not.
    const short = plan(expiresAt, '5m', { until: NOW + 90 * 60_000, budgetUsd: 1 }, 0.17, NOW)
    expect(short.refreshes).toBe(5)
    expect(short.totalUsd).toBeLessThanOrEqual(1)
    expect(plan(expiresAt, '1h', { until: NOW + 5 * 60_000, budgetUsd: 1 }, 0.17, NOW).refreshes).toBe(0)
    // Already inside the lead: the first refresh goes now.
    expect(plan(NOW + 60_000, '1h', { until: NOW + 30 * 60_000, budgetUsd: 1 }, 0.17, NOW).firstAt).toBe(NOW)
  })
})

describe('tickDecision', () => {
  const run = { until: NOW + 3_600_000, budgetUsd: 1, spentUsd: 0, promptSince: false }

  it('refreshes while the end, the budget and the person allow', () => {
    expect(tickDecision(run, NOW, 0.17)).toEqual({ action: 'refresh' })
  })

  it('stops when the person is back, at the end, or when the next refresh could pass the budget (AC 15.1, 15.2)', () => {
    expect(tickDecision({ ...run, promptSince: true }, NOW, 0.17)).toEqual({ action: 'stop', reason: 'prompt' })
    expect(tickDecision(run, run.until, 0.17)).toEqual({ action: 'stop', reason: 'end' })
    expect(tickDecision({ ...run, spentUsd: 1 - 0.17 * QUOTE_MARGIN + 0.001 }, NOW, 0.17)).toEqual({ action: 'stop', reason: 'budget' })
    expect(tickDecision({ ...run, spentUsd: 1 - 0.17 * QUOTE_MARGIN }, NOW, 0.17)).toEqual({ action: 'refresh' })
    expect(tickDecision(run, NOW, null)).toEqual({ action: 'stop', reason: 'budget' })
  })
})
