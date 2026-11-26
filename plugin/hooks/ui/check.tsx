import { atom, read, update } from 'claude-code'
import type { EngineInterface, RenderElement, RenderInput } from 'claude-code'

import { formatString } from '../../core/data/load'
import { sinceRange, summarize } from '../../core/history/summarize'
import { renderCheck } from '../../core/render/check'
import { adviceReport } from '../../core/history/advice'
import { baseline, installTime } from '../../core/history/baseline'
import { adviseTtl } from '../../core/history/ttl'
import { calibrate } from '../../core/history/calibrate'
import { renderCalibration, renderHistory, renderTtlAdvice } from '../../core/render/history'
import { glyphParams, glyphSet } from '../../core/render/format'
import type { TokenShieldBand, TokenShieldLevers, TokenShieldPane } from '../../types'
import { isCommandLever } from '../actions/levers'
import { recordedAssessments } from '../actions/calibration'
import { cancelKeepAliveOffer, offerKeepAlive } from '../actions/keepalive'
import { offerProbe } from '../actions/probe'
import { offerBackfillOnce, offerForget } from '../actions/store'
import { cancelSetting, offerSetting } from '../actions/settings'
import { host } from '../host/host'
import { flushHistory, historySessions, readSessionHistory } from '../persist/history'
import { evaluateFor, isTurnRunning } from '../session/model'
import { LeverButton } from './lever-button'
import { PANE_ID } from './pane'

/** The pane's text (design D7: a mid-turn /cache-check opens the pane instead). */
const paneAtom = atom({ plugin: 'token-shield', key: 'pane' } as const, null as TokenShieldPane)
/** The band, set to confirm mode by /cache-check setup (design D8). */
const bandAtom = atom({ plugin: 'token-shield', key: 'band' } as const, null as TokenShieldBand)
/** The command levers the lever bar offers (design D7). */
const leversAtom = atom({ plugin: 'token-shield', key: 'levers' } as const, [] as TokenShieldLevers)

/** The lever bar's id. */
export const LEVER_BAR_ID = 'token-shield-levers'

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
  if (option === 'keepalive') return shown(await offerKeepAlive($, words.slice(1)))
  if (option === '--probe' && words.slice(1).every(w => w === '--force')) return shown(await offerProbe($, words.includes('--force')))
  if (option === 'history') {
    const text = await answerHistory($, words.slice(1), Math.max(40, columns))
    return text === null ? shown(t('command.history_usage')) : showOrPane($, text, t('pane.title'))
  }
  if (option === 'forget' && words.length === 1) return shown(await offerForget($))
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
  if (isTurnRunning()) return showOrPane($, text, t('pane.title'))
  const levers = ev.quotes.filter(q => q.kind === 'command' && isCommandLever(q.lever)).map(q => q.lever)
  await update($, leversAtom, () => levers)
  if (levers.length > 0) await $.ui.place({ id: LEVER_BAR_ID })
  return shown(text)
}

/**
 * The bare `/cache-check ttl [--since 30d]` (REQ-16): the TTL advisor over
 * every session in the window, and when the main conversation has a
 * recommendation, that setting offered in the band's confirm mode through
 * the settings writer. Nothing changes until Confirm.
 *
 * @param $ the engine interface
 * @param words the arguments after `ttl`
 * @param t the string formatter
 */
async function adviseAndOffer($: EngineInterface, words: readonly string[], t: (key: string, params?: Record<string, string>) => string): Promise<string> {
  const h = host()!
  if (words.length !== 0 && words.length !== 2) return t('command.ttl_usage')
  const range = sinceRange(words[1], await $.clock.now())
  if (range === null) return t('command.ttl_usage')
  const dir = h.companions.dataDir
  await flushHistory($, dir, h.sessionId)
  const sessions = await Promise.all((await historySessions($, dir)).map(id => readSessionHistory($, dir, id)))
  const advice = adviseTtl(sessions, range, h.data!.prices, h.env.provider)
  const text = renderTtlAdvice(advice, 100, { glyphs: glyphSet(h.config.glyphs), strings: h.data!.strings, display: h.data!.rules.display, tzOffsetMin: h.tzOffsetMin })
  const lines = [text]
  if (advice.subagent.recommended !== null) lines.push(t('ttl.apply', { ttl: advice.subagent.recommended, subagent: ' --subagent' }))
  if (advice.main.recommended !== null) lines.push('', await offerSetting($, { key: 'promptCacheTtl', value: advice.main.recommended }))
  return lines.join('\n')
}

/**
 * Answers display-only, or while a main turn runs puts the text in the Token
 * Shield pane and answers empty (design D7): a mid-turn answer can stay in
 * later requests.
 *
 * @param $ the engine interface
 * @param text what to show
 * @param title the pane's title
 */
async function showOrPane($: EngineInterface, text: string, title: string) {
  if (!isTurnRunning()) return shown(text)
  await update($, paneAtom, () => ({ tab: 'check' as const, text }))
  await $.ui.open({ id: PANE_ID, title })
  return shown('')
}

/**
 * `/cache-check history [--session <id>|--all] [--since 7d] [--misses]`
 * (AC 6.5): this session's history unless told otherwise, the same summary
 * `tshield history` prints. The session's buffered records are flushed
 * first so its own latest requests are counted.
 *
 * @param $ the engine interface
 * @param words the arguments after `history`
 * @param width the width to render at
 * @returns the text, or `null` when the arguments don't parse
 */
async function answerHistory($: EngineInterface, words: readonly string[], width: number): Promise<string | null> {
  const h = host()!
  if (words.includes('--calibration')) return answerCalibration($, words.filter(w => w !== '--calibration'), width)
  let session: string | undefined
  let since: string | undefined
  let all = false
  let misses = false
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    if (w === '--all') all = true
    else if (w === '--misses') misses = true
    else if ((w === '--session' || w === '--since') && words[i + 1] !== undefined) {
      if (w === '--session') session = words[++i]
      else since = words[++i]
    } else return null
  }
  const range = sinceRange(since, await $.clock.now())
  if (range === null || (all && session !== undefined)) return null
  const dir = h.companions.dataDir
  await flushHistory($, dir, h.sessionId)
  const ids = all ? await historySessions($, dir) : [session ?? h.sessionId]
  const sessions = await Promise.all(ids.map(id => readSessionHistory($, dir, id)))
  const summary = summarize(sessions, range, { misses }, h.data!.prices, h.env.provider)
  const advice = adviceReport(sessions, range, { misses }, h.data!.prices)
  // The baseline: the transcripts backfilled from before the install, against this window.
  const everyone = all ? sessions : await Promise.all((await historySessions($, dir)).map(id => readSessionHistory($, dir, id)))
  const backfilled = await Promise.all((await historySessions($, dir, 'backfill')).map(id => readSessionHistory($, dir, id, 'backfill')))
  const base = baseline(backfilled, installTime(everyone), summary, h.data!.prices, h.env.provider)
  return renderHistory(summary, width, { glyphs: glyphSet(h.config.glyphs), strings: h.data!.strings, display: h.data!.rules.display, tzOffsetMin: h.tzOffsetMin }, advice, base)
}

/**
 * `/cache-check history --calibration [--since 30d]` (REQ-14.0.5): how well
 * predictions matched outcomes across every session in the window, the same
 * table `tshield calibration` prints.
 *
 * @param $ the engine interface
 * @param words the other arguments
 * @param width the width to render at
 * @returns the text, or `null` when the arguments don't parse
 */
async function answerCalibration($: EngineInterface, words: readonly string[], width: number): Promise<string | null> {
  const h = host()!
  if (words.length !== 0 && !(words.length === 2 && words[0] === '--since')) return null
  const now = await $.clock.now()
  const range = sinceRange(words[1] ?? `${h.config.historyDays}d`, now)
  if (range === null) return null
  await flushHistory($, h.companions.dataDir, h.sessionId)
  const p = h.data!.rules.priors
  const cal = calibrate(await recordedAssessments($, range.from), { epsWithin: p.epsWithin, epsAfter: p.epsAfter, minCalibrationN: p.minCalibrationN })
  return renderCalibration(cal, p.minCalibrationN, width, { glyphs: glyphSet(h.config.glyphs), strings: h.data!.strings, display: h.data!.rules.display, tzOffsetMin: h.tzOffsetMin })
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
  if (words.length === 0 || words[0] === '--since') return adviseAndOffer($, words, t)
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
    if (r.exitCode === 0) await offerBackfillOnce($)
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
  const wasKeepAlive = cancelKeepAliveOffer()
  const byAction: Record<string, string> = { probe: 'probe.cancelled', forget: 'forget.cancelled', backfill: 'backfill.cancelled' }
  const key = wasSetting ? 'setting.cancelled' : wasKeepAlive ? 'keepalive.cancelled' : (byAction[action ?? ''] ?? 'setup.cancelled')
  if (h?.data) $.ui.toast(formatString(h.data.strings, key))
}
