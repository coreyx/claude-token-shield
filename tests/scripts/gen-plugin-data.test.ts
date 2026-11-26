import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { generate } from '../../scripts/gen-plugin-data.mjs'

describe('plugin/test/data.generated.ts', () => {
  it('matches the shared data files (run node scripts/gen-plugin-data.mjs after editing plugin/data)', () => {
    const current = readFileSync(fileURLToPath(new URL('../../plugin/test/data.generated.ts', import.meta.url)), 'utf8')
    expect(current).toBe(generate())
  })
})
