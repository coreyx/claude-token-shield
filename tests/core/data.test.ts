import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { Ajv2020 } from 'ajv/dist/2020.js'
import { describe, expect, it } from 'vitest'

import {
  DATA_VERSION,
  DataError,
  formatString,
  parsePrices,
  parseRules,
  parseSharedData,
  parseStrings,
} from '../../plugin/core/data/load'
import type { Strings } from '../../plugin/core/data/types'
import { MIN_CLAUDE_CODE_VERSION } from '../../plugin/core/version'

/** Reads a file relative to the repository root. */
function repoFile(path: string): string {
  return readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), 'utf8')
}

const text = {
  prices: repoFile('plugin/data/prices.json'),
  rules: repoFile('plugin/data/rules.json'),
  strings: repoFile('plugin/data/strings.en.json'),
}

/** Parses a shipped file, applies `edit` to a copy, and returns it as JSON text. */
function edited(source: string, edit: (doc: any) => void): string {
  const doc = JSON.parse(source)
  edit(doc)
  return JSON.stringify(doc)
}

/** Asserts that `fn` throws a DataError whose message contains `fragment`. */
function expectDataError(fn: () => unknown, fragment: string): void {
  try {
    fn()
  } catch (err) {
    expect(err).toBeInstanceOf(DataError)
    expect((err as Error).message).toContain(fragment)
    return
  }
  throw new Error(`expected a DataError containing "${fragment}"`)
}

describe('shared data files match their JSON Schemas', () => {
  const ajv = new Ajv2020({ allErrors: true, strict: true })
  const compiled = new Map<string, ReturnType<typeof ajv.compile>>()

  /** Compiles each schema once: Ajv refuses a second schema with the same `$id`. */
  function validator(schemaPath: string): ReturnType<typeof ajv.compile> {
    let validate = compiled.get(schemaPath)
    if (validate === undefined) {
      validate = ajv.compile(JSON.parse(repoFile(schemaPath)))
      compiled.set(schemaPath, validate)
    }
    return validate
  }

  it.each([
    ['prices.json', 'schemas/prices.schema.json', 'prices'],
    ['rules.json', 'schemas/rules.schema.json', 'rules'],
    ['strings.en.json', 'schemas/strings.schema.json', 'strings'],
  ] as const)('%s', (_name, schemaPath, key) => {
    const validate = validator(schemaPath)
    const ok = validate(JSON.parse(text[key]))
    expect(validate.errors ?? []).toEqual([])
    expect(ok).toBe(true)
  })

  it('rejects a price table entry with an unknown field', () => {
    const validate = validator('schemas/prices.schema.json')
    const doc = JSON.parse(edited(text.prices, d => (d.tables[0].models['claude-opus-5-5'].extra = 1)))
    expect(validate(doc)).toBe(false)
  })
})

describe('parseSharedData on the shipped files', () => {
  const data = parseSharedData(text)

  it('reads the 2026-11-03 table with the Opus 5.5 rates the worked example uses', () => {
    const table = data.prices.tables[0]!
    expect(table.effective).toBe('2026-11-03')
    expect(table.models['claude-opus-5-5']).toMatchObject({ input: 4, read_mult: 0.05, write_1h_mult: 2 })
  })

  it('gives Haiku 5.5 its prompt-size tier', () => {
    expect(data.prices.tables[0]!.models['claude-haiku-5-5']!.tiers).toEqual([{ above: 100000, input: 0.5 }])
  })

  it('prices every model the rules treat as keeping the cache across effort changes', () => {
    const models = data.prices.tables[0]!.models
    for (const id of data.rules.perMessageEffortModels) expect(models[id], id).toBeDefined()
  })

  it('agrees with the core on the minimum Claude Code version', () => {
    expect(data.rules.minClaudeCodeVersion).toBe(MIN_CLAUDE_CODE_VERSION)
  })

  it('lists documented no-op actions so they never alarm (AC 2.3)', () => {
    const noOps = data.rules.events.filter(e => e.impact === 'NO_EFFECT' && e.cases === undefined).map(e => e.kind)
    expect(noOps).toEqual(expect.arrayContaining(['mcp_config_edit', 'claude_md_edit', 'permission_mode_change', 'output_style_change']))
  })

  it('keeps effort changes on per-message-effort models with first-party billing only', () => {
    const effort = data.rules.events.find(e => e.kind === 'effort_change')!
    expect(effort.impact).toBe('WILL')
    expect(effort.cases).toEqual([
      { when: { perMessageEffort: true, provider: ['firstParty'], experimentalBetasDisabled: false }, impact: 'NO_EFFECT' },
    ])
  })
})

describe('string catalog (AC 2.8)', () => {
  const strings = parseStrings(text.strings)

  it('never says "hit" or "miss" about a future request', () => {
    const offenders = Object.entries(strings.strings)
      .filter(([, s]) => s.tense === 'future' && /\b(hit|hits|miss|misses|missed)\b/i.test(s.text))
      .map(([key]) => key)
    expect(offenders).toEqual([])
  })

  it('catches a future string that does', () => {
    const bad = parseStrings(edited(text.strings, d => (d.strings['x.bad'] = { text: 'expected hit ≥99%', tense: 'future' })))
    const offenders = Object.entries(bad.strings).filter(
      ([, s]) => s.tense === 'future' && /\b(hit|hits|miss|misses|missed)\b/i.test(s.text),
    )
    expect(offenders.map(([k]) => k)).toEqual(['x.bad'])
  })

  it('labels every Token Shield toast and drop reason with the product name', () => {
    // Follow-on lines (`*.alternative`, `resume.options`) are appended to a labelled message, not shown alone.
    const labelled = Object.entries(strings.strings).filter(
      ([key]) => /^(gate|guard|resume|notify)\./.test(key) && !key.endsWith('.alternative') && key !== 'resume.options',
    )
    for (const [key, s] of labelled) expect(s.text, key).toMatch(/^Token Shield: /)
  })
})

describe('formatString', () => {
  const strings: Strings = {
    v: 1,
    locale: 'en',
    strings: { 'a.b': { text: 'warm until {time} · {tokens}', tense: 'none' } },
  }

  it('fills placeholders', () => {
    expect(formatString(strings, 'a.b', { time: '16:40', tokens: '812k' })).toBe('warm until 16:40 · 812k')
  })

  it('leaves a missing placeholder visible', () => {
    expect(formatString(strings, 'a.b', { time: '16:40' })).toBe('warm until 16:40 · {tokens}')
  })

  it('shows a missing key in brackets', () => {
    expect(formatString(strings, 'nope')).toBe('[nope]')
  })
})

describe('loader errors name the file and the place', () => {
  it('rejects text that is not JSON', () => {
    expectDataError(() => parsePrices('{'), 'prices.json: not valid JSON')
    expectDataError(() => parseRules('[]'), 'rules.json: must be an object')
  })

  it('rejects an unsupported version', () => {
    expectDataError(() => parsePrices(edited(text.prices, d => (d.v = DATA_VERSION + 1))), 'v: version 2 is not supported')
  })

  it.each<[string, (d: any) => void, string]>([
    ['unit', d => (d.unit = 'EUR'), 'unit: must be "USD per million tokens"'],
    ['tables type', d => (d.tables = {}), 'tables: must be an array'],
    ['empty tables', d => (d.tables = []), 'tables: needs at least one table'],
    ['effective date', d => (d.tables[0].effective = 'Nov 3'), 'tables[0].effective: must be a YYYY-MM-DD date'],
    ['negative input', d => (d.tables[0].models['claude-opus-5-5'].input = -1), 'claude-opus-5-5.input: must be a number above 0'],
    ['fast input', d => (d.tables[0].models['claude-opus-5-5'].fast_input = 0), 'claude-opus-5-5.fast_input'],
    ['tier', d => (d.tables[0].models['claude-haiku-5-5'].tiers = [{ above: 0, input: 1 }]), 'tiers[0].above'],
    ['tier list', d => (d.tables[0].models['claude-haiku-5-5'].tiers = 'x'), 'tiers: must be an array'],
    ['provider basis', d => (d.tables[0].providers.bedrock.basis = 'guess'), 'providers.bedrock.basis'],
    ['provider multiplier', d => (d.tables[0].providers.bedrock.multiplier = '1'), 'providers.bedrock.multiplier'],
    ['models type', d => (d.tables[0].models = []), 'tables[0].models: must be an object'],
  ])('prices: %s', (_name, edit, fragment) => {
    expectDataError(() => parsePrices(edited(text.prices, edit)), fragment)
  })

  it.each<[string, (d: any) => void, string]>([
    ['version string', d => (d.minClaudeCodeVersion = 'latest'), 'minClaudeCodeVersion'],
    ['model list', d => (d.perMessageEffortModels = 'all'), 'perMessageEffortModels: must be an array'],
    ['empty kind', d => (d.events[0].kind = ''), 'events[0].kind: must be a non-empty string'],
    ['duplicate kind', d => d.events.push({ ...d.events[0] }), 'duplicate kind "model_switch"'],
    ['impact', d => (d.events[0].impact = 'SOMETIMES'), 'events[0].impact'],
    ['case impact', d => (d.events[2].cases[0].impact = 'X'), 'events[2].cases[0].impact'],
    ['case when', d => (d.events[2].cases[0].when = null), 'events[2].cases[0].when: must be an object'],
    ['warn window', d => (d.warnWindowsSec['5m'] = -1), 'warnWindowsSec.5m'],
    ['skew', d => (d.timing.skewSec = 'five'), 'timing.skewSec'],
    ['stale', d => (d.timing.staleSnapshotSec = 0), 'timing.staleSnapshotSec'],
    ['prior', d => (d.priors.epsWithin = 1.5), 'priors.epsWithin: must be a number between 0 and 1'],
    ['beta', d => (d.priors.mayEvent.beta = 0), 'priors.mayEvent.beta'],
    ['calibration n', d => (d.priors.minCalibrationN = 0), 'priors.minCalibrationN'],
    ['display order', d => (d.display = { maxProb: 0.01, minProb: 0.99 }), 'display: minProb must be below maxProb'],
  ])('rules: %s', (_name, edit, fragment) => {
    expectDataError(() => parseRules(edited(text.rules, edit)), fragment)
  })

  it.each<[string, (d: any) => void, string]>([
    ['locale', d => (d.locale = 1), 'locale: must be a string'],
    ['empty text', d => (d.strings['brand.name'].text = ''), 'strings.brand.name.text'],
    ['tense', d => (d.strings['brand.name'].tense = 'present'), 'strings.brand.name.tense'],
  ])('strings: %s', (_name, edit, fragment) => {
    expectDataError(() => parseStrings(edited(text.strings, edit)), fragment)
  })

  it('formats a file-level message without a path', () => {
    const err = new DataError('x.json', '', 'problem')
    expect(err.message).toBe('x.json: problem')
    expect(err.name).toBe('DataError')
  })
})
