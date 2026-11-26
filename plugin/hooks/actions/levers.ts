import type { EngineInterface } from 'claude-code'

import { formatString } from '../../core/data/load'
import { host } from '../host/host'

/** Each command lever's slash command, without the slash. */
const COMMANDS: Readonly<Record<string, string>> = {
  compact: 'compact',
  clear: 'clear',
  rewind: 'rewind',
  recap: 'recap',
  btw: 'btw',
}

/** Whether a lever is one the runner runs as a slash command. */
export function isCommandLever(id: string): boolean {
  return id in COMMANDS
}

/**
 * Runs a command lever the way typing it would (REQ-5.0.1, design D11):
 * through `$.command.run`, so Claude Code does exactly what `/compact` or
 * `/clear` does. `/btw` needs the question, so it goes into the prompt for
 * the person to finish and send. A failure is reported in a toast and
 * nothing else changes (REQ-5.0.5).
 *
 * @param $ the engine interface
 * @param id the lever
 * @param args what follows the command, if anything
 */
export async function runCommandLever($: EngineInterface, id: string, args = ''): Promise<void> {
  const command = COMMANDS[id]
  if (command === undefined) return
  try {
    if (id === 'btw') {
      await $.prompt.fill({ text: `/btw ${args}` })
      return
    }
    const r = await $.command.run({ command, args })
    if (r.exitCode !== undefined && r.exitCode !== 0) failed($, command, r.text?.trim() || `exit ${r.exitCode}`)
  } catch (err) {
    failed($, command, err instanceof Error ? err.message : 'it was refused')
  }
}

/** Reports a lever that didn't run. */
function failed($: EngineInterface, command: string, reason: string): void {
  const s = host()?.data?.strings
  $.ui.toast(s ? formatString(s, 'lever.failed', { command: `/${command}`, reason }) : `Token Shield: /${command} didn't run (${reason}).`)
}
