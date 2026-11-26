/**
 * Shared test helpers: reading repository files and building synthetic
 * assessments without running the assessor.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import type { Assessment, CacheState } from '../../plugin/core/assess/types'
import { parsePrices, parseRules, parseStrings } from '../../plugin/core/data/load'

/** Reads a file relative to the repository root. */
export function repoFile(path: string): string {
  return readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), 'utf8')
}

export const rules = parseRules(repoFile('plugin/data/rules.json'))
export const prices = parsePrices(repoFile('plugin/data/prices.json'))
export const strings = parseStrings(repoFile('plugin/data/strings.en.json'))

/** A plausible assessment in `state`, expiring `expiresAt` (epoch ms), overridable. */
export function assessment(state: CacheState, overrides: Partial<Assessment> = {}): Assessment {
  const known = state !== 'UNKNOWN'
  return {
    state,
    at: 0,
    pHit: known ? (state === 'COLD' || state === 'INVALIDATED' ? 0.01 : 0.995) : null,
    interval: known ? [0.985, 0.9975] : null,
    lowEvidence: true,
    confidence: known ? 'HIGH' : 'LOW',
    ...(known ? {} : { unknownReason: 'no_response' as const }),
    ttl: { tier: 'measured', value: '1h' },
    expiresAt: { tier: 'inferred', value: 3_600_000 },
    remainingSec: 3600,
    marginSec: 17,
    warnWindowSec: 600,
    prefixTokens: { tier: 'inferred', value: 812470 },
    pending: [],
    stale: false,
    driftSec: null,
    nativeUnavailable: false,
    drivers: [],
    ...overrides,
  }
}
