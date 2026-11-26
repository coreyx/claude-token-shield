import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { scanSource, sourceFiles, stripComments } from '../../scripts/check-hooks.mjs'

describe('check-hooks (AC 5.4)', () => {
  it('passes observe-only hooks', () => {
    const src = `on('prompt.submit', async ($, e, next) => next(e))\non('ui.render', { component: 'AbovePrompt' }, ($, e, next) => next(e))`
    expect(scanSource('a.tsx', src)).toEqual([])
  })

  it.each(['prompt.compose', 'prompt.section', 'prompt.context', 'tool.describe', 'tool.list'])('flags a %s registration', event => {
    expect(scanSource('a.ts', `on("${event}", h)`)).toEqual([`a.ts:1: registers ${event}, which writes into the model's context`])
  })

  it.each(['context', 'additionalContext'])('flags a %s field', field => {
    expect(scanSource('a.ts', `return { text, ${field}: ['x'] }`)).toEqual([`a.ts:1: sets ${field}, which adds context to a request`])
  })

  it('flags permissionDecision without the REQ-10.0.6 marker', () => {
    expect(scanSource('a.ts', `return { ...r, permissionDecision: 'ask' }`)).toEqual([
      'a.ts:1: sets permissionDecision, which decides a permission',
    ])
  })

  it('allows permissionDecision on or directly below a REQ-10.0.6 marker', () => {
    const src = [
      'return {',
      '  ...result,',
      "  permissionDecision: 'ask', // tshield-allow: REQ-10.0.6",
      '  // tshield-allow: REQ-10.0.6',
      '  permissionDecisionReason: reason,',
      '}',
    ].join('\n')
    expect(scanSource('a.ts', src)).toEqual([])
  })

  it('never lets the marker allow context', () => {
    expect(scanSource('a.ts', `return { context: [x] } // tshield-allow: REQ-10.0.6`)).toHaveLength(1)
  })

  it('ignores names mentioned in comments, and keeps URLs', () => {
    const src = `/* never return context: [] or on('tool.list') */\n// permissionDecision: no\nconst u = 'https://x.example/a' // ok`
    expect(scanSource('a.ts', src)).toEqual([])
    expect(stripComments(src).split('\n')).toHaveLength(3)
    expect(stripComments(src)).toContain('https://x.example/a')
  })

  it('does not mistake a longer name for a forbidden field', () => {
    expect(scanSource('a.ts', 'const contextTokens: number = 1\nconst x = { promptContext: 1 }')).toEqual([])
  })

  it('walks a directory for sources, skipping tests and other files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'check-hooks-'))
    mkdirSync(join(dir, 'ui'))
    for (const name of ['register.tsx', 'ui/band.ts', 'ui/band.test.ts', 'notes.md']) writeFileSync(join(dir, name), '')
    const found = sourceFiles(dir).map(f => f.slice(dir.length + 1).replaceAll('\\', '/'))
    expect(found.sort()).toEqual(['register.tsx', 'ui/band.ts'])
  })
})
