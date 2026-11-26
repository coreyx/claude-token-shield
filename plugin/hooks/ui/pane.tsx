import { atom, read, update } from 'claude-code'
import type { EngineInterface, RenderElement, RenderInput } from 'claude-code'

import { formatString } from '../../core/data/load'
import { adviceReport } from '../../core/history/advice'
import type { AdviceReport } from '../../core/history/advice'
import { calibrate } from '../../core/history/calibrate'
import type { Calibration } from '../../core/history/calibrate'
import { sinceRange, summarize } from '../../core/history/summarize'
import type { HistorySummary } from '../../core/history/summarize'
import { adviseTtl } from '../../core/history/ttl'
import type { TtlAdvice } from '../../core/history/ttl'
import { formatPercent, formatUsd, glyphParams, glyphSet } from '../../core/render/format'
import { renderCalibration, renderTtlAdvice } from '../../core/render/history'
import { renderContext } from '../../core/render/views/context'
import { renderDashboard } from '../../core/render/views/dashboard'
import { renderLevers } from '../../core/render/views/levers'
import { layersOf, renderPrefixMap } from '../../core/render/views/map'
import { renderRunway } from '../../core/render/views/runway'
import type { TokenShieldContext, TokenShieldDashboard, TokenShieldPane, TokenShieldPaneTab, TokenShieldTick } from '../../types'
import { isCommandLever } from '../actions/levers'
import { host } from '../host/host'
import { reportFailure } from '../host/failure'
import { flushHistory, historySessions, readSessionHistory } from '../persist/history'
import { currentEvaluation, modelState } from '../session/model'
import { LeverButton } from './lever-button'

/** The pane: its tab and the last mid-turn check (design D7). */
const paneAtom = atom({ plugin: 'token-shield', key: 'pane' } as const, null as TokenShieldPane)

/** The context breakdown, fetched off the render path when the Context view opens. */
const contextAtom = atom({ plugin: 'token-shield', key: 'context' } as const, null as TokenShieldContext)
/** Bumped every few seconds while the runway is shown, so it redraws. */
const tickAtom = atom({ plugin: 'token-shield', key: 'tick' } as const, 0 as TokenShieldTick)

/** The history dashboard's data, gathered off the render path (REQ-13.0.5). */
const dashboardAtom = atom({ plugin: 'token-shield', key: 'dashboard' } as const, null as TokenShieldDashboard)

/** What loadDashboard stores in the dashboard value. */
interface Dashboard {
  readonly summary: HistorySummary
  readonly advice: AdviceReport
  readonly calibration: Calibration
  readonly ttl: TtlAdvice
}

/** How often the runway redraws while it is shown. */
export const RUNWAY_REFRESH_MS = 5_000

/** The pane's id. */
export const PANE_ID = 'token-shield'

/** The five views, in tab order; their hotkeys are 1 to 5. */
export const VIEWS: readonly TokenShieldPaneTab[] = ['map', 'runway', 'levers', 'context', 'history']

/** The catalog formatter with glyphs, or `null` before the host starts. */
function formatter() {
  const h = host()
  if (h === null || h.data === null) return null
  const g = glyphParams(glyphSet(h.config.glyphs))
  return (key: string, params: Record<string, string | number> = {}) => formatString(h.data!.strings, key, { ...g, ...params })
}

/**
 * `/cache-view [map|runway|levers|context|history]` (REQ-13): opens the
 * Token Shield pane on a view, the prefix map by default. The answer is
 * display-only and names where the view is.
 *
 * @param $ the engine interface
 * @param args the command's arguments
 */
export async function openView($: EngineInterface, args: string) {
  const t = formatter()
  const tab = (args.trim() || 'map') as TokenShieldPaneTab
  if (t === null) return { text: 'Token Shield: not started.', isTextDisplayOnly: true as const }
  if (!VIEWS.includes(tab)) return { text: t('view.usage'), isTextDisplayOnly: true as const }
  await showTab($, tab)
  await $.ui.open({ id: PANE_ID, title: t('pane.title') })
  return { text: t('view.opened', { view: t(`view.tab.${tab}`) }), isTextDisplayOnly: true as const }
}

/** Switches the pane to a tab, keeping the last mid-turn check, and fetches what the tab needs. */
async function showTab($: EngineInterface, tab: TokenShieldPaneTab): Promise<void> {
  await update($, paneAtom, current => ({ tab, text: current?.text ?? null }))
  if (tab === 'context' || tab === 'map') await refreshContext($)
  if (tab === 'history') await loadDashboard($)
}

/**
 * Fetches the context breakdown for the Context view and the map's layers,
 * outside drawing: it asks the engine to count the prefix.
 *
 * @param $ the engine interface
 */
export async function refreshContext($: EngineInterface): Promise<void> {
  try {
    const usage = await $.session.usage({ breakdown: 'summary' })
    const rows = (usage.context.breakdown?.categories ?? []).map(c => ({ name: c.name, tokens: c.tokens, kind: c.kind }))
    await update($, contextAtom, () => rows)
  } catch (err) {
    reportFailure($, 'context breakdown', err)
  }
}

/**
 * Gathers the history dashboard: every session's history in the last 30
 * days, summarized with its advice, calibration and TTL advice. It reads
 * files, so it runs when the tab opens, never while drawing (REQ-13.0.5).
 *
 * @param $ the engine interface
 */
export async function loadDashboard($: EngineInterface): Promise<void> {
  try {
    const h = host()
    if (h === null || h.data === null) return
    const dir = h.companions.dataDir
    await flushHistory($, dir, h.sessionId)
    const sessions = await Promise.all((await historySessions($, dir)).map(id => readSessionHistory($, dir, id)))
    const range = sinceRange(undefined, await $.clock.now())!
    const p = h.data.rules.priors
    const assessments = sessions.flatMap(s => s.assessments ?? []).filter(a => a.ts >= range.from)
    const data = {
      summary: summarize(sessions, range, { misses: false }, h.data.prices, h.env.provider),
      advice: adviceReport(sessions, range, { misses: false }, h.data.prices),
      calibration: calibrate(assessments, { epsWithin: p.epsWithin, epsAfter: p.epsAfter, minCalibrationN: p.minCalibrationN }),
      ttl: adviseTtl(sessions, range, h.data.prices, h.env.provider),
    }
    await update($, dashboardAtom, () => data)
  } catch (err) {
    reportFailure($, 'history dashboard', err)
  }
}

/**
 * The runway's refresh: bumps the tick while the pane is shown on the runway,
 * so its now marker moves (REQ-13.0.2); otherwise does nothing.
 *
 * @param $ the engine interface
 */
export async function refreshRunway($: EngineInterface): Promise<void> {
  const pane = await read($, paneAtom)
  if (pane?.tab !== 'runway') return
  const shown = (await $.ui.panes()).some(p => p.id === PANE_ID && p.isShown)
  if (shown) await update($, tickAtom, n => n + 1)
}

/**
 * Draws the Token Shield pane: a tab row (pressable, with hotkeys 1 to 5,
 * and Check while a mid-turn check is held), then the tab's view at the
 * pane's width, all from the same data as /cache-check (REQ-13).
 *
 * @param $ the engine interface
 * @param e the Pane render request
 * @returns the pane's content, or `null` for another plugin's pane
 */
export async function drawPane($: EngineInterface, e: RenderInput<'Pane'>): Promise<RenderElement | null> {
  if (e.requestId !== PANE_ID) return null
  const pane = await read($, paneAtom)
  const tab = pane?.tab ?? 'map'
  // Read so the runway redraws when the tick moves.
  await read($, tickAtom)
  const t = formatter()
  const { Box, Button, Text } = $.ui.resolve(e)
  if (t === null) return <Text>Token Shield: not started.</Text>
  const tabs = [...(pane?.text != null ? (['check'] as const) : []), ...VIEWS]
  const body = await viewText($, tab, pane?.text ?? null, Math.max(40, e.props.bodyColumns))
  const buttons = tab === 'levers' ? await leverButtons($, e) : []
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" gap={1}>
        {tabs.map(id => {
          const hotkey = VIEWS.indexOf(id) + 1
          return (
            <Button
              key={`tab:${id}`}
              label={id === tab ? `[${t(`view.tab.${id}`)}]` : t(`view.tab.${id}`)}
              {...(hotkey > 0 ? { hotkey: String(hotkey) } : {})}
              onPress={() => showTab($, id)}
            />
          )
        })}
      </Box>
      {body.split('\n').map((line, i) => (
        <Text key={`l${i}`}>{line}</Text>
      ))}
      {buttons.length > 0 ? (
        <Box flexDirection="row" gap={1}>
          {buttons}
        </Box>
      ) : null}
    </Box>
  )
}

/**
 * The comparator's run buttons (REQ-13.0.3, AC 13.3, 17.5): a LeverButton per
 * command lever quoted, the same control as the lever bar's, so a lever run
 * here behaves exactly as from /cache-check. Each label carries the lever's
 * cost now and, for the recommended one, the mark.
 */
async function leverButtons($: EngineInterface, e: RenderInput<'Pane'>): Promise<RenderElement[]> {
  const h = host()!
  const ev = await currentEvaluation($)
  if (ev === null) return []
  const pick = glyphSet(h.config.glyphs).pick
  const out: RenderElement[] = []
  for (const q of ev.quotes) {
    if (!isCommandLever(q.lever)) continue
    const cost = q.now.usd !== null ? formatUsd(q.now.usd) : '?'
    out.push(await LeverButton($, e, q.lever, `pane:${q.lever}`, q.lever === ev.rec.lever ? `${cost} ${pick}` : cost))
  }
  return out
}

/** A tab's text at a width; views built later say so. */
async function viewText($: EngineInterface, tab: TokenShieldPaneTab, check: string | null, width: number): Promise<string> {
  const h = host()!
  const o = { glyphs: glyphSet(h.config.glyphs), strings: h.data!.strings, display: h.data!.rules.display, tzOffsetMin: h.tzOffsetMin }
  const s = modelState()
  switch (tab) {
    case 'check':
      return check ?? ''
    case 'map': {
      const rows = await read($, contextAtom)
      return renderPrefixMap(s.requests, s.events, rows !== null ? layersOf(rows) : null, width, o, h.data!.prices)
    }
    case 'runway': {
      const ev = await currentEvaluation($)
      return ev === null ? formatString(o.strings, 'view.runway.unknown') : renderRunway(ev.a, ev.cost, width, o)
    }
    case 'levers': {
      const ev = await currentEvaluation($)
      return ev === null ? formatString(o.strings, 'view.runway.unknown') : renderLevers(ev.quotes, ev.rec, width, o)
    }
    case 'history': {
      const stored = await read($, dashboardAtom)
      if (stored === null) return formatString(o.strings, 'view.history.loading')
      // loadDashboard wrote these shapes; the contract can only call them unknown.
      const d = stored as unknown as Dashboard
      const p = h.data!.rules.priors
      const advice = d.advice.share !== null ? formatString(o.strings, 'history.advice', { cheapest: String(d.advice.cheapest), n: String(d.advice.evaluated), share: formatPercent(d.advice.share, 0) }) : null
      return renderDashboard(d.summary, { advice, calibration: renderCalibration(d.calibration, p.minCalibrationN, width, o), ttl: renderTtlAdvice(d.ttl, width, o) }, width, o)
    }
    case 'context': {
      const rows = await read($, contextAtom)
      return rows === null ? formatString(o.strings, 'view.context.loading') : renderContext(rows, width, o)
    }
    default:
      return formatString(o.strings, 'view.not_yet', { view: formatString(o.strings, `view.tab.${tab}`) })
  }
}
