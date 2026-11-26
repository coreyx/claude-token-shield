import { atom, read, update } from 'claude-code'
import type { EngineInterface, RenderElement, RenderInput } from 'claude-code'

import { formatString } from '../../core/data/load'
import type { TokenShieldArmed } from '../../types'
import { runCommandLever } from '../actions/levers'
import { host } from '../host/host'

/** Armed clear controls, by instance (design D11). */
const armedAtom = atom({ plugin: 'token-shield', key: 'armed' } as const, {} as TokenShieldArmed)

/** How long an armed clear control waits for its second press (REQ-17.0.2, 17.0.3). */
export const ARM_MS = 3000

/** The surfaces a lever button is drawn on. */
type ButtonSurface = RenderInput<'Placed'> | RenderInput<'AbovePrompt'> | RenderInput<'Pane'>

/**
 * One lever's button. Compact and the other command levers run on one
 * press. Clear arms on the first press, showing `CONFIRM?` inverse and bold
 * so it reads without color, and runs `/clear` only on a second press
 * within 3 s (REQ-17). The arm state is kept per instance, so a button in
 * the lever bar and one in a pane arm separately.
 *
 * @param $ the engine interface
 * @param e the render request the button is drawn in
 * @param lever the lever
 * @param instance an id unique to this button on its surface
 * @param detail what the label carries after the command, such as its cost and the recommended mark (AC 17.5)
 */
export async function LeverButton($: EngineInterface, e: ButtonSurface, lever: string, instance: string, detail = ''): Promise<RenderElement> {
  const { Button, Text } = $.ui.resolve(e)
  const label = `/${lever}${detail === '' ? '' : ` ${detail}`}`
  if (lever !== 'clear') return <Button key={lever} label={label} onPress={() => runCommandLever($, lever)} />
  const armedAt = (await read($, armedAtom))[instance]
  const now = await $.clock.now()
  if (armedAt !== undefined && now - armedAt < ARM_MS) {
    const s = host()?.data?.strings
    return (
      <Button key={lever} onPress={() => pressClear($, instance)}>
        <Text inverse bold>
          {s ? formatString(s, 'lever.confirm_clear') : 'CONFIRM?'}
        </Text>
      </Button>
    )
  }
  return <Button key={lever} label={label} onPress={() => pressClear($, instance)} />
}

/**
 * A press of a clear control: runs `/clear` when armed less than 3 s ago,
 * otherwise arms it and schedules the disarm. The disarm checks it is
 * clearing the same arming, so an old timer never cuts a newer one short.
 *
 * @param $ the engine interface
 * @param instance the button's id
 */
export async function pressClear($: EngineInterface, instance: string): Promise<void> {
  const now = await $.clock.now()
  const armedAt = (await read($, armedAtom))[instance]
  if (armedAt !== undefined && now - armedAt < ARM_MS) {
    await update($, armedAtom, armed => without(armed, instance))
    await runCommandLever($, 'clear')
    return
  }
  await update($, armedAtom, armed => ({ ...armed, [instance]: now }))
  $.clock.after(ARM_MS, () => void disarm($, instance, now))
}

/** Clears one arming if it is still the current one. */
async function disarm($: EngineInterface, instance: string, armedAt: number): Promise<void> {
  await update($, armedAtom, armed => (armed[instance] === armedAt ? without(armed, instance) : armed))
}

/** The armed map without one instance. */
function without(armed: TokenShieldArmed, instance: string): TokenShieldArmed {
  const next = { ...armed }
  delete next[instance]
  return next
}
