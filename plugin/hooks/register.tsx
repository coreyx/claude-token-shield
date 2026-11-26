import type { EngineInterface, Register } from 'claude-code'

import type { Fact } from '../core/model/types'
import { CORE_VERSION } from '../core/version'
import { commandEvent, compactionEvent, configEvent, resumeInfo, stepRequest, switchEvent } from './adapters/adapters'
import { reportFailure } from './host/failure'
import { host, startHost, stopHost } from './host/host'
import { flushHistory, historyDirty, recordEvent, recordRequest, resetHistory, writeHeartbeat } from './persist/history'
import { readChangedSnapshot, resetSnapshotReader } from './persist/snapshot'
import { applyFacts, currentEvaluation, modelState, publish, resetModel, resetPublishing } from './session/model'
import { drawBand } from './ui/band'

/**
 * Token Shield's hooks module: the only entry point the engine loads. It only
 * wires engine events to the host, adapters, actions and UI (design.md
 * "Repository layout"); the decisions live in `../core/`.
 *
 * Every hook carries a `.catch` boundary: a failure is reported once to the
 * debug log and the event continues as if Token Shield weren't there, so a
 * prompt, command or render is never blocked by a bug here (REQ-21.0.3).
 * Every observing hook returns `next(e)` as received (design D10).
 */

/** How often the bridge's snapshot is checked for changes (design D2). */
const SNAPSHOT_POLL_MS = 5_000
/** How often the heartbeat is written and dirty history flushed (D14, D16). */
const HEARTBEAT_MS = 30_000

/** The session's timers, cancelled when it ends. */
let timers: { cancel: () => void }[] = []

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    resetModel()
    resetPublishing()
    resetHistory()
    resetSnapshotReader()
    await startHost($, options)
    await pollSnapshot($)
    await publish($)
    timers.push($.clock.every(SNAPSHOT_POLL_MS, () => void tick($)))
    timers.push($.clock.every(HEARTBEAT_MS, () => void beat($)))
    await beat($)
    return started
  }).catch(($, e, next) => {
    reportFailure($, 'session.start', next.error)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    for (const t of timers) t.cancel()
    timers = []
    resetPublishing()
    const h = host()
    if (h !== null) await flushHistory($, h.companions.dataDir, h.sessionId)
    stopHost()
    return next(e)
  }).catch(($, e, next) => {
    reportFailure($, 'session.end', next.error)
    return next(e)
  })

  // Each model request: its usage, start and lane become a request record.
  on('turn.step', async function* ($, e, next) {
    const startedAt = await $.clock.now()
    const result = yield* next(e)
    try {
      const request = stepRequest(e, result.usage, startedAt, await $.clock.now())
      if (request !== null) {
        applyFacts({ kind: 'request', request })
        recordRequest(request)
      }
    } catch (err) {
      reportFailure($, 'turn.step', err)
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const h = host()
    await pollSnapshot($)
    if (h !== null) await flushHistory($, h.companions.dataDir, h.sessionId)
    await publish($)
    return next(e)
  }).catch(($, e, next) => {
    reportFailure($, 'turn.complete', next.error)
    return next(e)
  })

  // The submit gate (TASK-22) decides from the cached evaluation; until then
  // the hook only keeps it current, and passes every prompt.
  on('prompt.submit', async ($, e, next) => {
    if (!e.command && !e.isMeta) await currentEvaluation($)
    return next(e)
  }).catch(($, e, next) => {
    reportFailure($, 'prompt.submit', next.error)
    return next(e)
  })

  on('command.run', async ($, e, next) => {
    const event = commandEvent(e.command, await $.clock.now())
    if (event !== null) await observe($, { kind: 'event', event })
    return next(e)
  }).catch(($, e, next) => {
    reportFailure($, 'command.run', next.error)
    return next(e)
  })

  on('config.set', async ($, e, next) => {
    const event = configEvent(e.key, await $.clock.now())
    if (event !== null) await observe($, { kind: 'event', event })
    return next(e)
  }).catch(($, e, next) => {
    reportFailure($, 'config.set', next.error)
    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    const event = compactionEvent(e.trigger, e.agentId, 'skip' in result, await $.clock.now())
    if (event !== null) await observe($, { kind: 'event', event })
    return result
  }).catch(($, e, next) => {
    reportFailure($, 'session.compact', next.error)
    return next(e)
  })

  on('classic.PostModelSwitch', async ($, e, next) => {
    await observe($, { kind: 'event', event: switchEvent(e.from_model, e.to_model, await $.clock.now()) })
    return next(e)
  }).catch(($, e, next) => {
    reportFailure($, 'classic.PostModelSwitch', next.error)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => (await drawBand($, e)) ?? next(e)).catch(($, e, next) => {
    reportFailure($, 'band', next.error)
    return next(e)
  })

  on('classic.SessionStart', async ($, e, next) => {
    const resume = resumeInfo(e, await $.clock.now())
    if (resume !== null) applyFacts({ kind: 'resume', resume })
    return next(e)
  }).catch(($, e, next) => {
    reportFailure($, 'classic.SessionStart', next.error)
    return next(e)
  })
}

/**
 * Feeds an observed fact into the model, records events for history, and
 * redraws.
 *
 * @param $ the engine interface
 * @param fact what was observed
 */
async function observe($: EngineInterface, fact: Fact): Promise<void> {
  applyFacts(fact)
  if (fact.kind === 'event') recordEvent(fact.event)
  await publish($)
}

/**
 * Reads the bridge's snapshot when it changed and feeds it in.
 *
 * @param $ the engine interface
 * @returns whether a new snapshot arrived
 */
async function pollSnapshot($: EngineInterface): Promise<boolean> {
  const h = host()
  if (h === null) return false
  const snapshot = await readChangedSnapshot($, h.companions.dataDir, h.sessionId)
  if (snapshot === null) return false
  // A snapshot can produce events of its own (a TTL change); history records them too.
  const before = new Set(modelState().events)
  applyFacts({ kind: 'snapshot', snapshot })
  for (const event of modelState().events) if (!before.has(event)) recordEvent(event)
  return true
}

/** The 5-second tick: a changed snapshot redraws. */
async function tick($: EngineInterface): Promise<void> {
  try {
    if (await pollSnapshot($)) await publish($)
  } catch (err) {
    reportFailure($, 'snapshot poll', err)
  }
}

/** The 30-second beat: heartbeat for the bridge, and any history not yet written. */
async function beat($: EngineInterface): Promise<void> {
  try {
    const h = host()
    if (h === null) return
    await writeHeartbeat($, h.companions.dataDir, h.sessionId, `core-${CORE_VERSION}`)
    if (historyDirty()) await flushHistory($, h.companions.dataDir, h.sessionId)
  } catch (err) {
    reportFailure($, 'heartbeat', err)
  }
}
