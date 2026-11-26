import type { EngineInterface } from 'claude-code'

import type { AssessEnv } from '../../core/assess/types'

/**
 * Reads the environment that decides how some events affect the cache
 * (rules.json cases): the provider requests go to, whether MCP tool search is
 * on, and whether experimental betas (per-message effort) are off.
 *
 * @param $ the engine interface
 */
export async function readEnv($: EngineInterface): Promise<AssessEnv> {
  const [bedrock, vertex, foundry, toolSearch, betasOff] = await Promise.all([
    $.env.get('CLAUDE_CODE_USE_BEDROCK'),
    $.env.get('CLAUDE_CODE_USE_VERTEX'),
    $.env.get('CLAUDE_CODE_USE_FOUNDRY'),
    $.env.get('ENABLE_TOOL_SEARCH'),
    $.env.get('CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS'),
  ])
  const on = (v: string | undefined) => v === '1' || v === 'true'
  const provider = on(bedrock) ? 'bedrock' : on(vertex) ? 'vertex' : on(foundry) ? 'foundry' : 'firstParty'
  // Tool search is on unless turned off; with it on, tool changes append rather than rewrite.
  return { provider, toolSearch: !(toolSearch === '0' || toolSearch === 'false'), experimentalBetasDisabled: on(betasOff) }
}
