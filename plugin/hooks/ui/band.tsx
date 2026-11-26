import { atom, read } from 'claude-code'
import type { EngineInterface, RenderElement, RenderInput } from 'claude-code'

import { formatString } from '../../core/data/load'
import type { TokenShieldBand } from '../../types'
import { host } from '../host/host'
import { cancelConfirm, confirmSetup } from './check'

/** What the band shows; `null` hides it (design D8, D13). */
const bandAtom = atom({ plugin: 'token-shield', key: 'band' } as const, null as TokenShieldBand)

/**
 * Draws the above-prompt band: one row labelled Token Shield. In state mode
 * it shows the state, the cost and the recommended lever while the cache is
 * EXPIRING, COLD or INVALIDATED (REQ-9.0.3); in confirm mode it asks before
 * an action, with Confirm and Cancel (design D8), so a confirmation never
 * becomes a tool call the model sees.
 *
 * @param $ the engine interface
 * @param e the AbovePrompt render request
 * @returns the band's row, or `null` to leave the row to whatever is beneath
 */
export async function drawBand($: EngineInterface, e: RenderInput<'AbovePrompt'>): Promise<RenderElement | null> {
  const band = await read($, bandAtom)
  if (band === null || e.props.hasSurvey) return null
  const { Box, Button, Text } = $.ui.resolve(e)
  if (band.mode === 'confirm') {
    const s = host()?.data?.strings
    const label = (key: string, fallback: string) => (s ? formatString(s, key) : fallback)
    return (
      <Box flexDirection="row" gap={1}>
        <Text color="text-warning">{band.text}</Text>
        <Button key="confirm" label={label('button.confirm', 'Confirm')} onPress={() => runConfirmed($, band.lever)} />
        <Button key="cancel" label={label('button.cancel', 'Cancel')} onPress={() => cancelConfirm($)} />
      </Box>
    )
  }
  return (
    <Box>
      <Text color="text-warning">{band.text}</Text>
    </Box>
  )
}

/** Runs the action the band asked to confirm. */
async function runConfirmed($: EngineInterface, action: string | null): Promise<void> {
  if (action === 'setup') await confirmSetup($)
}
