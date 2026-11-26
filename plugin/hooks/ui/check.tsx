import { atom, read, update } from 'claude-code'
import type { EngineInterface, RenderElement, RenderInput } from 'claude-code'

import { formatString } from '../../core/data/load'
import { renderCheck } from '../../core/render/check'
import { glyphParams, glyphSet } from '../../core/render/format'
import type { TokenShieldBand, TokenShieldLevers, TokenShieldPane } from '../../types'
import { isCommandLever } from '../actions/levers'
import { offerProbe } from '../actions/probe'
import { cancelSetting, offerSetting } from '../actions/settings'
import { host } from '../host/host'
import { evaluateFor, isTurnRunning } from '../session/model'
import { LeverButton } from './lever-button'

/** The pane's text (design D7: a mid-turn /cache-check opens the pane instead). */
const paneAtom = atom({ plugin: 'token-shield', key: 'pane' } as const, null as TokenShieldPane)
/** The band, set to confirm mode by /cache-check setup (design D8). */
const bandAtom = atom({ plugin: 'token-shield', key: 'band' } as const, null as TokenShieldBand)
/** The command levers the lever bar offers (design D7). */
const leversAtom = atom({ plugin: 'token-shield', key: 'levers' } as const, [] as TokenShieldLevers)

/** The pane's and the lever bar's ids. */
export const PANE_ID = 'token-shield'
export const LEVER_BAR_ID = 'token-shield-levers'

/** Options built in later tasks; until then they say so. */
const LATER = new Set(['history', 'keepalive', 'forget'])

/** A display-only answer: shown to the person, never sent in a request (REQ-6.0.5). */
function shown(text: string) {
  return { text, isTextDisplayOnly: true as const }
}

/**
 * Answers `/cache-check [--verbose|--diff|setup]` without a model call and
 * without anything reaching a request (design D7). While a main turn runs,
 * the text goes to the Token Shield pane and the answer is empty, since a
 * mid-turn answer can stay in later requests.
 *
 * @param $ the engine interface
 * @param args the command's arguments as typed
 * @param columns the width the answer is drawn at
 */
export async function answerCacheCheck($: EngineInterface, args: string, columns: number) {
  const h = host()
  const t = (key: string, params: Record<string, string> = {}) =>
    h?.data ? formatString(h.data.strings, key, { ...glyphParams(glyphSet(h.config.glyphs)), ...params }) : `Token Shield: ${key}`
  if (h === null || h.data === null) return shown(t('command.off', { reason: 'not started' }))
  if (!h.enabled) return shown(t('error.version', { version: h.data.rules.minClaudeCodeVersion }))

  const words = args.trim() === '' ? [] : args.trim().split(/\s+/)
  const option = words[0]
  if (option === 'setup') return shown(await offerSetup($))
  if (option === 'ttl') return shown(await offerTtl($, words.slice(1), t))
  if (option === '--probe' && words.slice(1).every(w => w === '--force')) return shown(await offerProbe($, words.includes('--force')))
  if (option !== undefined && LATER.has(option)) return shown(t('command.not_yet', { option }))
  if (option !== undefined && option !== '--verbose' && option !== '--diff') return shown(t('command.unknown_option', { option }))

  const mode = option === '--verbose' ? 'verbose' : option === '--diff' ? 'diff' : 'default'
  const ev = await evaluateFor($, mode)
  if (ev === null) return shown(t('command.off', { reason: 'unsupported version' }))
  const text = renderCheck(ev.view, Math.max(40, columns), {
    glyphs: glyphSet(h.config.glyphs),
    strings: h.data.strings,
    display: h.data.rules.display,
    tzOffsetMin: h.tzOffsetMin,
  })
  if (isTurnRunning()) {
    await update($, paneAtom, () => ({ text }))
    await $.ui.open({ id: PANE_ID, title: t('pane.title') })
    return shown('')
  }
  const levers = ev.quotes.filter(q => q.kind === 'command' && isCommandLever(q.lever)).map(q => q.lever)
  await update($, leversAtom, () => levers)
  if (levers.length > 0) await $.ui.place({ id: LEVER_BAR_ID })
  return shown(text)
}

/**
 * Draws the Token Shield pane: the last check rendered for it.
 *
 * @param $ the engine interface
 * @param e the Pane render request
 * @returns the pane's content, or `null` for another plugin's pane
 */
export async function drawPane($: EngineInterface, e: RenderInput<'Pane'>): Promise<RenderElement | null> {
  if (e.requestId !== PANE_ID) return null
  const pane = await read($, paneAtom)
  const { Box, Text } = $.ui.resolve(e)
  return (
    <Box flexDirection="column">
      {(pane?.text ?? '').split('\n').map((line, i) => (
        <Text key={`l${i}`}>{line}</Text>
      ))}
    </Box>
  )
}

/**
 * Draws the lever bar placed under a /cache-check answer: a LeverButton per
 * command lever the last check found applicable (REQ-17.0.5). It is placed
 * only from the main session's own /cache-check, so no control is offered for
 * a subagent or another session (REQ-17.0.4).
 *
 * @param $ the engine interface
 * @param e the Placed render request
 * @returns the bar, or `null` for another placed row
 */
export async function drawLeverBar($: EngineInterface, e: RenderInput<'Placed'>): Promise<RenderElement | null> {
  if (e.props.id !== LEVER_BAR_ID || e.props.plugin !== 'token-shield') return null
  // Not 'h': JSX compiles to calls of the global h, which a local of that name would shadow.
  const shield = host()
  const title = shield?.data ? formatString(shield.data.strings, 'levers.title') : 'Token Shield levers:'
  const levers = await read($, leversAtom)
  const buttons: RenderElement[] = []
  for (const lever of levers) buttons.push(await LeverButton($, e, lever, `bar:${lever}`))
  const { Box, Text } = $.ui.resolve(e)
  return (
    <Box flexDirection="row" gap={1}>
      <Text dimColor>{title}</Text>
      {buttons}
    </Box>
  )
}

/**
 * `/cache-check ttl 5m|1h [--subagent]`: offers the TTL setting through the
 * settings writer's confirm band. The advisor (TASK-30) adds the bare form.
 *
 * @param $ the engine interface
 * @param words the arguments after `ttl`
 * @param t the string formatter
 */
async function offerTtl($: EngineInterface, words: readonly string[], t: (key: string, params?: Record<string, string>) => string): Promise<string> {
  const value = words.find(w => w === '5m' || w === '1h')
  if (value === undefined || words.some(w => w !== value && w !== '--subagent')) return t('command.ttl_usage')
  return offerSetting($, { key: words.includes('--subagent') ? 'subagentPromptCacheTtl' : 'promptCacheTtl', value })
}

/**
 * Offers the statusline bridge's setup through the band's confirm mode
 * (design D8): nothing is written until the person presses Confirm.
 *
 * @returns the line /cache-check answers with
 */
async function offerSetup($: EngineInterface): Promise<string> {
  const h = host()!
  const s = h.data!.strings
  const g = glyphParams(glyphSet(h.config.glyphs))
  if (h.companions.bin === null) return formatString(s, 'setup.no_binary')
  const text = formatString(s, 'setup.confirm', g)
  await update($, bandAtom, () => ({ mode: 'confirm' as const, text, lever: 'setup' }))
  return text
}

/**
 * Runs the confirmed setup through tshield, the same flow `tshield setup`
 * runs, and reports how it went.
 *
 * @param $ the engine interface
 */
export async function confirmSetup($: EngineInterface): Promise<void> {
  const h = host()
  await update($, bandAtom, () => null)
  if (h === null || h.data === null || h.companions.bin === null) return
  const s = h.data.strings
  try {
    const r = await $.process.run([h.companions.bin, 'setup', '--yes'], { timeoutMs: 60_000 })
    $.ui.toast(r.exitCode === 0 ? formatString(s, 'setup.done') : formatString(s, 'setup.failed', { reason: (r.stdout + r.stderr).trim().split('\n').pop() ?? `exit ${r.exitCode}` }))
  } catch (err) {
    $.ui.toast(formatString(s, 'setup.failed', { reason: err instanceof Error ? err.message : 'tshield did not run' }))
  }
}

/**
 * Cancels whatever the band asked to confirm.
 *
 * @param $ the engine interface
 */
export async function cancelConfirm($: EngineInterface): Promise<void> {
  const h = host()
  const action = (await read($, bandAtom))?.lever
  await update($, bandAtom, () => null)
  const wasSetting = await cancelSetting($)
  const key = wasSetting ? 'setting.cancelled' : action === 'probe' ? 'probe.cancelled' : 'setup.cancelled'
  if (h?.data) $.ui.toast(formatString(h.data.strings, key))
}
