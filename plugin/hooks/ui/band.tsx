import { atom, read } from 'claude-code'
import type { EngineInterface, RenderElement, RenderInput } from 'claude-code'

import type { TokenShieldBand } from '../../types'

/** What the band shows; `null` hides it (design D8, D13). */
const bandAtom = atom({ plugin: 'token-shield', key: 'band' } as const, null as TokenShieldBand)

/**
 * Draws the above-prompt band: one row labelled Token Shield with the state,
 * the cost and the recommended lever, while the cache is EXPIRING, COLD or
 * INVALIDATED (REQ-9.0.3).
 *
 * @param $ the engine interface
 * @param e the AbovePrompt render request
 * @returns the band's row, or `null` to leave the row to whatever is beneath
 */
export async function drawBand($: EngineInterface, e: RenderInput<'AbovePrompt'>): Promise<RenderElement | null> {
  const band = await read($, bandAtom)
  if (band === null || e.props.hasSurvey) return null
  const { Box, Text } = $.ui.resolve(e)
  return (
    <Box>
      <Text color="text-warning">{band.text}</Text>
    </Box>
  )
}
