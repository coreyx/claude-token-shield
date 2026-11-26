import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Ajv2020 } from 'ajv/dist/2020.js'
import { describe, expect, it } from 'vitest'

import { renderCheck } from '../../../plugin/core/render/check'
import { ASCII, fit, formatClock, formatDuration, formatTokensShort, formatUsd, glyphSet, UNICODE } from '../../../plugin/core/render/format'
import { renderSegment } from '../../../plugin/core/render/segment'
import type { RenderOptions } from '../../../plugin/core/render/segment'
import { outcome } from '../../../plugin/core/view/view'
import { repoFile, rules, strings } from '../helpers'
import { build, STATES } from './scenarios'

const base = { strings, display: rules.display, tzOffsetMin: 0 }
const seg = (glyphs = UNICODE, billing: RenderOptions['billing'] = 'api'): RenderOptions => ({ ...base, glyphs, billing })

/**
 * Compares `text` with a golden file under fixtures/render/, writing it
 * instead when UPDATE_GOLDEN is set. The Go renderer is held to the same files.
 */
function golden(name: string, text: string): void {
  const path = fileURLToPath(new URL(`../../../fixtures/render/${name}`, import.meta.url))
  if (process.env.UPDATE_GOLDEN === '1' || !existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${text}\n`)
  }
  expect(`${text}\n`).toBe(readFileSync(path, 'utf8'))
}

describe('renderSegment', () => {
  it('reads like the mockup in HOT (AC 8.1)', () => {
    const { a, cost } = build('HOT')
    expect(renderSegment(a, cost, seg())).toBe('● cache HOT · 812k · warm until 16:40')
  })

  it('includes the rebuild cost in COLD (AC 8.2)', () => {
    const { a, cost } = build('COLD')
    expect(renderSegment(a, cost, seg())).toBe('○ cache COLD since 16:40 · next prompt re-caches 812k ≈$6.50')
  })

  it('renders the ASCII forms (AC 22.3)', () => {
    expect(renderSegment(build('HOT').a, build('HOT').cost, seg(ASCII))).toBe('[cache HOT 812k ->16:40]')
    expect(renderSegment(build('COLD').a, build('COLD').cost, seg(ASCII))).toBe('[cache COLD 812k ~$6.50]')
  })

  it('shows no dollar figure on a subscription without a learned plan share', () => {
    const { a, cost } = build('COLD')
    expect(renderSegment(a, cost, seg(UNICODE, 'subscription'))).not.toContain('$')
    const shared = { ...cost, planShare: { warm: { status: 'estimated' as const, pct: 0.2, low: 0.1, high: 0.3 }, cold: { status: 'estimated' as const, pct: 3.2, low: 2, high: 4 } } }
    expect(renderSegment(a, shared, seg(UNICODE, 'subscription'))).toContain('≈3% of 5h')
  })

  it('quotes what waiting costs while EXPIRING, and names the cause when INVALIDATED', () => {
    expect(renderSegment(build('EXPIRING').a, build('EXPIRING').cost, seg())).toBe('◐ cache EXPIRING · 812k · send by 16:40 or re-cache ≈$6.34')
    expect(renderSegment(build('INVALIDATED').a, build('INVALIDATED').cost, seg())).toBe('✕ cache INVALIDATED · model switch · re-cache 812k ≈$6.50')
  })

  it('shows no percentage in UNKNOWN and marks stale data', () => {
    const unknown = renderSegment(build('UNKNOWN').a, null, seg())
    expect(unknown).toBe('? cache UNKNOWN · no response yet')
    expect(unknown).not.toContain('%')
    const stale = { ...build('HOT').a, stale: true }
    expect(renderSegment(stale, build('HOT').cost, seg())).toMatch(/\(stale\)$/)
    expect(renderSegment(stale, build('HOT').cost, seg(ASCII))).toMatch(/ stale\]$/)
  })

  it.each(STATES)('matches its golden files in %s', state => {
    const { a, cost } = build(state)
    golden(`segment-${state}-unicode.txt`, renderSegment(a, state === 'UNKNOWN' ? null : cost, seg()))
    golden(`segment-${state}-ascii.txt`, renderSegment(a, state === 'UNKNOWN' ? null : cost, seg(ASCII)))
  })
})

describe('renderCheck', () => {
  it.each(STATES.flatMap(s => [80, 120].flatMap(w => (['unicode', 'ascii'] as const).map(g => [s, w, g] as const))))(
    '%s at %i columns in %s matches its golden file and fits',
    (state, width, glyphs) => {
      const text = renderCheck(build(state).view('default'), width, { ...base, glyphs: glyphSet(glyphs) })
      for (const line of text.split('\n')) expect(line.length).toBeLessThanOrEqual(width)
      if (glyphs === 'ascii') expect(text).toMatch(/^[\x20-\x7e\n]*$/)
      golden(`check-${state}-${width}-${glyphs}.txt`, text)
    },
  )

  it('tags every figure in verbose output and shows the timeline and both expiry values (AC 2.2, 6.3)', () => {
    const text = renderCheck(build('HOT').view('verbose'), 120, { ...base, glyphs: UNICODE })
    golden('check-HOT-verbose-120-unicode.txt', text)
    expect(text).toContain('Timeline (main conversation)')
    expect(text).toMatch(/Claude Code 16:40:02 · Token Shield 16:40:02/)
    const body = text.split('\n').slice(2).filter(l => /\d/.test(l) && !l.includes('start     gap'))
    for (const line of body) expect(line, line).toMatch(/\[(measured|inferred|estimated)\]$/)
  })

  it('names the model change in the diff after a switch (AC 6.4)', () => {
    const text = renderCheck(build('INVALIDATED').view('diff'), 100, { ...base, glyphs: UNICODE })
    golden('check-INVALIDATED-diff-100-unicode.txt', text)
    expect(text).toContain('model: claude-opus-5-5 → claude-sonnet-5-5')
  })

  it('says when nothing changed', () => {
    expect(renderCheck(build('HOT').view('diff'), 100, { ...base, glyphs: UNICODE })).toContain('no changes between the last two requests')
  })

  it('recommends with the user’s local time', () => {
    const text = renderCheck(build('HOT').view('default'), 100, { ...base, tzOffsetMin: 60, glyphs: UNICODE })
    expect(text).toContain('→ No action needed: warm until 17:40.')
  })

  it('hides dollars from a subscription outside verbose output', () => {
    const text = renderCheck(build('COLD').view('default', 'subscription'), 100, { ...base, glyphs: UNICODE })
    expect(text).toContain('812,470 tokens re-cached if cold')
    expect(text.split('\n').find(l => l.startsWith('Next turn'))).not.toContain('$')
  })

  it('shows the probe hint near even odds', () => {
    const text = renderCheck(build('UNCERTAIN').view('default'), 120, { ...base, glyphs: UNICODE })
    expect(text).toContain('--probe costs')
  })
})

describe('less common renders', () => {
  const o = { ...base, glyphs: UNICODE }

  it('says the cost is unknown for an unpriced model, and shows plan share once learned or learning', () => {
    const b = build('COLD')
    const unpriced = { ...b.view('default'), cost: { ...b.view('default').cost!, warmUsd: null, coldUsd: null } }
    expect(renderCheck(unpriced, 100, o)).toContain('cost unknown for this model; 812,470 tokens re-cached if cold')
    const learning = { ...b.view('default', 'subscription'), cost: { ...b.view('default', 'subscription').cost!, planShare: { warm: { status: 'learning' as const, windows: 1 }, cold: { status: 'learning' as const, windows: 1 } } } }
    expect(renderCheck(learning, 100, o)).toContain('Plan share     learning (1/3 windows)')
    const learned = { ...learning, cost: { ...learning.cost, planShare: { warm: { status: 'estimated' as const, pct: 0.2, low: 0.1, high: 0.3 }, cold: { status: 'estimated' as const, pct: 3.2, low: 2, high: 4 } } } }
    expect(renderCheck(learned, 100, o)).toContain('warm ≈ 0.2% · cold ≈ 3.2% [estimated]')
  })

  it('shows stale data, a missing last request and unknown values', () => {
    const v = build('HOT').view('default')
    const stale = { ...v, stale: true, drivers: [...v.drivers, { key: 'driver.stale', params: { seconds: 75 }, tier: 'measured' as const }] }
    expect(renderCheck(stale, 100, o)).toContain('stale: native data 75s old')
    const bare = { ...v, lastRequest: null, ttl: { value: null, tier: 'absent' as const }, expiresAt: { value: null, tier: 'absent' as const }, prefixTokens: { value: null, tier: 'absent' as const }, session: { requests: null, hitRatio: null, misses: null, lastMiss: null } }
    const text = renderCheck(bare, 100, o)
    expect(text).toContain('Last request   none yet')
    expect(text).toContain('TTL            unknown → expiry unknown')
    expect(text).toContain('no native session data')
  })

  it('names the minimum version and caching-off in UNKNOWN', () => {
    const v = build('UNKNOWN').view('default')
    const version = { ...v, unknownReason: 'version', drivers: [{ key: 'driver.version', params: { version: '2.1.259', min: '2.1.260' }, tier: 'measured' as const }] }
    expect(renderCheck(version, 80, o)).toContain('needs Claude Code v2.1.260 or later')
    expect(renderCheck({ ...v, unknownReason: 'caching_off' }, 80, o)).toContain('prompt caching appears off or unreported')
    expect(renderSegment({ ...build('UNKNOWN').a, unknownReason: 'version', drivers: version.drivers }, null, seg())).toContain('v2.1.260')
  })

  it('lists pending events and other changes in the diff', () => {
    const v = build('HOT').view('diff')
    const diff = { ...v, diff: { changes: [{ field: 'effort' as const, from: 'high', to: null }, { field: 'event' as const, from: null, to: 'reload_plugins' }], missCauses: ['something_new'] } }
    const text = renderCheck(diff, 100, o)
    expect(text).toContain('effort: high → unknown')
    expect(text).toContain('pending: plugins reloaded')
    expect(text).toContain('last miss: something_new')
  })

  it('renders verbose output in ASCII without Unicode', () => {
    expect(renderCheck(build('INVALIDATED').view('verbose'), 120, { ...base, glyphs: ASCII })).toMatch(/^[\x20-\x7e\n]*$/)
  })

  it('cuts a long tagged line to the width', () => {
    const text = renderCheck(build('HOT').view('verbose'), 50, o)
    for (const line of text.split('\n')) expect(line.length).toBeLessThanOrEqual(50)
  })

  it('names the uncertain reason: a pending event or stale data', () => {
    const { a, cost } = build('HOT')
    const event = { ...a, state: 'UNCERTAIN' as const, pending: [{ event: { ts: 0, kind: 'reload_plugins' }, impact: 'MAY' as const }] }
    expect(renderSegment(event, cost, seg())).toContain('plugins reloaded pending')
    expect(renderSegment({ ...a, state: 'UNCERTAIN', stale: true }, cost, seg())).toContain('data stale')
    expect(renderSegment({ ...a, state: 'HOT', expiresAt: { tier: 'absent', reason: 'null' } }, cost, seg())).toBe('● cache HOT · 812k')
  })
})

describe('the published check view', () => {
  const ajv = new Ajv2020({ allErrors: true, strict: false })
  const validate = ajv.compile(JSON.parse(repoFile('schemas/check.schema.json')))

  it.each(STATES.flatMap(s => (['default', 'verbose', 'diff'] as const).map(m => [s, m] as const)))('%s %s matches schemas/check.schema.json', (state, mode) => {
    const view = JSON.parse(JSON.stringify(build(state).view(mode)))
    expect(validate(view) ? [] : validate.errors).toEqual([])
  })
})

describe('format helpers', () => {
  it.each<[number, string]>([
    [45, '45s'],
    [720, '12m'],
    [3588, '59m 48s'],
    [7500, '2h 05m'],
    [-5, '0s'],
  ])('formats %i s as %s', (s, text) => expect(formatDuration(s)).toBe(text))

  it('formats tokens, dollars, clocks and fitting', () => {
    expect([950, 812470, 1_234_567].map(formatTokensShort)).toEqual(['950', '812k', '1.2M'])
    expect([6.4998, 0.004, 0].map(formatUsd)).toEqual(['$6.50', '<$0.01', '$0.00'])
    expect(formatClock(Date.UTC(2026, 0, 1, 23, 30, 5), 90, true)).toBe('01:00:05')
    expect(fit('abcdefgh', 5, '…')).toBe('abcd…')
    expect(fit('abcdefgh', 2, '...')).toBe('ab')
    expect(fit('abc', 5, '…')).toBe('abc')
  })

  it('classifies past outcomes', () => {
    expect([outcome(0, 100), outcome(100000, 2000), outcome(14000, 396000)]).toEqual(['MISS', 'HIT', 'PARTIAL'])
  })
})
