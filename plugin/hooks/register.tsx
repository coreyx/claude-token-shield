import type { EngineInterface, Register } from 'claude-code'

import { assess } from '../core/assess/assess'
import { initialState } from '../core/model/reduce'
import { reportFailure } from './host/failure'
import { host, startHost, stopHost } from './host/host'

/**
 * Token Shield's hooks module: the only entry point the engine loads. It only
 * wires engine events to the host, adapters, actions and UI (design.md
 * "Repository layout"); the decisions live in `../core/`.
 *
 * Every hook carries a `.catch` boundary: a failure is reported once to the
 * debug log and the event continues as if Token Shield weren't there, so a
 * prompt, command or render is never blocked by a bug here (REQ-21.0.3).
 */
export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await startHost($, options)
    return started
  }).catch(($, e, next) => {
    reportFailure($, 'session.start', next.error)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    stopHost()
    return next(e)
  }).catch(($, e, next) => {
    reportFailure($, 'session.end', next.error)
    return next(e)
  })

  // The submit gate (TASK-22) decides from the cached assessment; until then
  // the hook only keeps the assessment current, and passes every prompt.
  on('prompt.submit', async ($, e, next) => {
    if (!e.command && !e.isMeta) await refreshAssessment($)
    return next(e)
  }).catch(($, e, next) => {
    reportFailure($, 'prompt.submit', next.error)
    return next(e)
  })
}

/**
 * Recomputes the assessment the gate and the UI read. Throws when the shared
 * data couldn't be loaded, which the hook's boundary turns into a pass.
 *
 * @param $ the engine interface
 */
async function refreshAssessment($: EngineInterface): Promise<void> {
  const h = host()
  if (h === null || !h.enabled) return
  if (h.data === null) throw new Error('shared data unavailable')
  assess(initialState(), await $.clock.now(), {
    rules: h.data.rules,
    env: { provider: 'firstParty', toolSearch: true, experimentalBetasDisabled: false },
    ccVersion: h.ccVersion,
  })
}
