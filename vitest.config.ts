import { defineConfig } from 'vitest/config'

/**
 * Vitest runs the engine-independent core's unit and parity tests.
 *
 * The tests live in `tests/`, outside `plugin/`, because `claude plugin test`
 * runs every `*.test.ts` inside the plugin folder in the engine's own
 * environment, where Vitest's imports do not exist.
 *
 * Coverage thresholds follow the full-tier testing standard: the modules a
 * wrong answer costs the user money in (assessor, cost model, gate,
 * recommendation) are held to 90%; the rest of the core to 80% lines and
 * 70% branches.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['plugin/core/**/*.ts'],
      reporter: ['text', 'json-summary', 'html'],
      thresholds: {
        lines: 80,
        branches: 70,
        'plugin/core/assess/**': { lines: 90, branches: 90 },
        'plugin/core/cost/**': { lines: 90, branches: 90 },
        'plugin/core/gate/**': { lines: 90, branches: 90 },
        'plugin/core/recommend/**': { lines: 90, branches: 90 },
      },
    },
  },
})
