import type { EngineInterface } from 'claude-code'

import type { Evaluation } from '../../core/pipeline'
import { evaluate } from '../../core/pipeline'
import { initialState, reduce } from '../../core/model/reduce'
import type { Fact, SessionState } from '../../core/model/types'
import { glyphSet } from '../../core/render/format'
import { renderSegment } from '../../core/render/segment'
import { host } from '../host/host'

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

/**
 * Recomputes and shows the status segment (REQ-8). Called after every fact
 * and timer tick; the segment is the one surface that is always on.
 *
 * @param $ the engine interface
 */
export async function publish($: EngineInterface): Promise<Evaluation | null> {
  const ev = await currentEvaluation($, true)
  const h = host()
  if (ev === null || h === null || h.data === null) return ev
  const segment = renderSegment(ev.a, ev.cost, {
    glyphs: glyphSet(h.config.glyphs),
    strings: h.data.strings,
    display: h.data.rules.display,
    tzOffsetMin: h.tzOffsetMin,
    billing: ev.billing,
  })
  $.ui.status(segment)
  return ev
}
