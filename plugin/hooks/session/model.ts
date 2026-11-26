import { atom, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { Assessment } from '../../core/assess/types'
import { initialState, reduce } from '../../core/model/reduce'
import type { Fact, SessionState } from '../../core/model/types'
import { EMPTY_LOG, logNotification, nextBoundary, notify } from '../../core/notify/notify'
import type { NotifyLog } from '../../core/notify/notify'
import type { Evaluation } from '../../core/pipeline'
import { evaluate } from '../../core/pipeline'
import { bandText, notificationText } from '../../core/render/band'
import { glyphSet } from '../../core/render/format'
import { renderSegment } from '../../core/render/segment'
import { reportFailure } from '../host/failure'
import { host } from '../host/host'
import type { TokenShieldBand } from '../../types'

/**
 * The band's value (the same $.state slot ui/band.tsx reads). Declared here as
 * well because the validator reads each atom where it is used.
 */
const bandAtom = atom({ plugin: 'token-shield', key: 'band' } as const, null as TokenShieldBand)

/**
 * The mod's session model (design D1): the core's reducer state, fed by the
 * adapters, and the latest evaluation, cached so the gate and renders read it
 * without recomputing (REQ-21.0.2). It recomputes when a fact arrives, a timer
 * fires, or a read comes more than a second after the last computation.
 */

let state: SessionState = initialState()
let cached: { readonly ev: Evaluation; readonly at: number } | null = null

/** Starts the model over for a new session. */
export function resetModel(): void {
  state = initialState()
  cached = null
}

/** The current reducer state. */
export function modelState(): SessionState {
  return state
}

/**
 * Feeds facts into the model; the next read recomputes.
 *
 * @param facts what an adapter observed
 */
export function applyFacts(...facts: readonly Fact[]): void {
  for (const f of facts) state = reduce(state, f)
  cached = null
}

/** Whether a main turn is running: set by its first step, cleared when it completes. */
let turnRunning = false

/** Marks a main turn as running or done (design D7 answers a mid-turn /cache-check differently). */
export function setTurnRunning(running: boolean): void {
  turnRunning = running
}

/** Whether a main turn is running now. */
export function isTurnRunning(): boolean {
  return turnRunning
}

/**
 * A fresh evaluation in a given check mode (verbose adds the timeline, diff
 * the changes), for /cache-check; it doesn't replace the cached one.
 *
 * @param $ the engine interface
 * @param mode the check view's mode
 */
export async function evaluateFor($: EngineInterface, mode: 'default' | 'verbose' | 'diff'): Promise<Evaluation | null> {
  const h = host()
  if (h === null || !h.enabled) return null
  if (h.data === null) throw new Error('shared data unavailable')
  return evaluate(state, await $.clock.now(), {
    rules: h.data.rules,
    prices: h.data.prices,
    env: h.env,
    ccVersion: h.ccVersion,
    warnWindowsSec: { '1h': h.config.warnWindow1hSec, '5m': h.config.warnWindow5mSec },
    defaultModel: await $.session.model(),
    mode,
  })
}

/** How long a cached evaluation serves reads. */
const FRESH_MS = 1000

/**
 * The current evaluation, recomputed when stale; `null` while cache features
 * are off or the data couldn't be loaded.
 *
 * @param $ the engine interface
 * @param force recompute even if fresh (a timer or a new fact)
 */
export async function currentEvaluation($: EngineInterface, force = false): Promise<Evaluation | null> {
  const h = host()
  if (h === null || !h.enabled) return null
  if (h.data === null) throw new Error('shared data unavailable')
  const now = await $.clock.now()
  if (!force && cached !== null && now - cached.at < FRESH_MS) return cached.ev
  const ev = evaluate(state, now, {
    rules: h.data.rules,
    prices: h.data.prices,
    env: h.env,
    ccVersion: h.ccVersion,
    warnWindowsSec: { '1h': h.config.warnWindow1hSec, '5m': h.config.warnWindow5mSec },
    defaultModel: await $.session.model(),
    mode: 'default',
  })
  cached = { ev, at: now }
  return ev
}

/** The assessment the last toast decision saw, the toast log and the boundary timer. */
let previous: Assessment | null = null
let toastLog: NotifyLog = EMPTY_LOG
let boundary: { cancel: () => void } | null = null

/** Starts the UI state over for a new session. */
export function resetPublishing(): void {
  previous = null
  toastLog = EMPTY_LOG
  boundary?.cancel()
  boundary = null
}

/**
 * Recomputes and redraws: the status segment (REQ-8), the band (REQ-9.0.3),
 * at most one toast for the transition (D13), and one timer at the next
 * boundary so EXPIRING and COLD show on time in an idle session (REQ-9.0.5).
 * Called after every fact and tick.
 *
 * @param $ the engine interface
 */
export async function publish($: EngineInterface): Promise<Evaluation | null> {
  const ev = await currentEvaluation($, true)
  const h = host()
  if (ev === null || h === null || h.data === null) return ev
  const glyphs = glyphSet(h.config.glyphs)
  const text = { glyphs, strings: h.data.strings, display: h.data.rules.display, tzOffsetMin: h.tzOffsetMin }
  $.ui.status(renderSegment(ev.a, ev.cost, { ...text, billing: ev.billing }))

  const band = bandText(ev.view, text)
  // A confirmation the person hasn't answered stays; only the state band follows the cache.
  await update($, bandAtom, current =>
    current !== null && current.mode === 'confirm' ? current : band === null ? null : { mode: 'state' as const, text: band, lever: ev.rec.lever === 'none' ? null : ev.rec.lever },
  )

  const now = ev.a.at
  const n = notify(previous, ev.a, toastLog, h.config, now)
  if (n !== null) {
    $.ui.toast(notificationText(n, text))
    toastLog = logNotification(toastLog, n, now)
  }
  previous = ev.a

  boundary?.cancel()
  boundary = null
  const at = nextBoundary(ev.a, now)
  // A little past the boundary, so the recomputation lands on the new side of it.
  if (at !== null) boundary = $.clock.after(at - now + 50, () => void republish($))
  return ev
}

/** A timer's redraw; a failure is reported, never thrown into the engine. */
async function republish($: EngineInterface): Promise<void> {
  try {
    await publish($)
  } catch (err) {
    reportFailure($, 'boundary timer', err)
  }
}
