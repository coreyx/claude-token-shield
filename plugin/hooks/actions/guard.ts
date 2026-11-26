import { atom, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import { eventImpact } from '../../core/assess/events'
import { changeGuard, switchGuard } from '../../core/guard/guard'
import type { SwitchFacts } from '../../core/guard/guard'
import { baseModelId } from '../../core/model/ids'
import type { NativeSnapshot } from '../../core/model/types'
import { changeGuardText, switchGuardText } from '../../core/render/band'
import { glyphSet } from '../../core/render/format'
import type { TokenShieldBand } from '../../types'
import { host } from '../host/host'
import { currentEvaluation, noteToast } from '../session/model'

/** The band, set to guard mode once a switch is shown. */
const bandAtom = atom({ plugin: 'token-shield', key: 'band' } as const, null as TokenShieldBand)

/** How long the switch toast stays up: Claude Code's confirmation hides the band meanwhile (spikes.md §2). */
export const SWITCH_TOAST_MS = 30_000

/** When the guard last showed a switch, to keep each burst to one warning. */
let lastShownAt: number | null = null
/** The switch shown and not yet seen through, to clear its band when it's settled. */
let shown: { readonly from: string; readonly at: number } | null = null

/** Starts the guard over for a new session. */
export function resetGuard(): void {
  lastShownAt = null
  shown = null
}

/** The render options and whether this billing mode shows dollars. */
function renderContext(h: NonNullable<ReturnType<typeof host>>) {
  return { glyphs: glyphSet(h.config.glyphs), strings: h.data!.strings, display: h.data!.rules.display, tzOffsetMin: h.tzOffsetMin }
}

/**
 * Weighs a `classic.PreModelSwitch` event (design D10). For the one event of
 * a warm switch worth showing, it toasts Claude Code's estimate with the
 * cheaper alternative for 30 s, so it stays up through Claude Code's own
 * confirmation, and puts the band in guard mode for after it closes.
 *
 * @param $ the engine interface
 * @param f the event's facts
 * @returns the Token Shield-labelled reason to ask Claude Code to confirm with, or `null` to add nothing
 */
export async function guardSwitch($: EngineInterface, f: SwitchFacts): Promise<string | null> {
  const h = host()
  const ev = await currentEvaluation($)
  if (h === null || h.data === null || ev === null) return null
  const g = switchGuard(f, ev.a.state, ev.billing, h.config, lastShownAt)
  if (g.action === 'silent') {
    if (g.why === 'not-requested' || g.why === 'same-burst') $.ui.log(`token-shield: switch event to ${f.to} not shown (${g.why})`, { to: 'debug' })
    return null
  }
  lastShownAt = f.at
  shown = { from: f.from, at: f.at }
  const text = switchGuardText(g, ev.view.cost?.showDollars ?? ev.billing !== 'subscription', renderContext(h))
  $.ui.toast(text.toast, { timeoutMs: SWITCH_TOAST_MS })
  noteToast(f.at)
  await update($, bandAtom, current => (current !== null && current.mode === 'confirm' ? current : { mode: 'guard' as const, text: text.toast, lever: null }))
  return g.ask ? text.reason : null
}

/**
 * Ends the guard's band: the switch completed (`classic.PostModelSwitch`),
 * the person sent a prompt, or the snapshot shows it was cancelled.
 *
 * @param $ the engine interface
 */
export async function clearGuard($: EngineInterface): Promise<void> {
  shown = null
  await update($, bandAtom, current => (current !== null && current.mode === 'guard' ? null : current))
}

/**
 * Clears the guard when a snapshot taken after the switch was shown still
 * reports the model it started from: Claude Code fires no event on cancel.
 *
 * @param $ the engine interface
 * @param snapshot the snapshot just read
 * @returns whether the guard was cleared
 */
export async function clearGuardIfUnchanged($: EngineInterface, snapshot: NativeSnapshot): Promise<boolean> {
  if (shown === null || snapshot.receivedAt <= shown.at || snapshot.model.tier === 'absent') return false
  if (baseModelId(snapshot.model.value) !== baseModelId(shown.from)) return false
  await clearGuard($)
  return true
}

/**
 * Weighs an effort change, fast toggle or plugin reload before it is
 * recorded, so the assessment is the one from before it (REQ-10.0.2). A
 * change the rules say rebuilds a warm cache gets a toast with the cost.
 *
 * @param $ the engine interface
 * @param kind the event kind the change implies
 */
export async function guardChange($: EngineInterface, kind: string): Promise<void> {
  const h = host()
  const ev = await currentEvaluation($)
  if (h === null || h.data === null || ev === null) return
  const now = await $.clock.now()
  const impact = eventImpact({ ts: now, kind }, h.data.rules, { ...h.env, ...(ev.model !== null ? { model: ev.model } : {}) })
  const g = changeGuard(kind, impact, ev.a.state)
  if (g.action === 'silent') return
  const showDollars = ev.view.cost?.showDollars ?? ev.billing !== 'subscription'
  const usd = showDollars && ev.cost?.usd ? ev.cost.usd.cold : null
  $.ui.toast(changeGuardText(g.key, usd, ev.cost?.prefixTokens ?? 0, renderContext(h)))
  noteToast(now)
}
