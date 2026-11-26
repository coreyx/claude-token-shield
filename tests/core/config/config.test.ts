import { describe, expect, it } from 'vitest'

import { DEFAULT_CONFIG, validateConfig } from '../../../plugin/core/config/config'
import { formatString } from '../../../plugin/core/data/load'
import { strings } from '../helpers'

describe('validateConfig', () => {
  it('gives the defaults for an empty configuration', () => {
    expect(validateConfig({})).toEqual({ config: DEFAULT_CONFIG, invalid: [] })
    expect(DEFAULT_CONFIG).toMatchObject({ thresholdUsd: 2, thresholdTokens: 250000, gate: 'hold', switchConfirm: 'off', historyDays: 90 })
  })

  it('keeps valid values, including numeric strings and durations', () => {
    const { config, invalid } = validateConfig({
      thresholdUsd: '5',
      thresholdTokens: 400000,
      warnWindow1h: '15m',
      warnWindow5m: 90,
      gate: 'warn',
      switchConfirm: 'on',
      mutedLevels: 'info, warning',
      glyphs: 'ascii',
      keepAliveDefaultBudgetUsd: 2.5,
      keepAliveDefaultMinutes: 30,
      historyDays: 30,
      priceOverridesPath: '~/prices.json',
      somethingElse: true,
    })
    expect(invalid).toEqual([])
    expect(config).toEqual({
      thresholdUsd: 5,
      thresholdTokens: 400000,
      warnWindow1hSec: 900,
      warnWindow5mSec: 90,
      gate: 'warn',
      switchConfirm: 'on',
      mutedLevels: ['info', 'warning'],
      glyphs: 'ascii',
      keepAliveDefaultBudgetUsd: 2.5,
      keepAliveDefaultMinutes: 30,
      historyDays: 30,
      priceOverridesPath: '~/prices.json',
    })
  })

  it('reads hour and second durations, and lists of levels', () => {
    const { config } = validateConfig({ warnWindow1h: '1h', warnWindow5m: '45s', mutedLevels: ['critical', 'critical'] })
    expect(config.warnWindow1hSec).toBe(3600)
    expect(config.warnWindow5mSec).toBe(45)
    expect(config.mutedLevels).toEqual(['critical'])
    expect(validateConfig({ mutedLevels: '' }).config.mutedLevels).toEqual([])
  })

  it('replaces each invalid value with its default and names it (AC 22.2)', () => {
    const { config, invalid } = validateConfig({
      thresholdUsd: -1,
      thresholdTokens: 1.5,
      warnWindow1h: '2h',
      warnWindow5m: 'soon',
      gate: 'block',
      switchConfirm: true,
      mutedLevels: ['loud'],
      glyphs: 'emoji',
      keepAliveDefaultBudgetUsd: 'lots',
      keepAliveDefaultMinutes: 0,
      historyDays: 'forever',
      priceOverridesPath: '  ',
    })
    expect(config).toEqual(DEFAULT_CONFIG)
    expect(invalid).toEqual([
      'thresholdUsd',
      'thresholdTokens',
      'warnWindow1h',
      'warnWindow5m',
      'gate',
      'switchConfirm',
      'mutedLevels',
      'glyphs',
      'keepAliveDefaultBudgetUsd',
      'keepAliveDefaultMinutes',
      'historyDays',
      'priceOverridesPath',
    ])
    expect(formatString(strings, 'error.config_invalid', { key: invalid[0]!, default: '2' })).toContain('thresholdUsd')
  })

  it('treats undefined like missing', () => {
    expect(validateConfig({ gate: undefined }).invalid).toEqual([])
  })
})
