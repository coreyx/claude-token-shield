import { describe, expect, it } from 'vitest'

import { CORE_VERSION, MIN_CLAUDE_CODE_VERSION } from '../../plugin/core/version'

describe('core version constants', () => {
  it('names a positive core version', () => {
    expect(CORE_VERSION).toBeGreaterThan(0)
  })

  it('pins the minimum Claude Code version to the first with miss causes', () => {
    expect(MIN_CLAUDE_CODE_VERSION).toBe('2.1.260')
  })
})
