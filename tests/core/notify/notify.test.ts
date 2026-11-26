import { describe, expect, it } from 'vitest'

import type { Assessment } from '../../../plugin/core/assess/types'
import { DEFAULT_CONFIG } from '../../../plugin/core/config/config'
import { formatString } from '../../../plugin/core/data/load'
import { DEBOUNCE_MS, EMPTY_LOG, logNotification, nextBoundary, notify, notifyCritical } from '../../../plugin/core/notify/notify'
import type { Notification, NotifyLog } from '../../../plugin/core/notify/notify'
import { assessment, strings } from '../helpers'

const MIN = 60_000

/** Feeds assessments at times through the policy, returning the toasts shown. */
function run(steps: [number, Assessment][], cfg = DEFAULT_CONFIG): Notification[] {
  let prev: Assessment | null = null
  let log: NotifyLog = EMPTY_LOG
  const shown: Notification[] = []
  for (const [at, a] of steps) {
    const n = notify(prev, a, log, cfg, at)
    if (n !== null) {
      shown.push(n)
      log = logNotification(log, n, at)
    }
    prev = a
  }
  return shown
}

describe('notify', () => {
  it('gives exactly two toasts for HOT → EXPIRING → COLD (AC 9.1)', () => {
    const shown = run([
      [0, assessment('HOT')],
      [50 * MIN, assessment('EXPIRING')],
      [51 * MIN, assessment('EXPIRING')],
      [61 * MIN, assessment('COLD')],
      [62 * MIN, assessment('COLD')],
    ])
    expect(shown.map(n => [n.trigger, n.level])).toEqual([
      ['HOT->EXPIRING', 'warning'],
      ['EXPIRING->COLD', 'info'],
    ])
  })

  it('shows at most one non-critical toast while flapping within 5 minutes (AC 9.2)', () => {
    const steps: [number, Assessment][] = []
    for (let i = 0; i < 10; i++) steps.push([i * 20_000, assessment(i % 2 === 0 ? 'HOT' : 'UNCERTAIN')])
    expect(run(steps)).toHaveLength(1)
  })

  it('shows another toast once the quiet period is over', () => {
    expect(run([[0, assessment('HOT')], [1, assessment('UNCERTAIN')], [2, assessment('HOT')], [DEBOUNCE_MS + 2, assessment('UNCERTAIN')]])).toHaveLength(2)
  })

  it('suppresses EXPIRING with warnings muted (AC 9.4)', () => {
    expect(run([[0, assessment('HOT')], [MIN, assessment('EXPIRING')]], { ...DEFAULT_CONFIG, mutedLevels: ['warning'] })).toEqual([])
  })

  it('names the cause of an invalidation and the expiry', () => {
    const inv = assessment('INVALIDATED', { cause: { ts: 1, kind: 'model_switch' } })
    const [n] = run([[0, assessment('HOT')], [MIN, inv]])
    expect(n!.params).toEqual({ state: 'INVALIDATED', expiresAt: 3_600_000, cause: 'model_switch' })
    expect(formatString(strings, n!.key, { cause: 'model switch' })).toMatch(/^Token Shield: model switch invalidated/)
  })

  it('announces a TTL change once', () => {
    const fiveMin = assessment('HOT', { ttl: { tier: 'measured', value: '5m' } })
    const shown = run([[0, assessment('HOT')], [MIN, fiveMin], [2 * MIN, fiveMin]])
    expect(shown.map(n => n.trigger)).toEqual(['ttl:1h->5m'])
    expect(shown[0]!.level).toBe('warning')
  })

  it('stays quiet for HOT and UNKNOWN, and at session start in HOT', () => {
    expect(run([[0, assessment('UNKNOWN')], [MIN, assessment('HOT')]])).toEqual([])
    expect(run([[0, assessment('COLD', { expiresAt: { tier: 'absent', reason: 'null' } })]])[0]!.params).toEqual({ state: 'COLD' })
  })
})

describe('critical notifications', () => {
  it('skip the debounce and do not start one', () => {
    const n = notifyCritical('gate_held', { usd: '$6.50' }, DEFAULT_CONFIG)!
    expect(n.level).toBe('critical')
    expect(logNotification({ lastAt: 5 }, n, 100)).toEqual({ lastAt: 5 })
    expect(formatString(strings, n.key, n.params)).toBe('Token Shield: prompt held before a $6.50 rebuild.')
  })

  it('respect a muted critical level', () => {
    expect(notifyCritical('calibration_drift', {}, { ...DEFAULT_CONFIG, mutedLevels: ['critical'] })).toBeNull()
  })
})

describe('nextBoundary (REQ-9.0.5)', () => {
  const a = assessment('HOT', { expiresAt: { tier: 'inferred', value: 60 * MIN }, warnWindowSec: 600, marginSec: 17 })

  it('arms the timer at the warn-window start, then the boundary band', () => {
    expect(nextBoundary(a, 0)).toBe(50 * MIN)
    expect(nextBoundary(a, 50 * MIN)).toBe(60 * MIN - 17_000)
    expect(nextBoundary(a, 60 * MIN)).toBe(60 * MIN + 17_000)
  })

  it('has nothing to arm past the band or without an expiry', () => {
    expect(nextBoundary(a, 61 * MIN)).toBeNull()
    expect(nextBoundary(assessment('HOT', { expiresAt: { tier: 'absent', reason: 'missing' } }), 0)).toBeNull()
  })
})
