import { atom, read } from 'claude-code'
import type { EngineInterface, RenderElement, RenderInput } from 'claude-code'

import { formatString } from '../../core/data/load'
import type { TokenShieldBand } from '../../types'
import { host } from '../host/host'
import { offerKeepAlive, startKeepAlive, stopKeepAlive } from '../actions/keepalive'
import { runProbe } from '../actions/probe'
import { confirmSetting } from '../actions/settings'
import { cancelConfirm, confirmSetup } from './check'

/** What the band shows; `null` hides it (design D8, D13). */
const bandAtom = atom({ plugin: 'token-shield', key: 'band' } as const, null as TokenShieldBand)

/** Each band action's button label key and its English fallback. */
const ACTIONS: Readonly<Record<string, { readonly label: string; readonly fallback: string }>> = {
  keepalive: { label: 'button.keepalive', fallback: 'Keep warm' },
  stop: { label: 'button.stop', fallback: 'Stop' },
}

/**
 * Draws the above-prompt band: one row labelled Token Shield. In state mode
 * it shows the state, the cost and the recommended lever while the cache is
 * EXPIRING, COLD or INVALIDATED (REQ-9.0.3); in confirm mode it asks before
 * an action, with Confirm and Cancel (design D8), so a confirmation never
 * becomes a tool call the model sees. A band's `actions` add buttons beside
 * its text: Keep warm while EXPIRING, Stop while a keep-alive runs.
 *
 * @param $ the engine interface
 * @param e the AbovePrompt render request
 * @returns the band's row, or `null` to leave the row to whatever is beneath
 */
export async function drawBand($: EngineInterface, e: RenderInput<'AbovePrompt'>): Promise<RenderElement | null> {
  const band = await read($, bandAtom)
  if (band === null || e.props.hasSurvey) return null
  const { Box, Button, Text } = $.ui.resolve(e)
  const s = host()?.data?.strings
  const label = (key: string, fallback: string) => (s ? formatString(s, key) : fallback)
  if (band.mode === 'confirm') {
    return (
      <Box flexDirection="row" gap={1}>
        <Text color="text-warning">{band.text}</Text>
        <Button key="confirm" label={label('button.confirm', 'Confirm')} onPress={() => runConfirmed($, band.lever)} />
        <Button key="cancel" label={label('button.cancel', 'Cancel')} onPress={() => cancelConfirm($)} />
      </Box>
    )
  }
  const buttons = (band.actions ?? [])
    .filter(id => id in ACTIONS)
    .map(id => <Button key={id} label={label(ACTIONS[id]!.label, ACTIONS[id]!.fallback)} onPress={() => pressAction($, id)} />)
  return (
    <Box flexDirection="row" gap={1}>
      <Text color="text-warning">{band.text}</Text>
      {buttons}
    </Box>
  )
}

/** Runs a band button's action. */
async function pressAction($: EngineInterface, id: string): Promise<void> {
  if (id === 'keepalive') await offerKeepAlive($, [])
  else if (id === 'stop') await stopKeepAlive($, 'user')
}

/** Runs the action the band asked to confirm. */
async function runConfirmed($: EngineInterface, action: string | null): Promise<void> {
  if (action === 'setup') await confirmSetup($)
  else if (action === 'setting') await confirmSetting($)
  else if (action === 'probe') await runProbe($)
  else if (action === 'keepalive') await startKeepAlive($)
}
