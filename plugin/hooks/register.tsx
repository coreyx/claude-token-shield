import type { EngineInterface, Register } from 'claude-code'

import { calibrationPair } from '../core/history/calibrate'
import type { Fact, Ttl } from '../core/model/types'
import type { LeverId } from '../core/recommend/levers'
import { CORE_VERSION } from '../core/version'
import { commandEvent, compactionEvent, configEvent, resumeInfo, stepRequest, switchEvent } from './adapters/adapters'
import { formatString } from '../core/data/load'
import { calibrateInBackground } from './actions/calibration'
import { pruneInBackground } from './actions/store'
import { gateSubmit, resetGate } from './actions/gate'
import { keepAliveOnPrompt, resetKeepAlive } from './actions/keepalive'
import { clearResume, showResume } from './actions/resume'
import { clearGuard, clearGuardIfUnchanged, guardChange, guardSwitch, resetGuard } from './actions/guard'
import { reportFailure } from './host/failure'
import { host, startHost, stopHost } from './host/host'
import { continueHistory, flushHistory, recordAssessment, recordLeverTaken, historyDirty, recordEvent, recordRequest, resetHistory, writeHeartbeat } from './persist/history'
import { readChangedSnapshot, resetSnapshotReader } from './persist/snapshot'
import { applyFacts, currentEvaluation, modelState, publish, resetModel, resetPublishing, setTurnRunning } from './session/model'
import { drawBand } from './ui/band'
import { answerCacheCheck, drawLeverBar } from './ui/check'
import { drawPane, openView, refreshRunway, RUNWAY_REFRESH_MS } from './ui/pane'

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
/** Slash commands that are levers, recorded when taken (D18); effort and fast count as the model lever. */
const TAKEN_COMMANDS = new Set(['compact', 'clear', 'rewind', 'recap', 'btw'])
/** The session history's last recorded TTL, read once per session. */
let historyTtl: Promise<Ttl | undefined> | null = null

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    resetModel()
    resetPublishing()
    resetGate()
    resetGuard()
    resetKeepAlive()
    resetHistory()
    historyTtl = null
    resetSnapshotReader()
    const h = await startHost($, options)
    historyTtl = continueHistory($, h.companions.dataDir, h.sessionId)
    await historyTtl
    // Calibration reads every session's history: in the background, off the render path (D19).
    void calibrateInBackground($)
    // Retention, through tshield since the mod's file access can't delete (D16).
    void pruneInBackground($)
    // Registration fails on its own: the segment, band and history still start.
    if (h.data !== null) {
      try {
        await $.command.register({ name: 'cache-check', description: formatString(h.data.strings, 'command.description') })
        await $.command.register({ name: 'cache-view', description: formatString(h.data.strings, 'view.description') })
      } catch (err) {
        reportFailure($, 'command.register', err)
      }
    }
    await pollSnapshot($)
    await publish($)
    timers.push($.clock.every(SNAPSHOT_POLL_MS, () => void tick($)))
    timers.push($.clock.every(HEARTBEAT_MS, () => void beat($)))
    timers.push($.clock.every(RUNWAY_REFRESH_MS, () => void refreshRunway($).catch(err => reportFailure($, 'runway refresh', err))))
    await beat($)
    return started
  }).catch(($, e, next) => {
    reportFailure($, 'session.start', next.error)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    for (const t of timers) t.cancel()
    timers = []
    resetKeepAlive()
    resetPublishing()
    await saveHistory($)
    stopHost()
    return next(e)
  }).catch(($, e, next) => {
    reportFailure($, 'session.end', next.error)
    return next(e)
  })

  // Each model request: its usage, start and lane become a request record.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) setTurnRunning(true)
    const startedAt = await $.clock.now()
    // The assessment this request will test, taken before it goes out (REQ-14.0.4).
    const before = e.agentId === undefined ? await currentEvaluation($).catch(() => null) : null
    const result = yield* next(e)
    try {
      const request = stepRequest(e, result.usage, startedAt, await $.clock.now())
      if (request !== null) {
        applyFacts({ kind: 'request', request })
        recordRequest(request)
        const pair = before !== null ? calibrationPair(before.a, request, host()?.ccVersion ?? null) : null
        if (pair !== null) recordAssessment(pair)
      }
    } catch (err) {
      reportFailure($, 'turn.step', err)
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) setTurnRunning(false)
    // Each step on its own: a failing one is reported, and the rest still run (REQ-21.0.3).
    await safePoll($)
    await saveHistory($)
    await publish($)
    return next(e)
  }).catch(($, e, next) => {
    reportFailure($, 'turn.complete', next.error)
    return next(e)
  })

  // The submit gate (D9): only a prompt the person typed is weighed; a hold
  // answers the drop reason, everything else goes on exactly as it came.
  on('prompt.submit', async ($, e, next) => {
    if (e.command || e.isMeta || e.origin.kind !== 'composer') return next(e)
    await clearGuard($)
    await clearResume($)
    // The person is back: a running keep-alive stops before its next refresh.
    await keepAliveOnPrompt($)
    const drop = await gateSubmit($, e.text)
    if (drop !== null) return { drop }
    // A prompt that goes through is the lever 'continue' (D18).
    recordLeverTaken({ ts: await $.clock.now(), lever: 'continue' })
    return next(e)
  }).catch(($, e, next) => {
    reportFailure($, 'prompt.submit', next.error)
    return next(e)
  })

  on('command.run', async ($, e, next) => {
    const at = await $.clock.now()
    if (TAKEN_COMMANDS.has(e.command)) recordLeverTaken({ ts: at, lever: e.command as LeverId })
    const event = commandEvent(e.command, at)
    if (event !== null) {
      // Weighed before it's recorded, so the guard sees the cache as it was (D10).
      await guardChange($, event.kind)
      await observe($, { kind: 'event', event })
    }
    return next(e)
  }).catch(($, e, next) => {
    reportFailure($, 'command.run', next.error)
    return next(e)
  })

  on('config.set', async ($, e, next) => {
    const event = configEvent(e.key, await $.clock.now())
    if (event !== null) {
      recordLeverTaken({ ts: event.ts, lever: 'model' })
      await guardChange($, event.kind)
      await observe($, { kind: 'event', event })
    }
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

  // The guard (D10): Claude Code's own confirmation runs as it is; Token Shield
  // shows its estimate beside it, and asks for confirmation only when the
  // person turned switchConfirm on. A deny from beneath always stands.
  on('classic.PreModelSwitch', async ($, e, next) => {
    const at = await $.clock.now()
    const ask = await guardSwitch($, {
      from: e.from_model,
      to: e.to_model,
      requested: e.requested_model,
      warm: e.prompt_cache_warm,
      contextTokens: e.context_tokens,
      estimatedUsd: e.estimated_cache_write_usd,
      at,
    })
    const result = await next(e)
    if (ask === null || result.permissionDecision === 'deny') return result
    return { ...result, permissionDecision: 'ask' as const, permissionDecisionReason: ask } // tshield-allow: REQ-10.0.6
  }).catch(($, e, next) => {
    reportFailure($, 'classic.PreModelSwitch', next.error)
    return next(e)
  })

  on('classic.PostModelSwitch', async ($, e, next) => {
    await clearGuard($)
    recordLeverTaken({ ts: await $.clock.now(), lever: 'model' })
    await observe($, { kind: 'event', event: switchEvent(e.from_model, e.to_model, await $.clock.now()) })
    return next(e)
  }).catch(($, e, next) => {
    reportFailure($, 'classic.PostModelSwitch', next.error)
    return next(e)
  })

  // /cache-check answers itself: no next(e), no model call, nothing sent (D7).
  // It also catches its own failures: an error left to propagate would reach
  // the outer command.run hook, which passes the command on to Claude Code.
  on('command.run', { command: 'cache-check' }, async ($, e) => {
    try {
      return await answerCacheCheck($, e.args, e.presentation.columns)
    } catch (err) {
      reportFailure($, 'cache-check', err)
      return { text: 'Token Shield: the cache check failed; details are in the debug log.', isTextDisplayOnly: true as const }
    }
  }).catch(($, _e, next) => {
    reportFailure($, 'cache-check', next.error)
    return { text: 'Token Shield: the cache check failed; details are in the debug log.', isTextDisplayOnly: true as const }
  })

  // /cache-view opens the pane on a view; display-only, like /cache-check (D7).
  on('command.run', { command: 'cache-view' }, async ($, e) => {
    try {
      return await openView($, e.args)
    } catch (err) {
      reportFailure($, 'cache-view', err)
      return { text: 'Token Shield: the view failed to open; details are in the debug log.', isTextDisplayOnly: true as const }
    }
  }).catch(($, _e, next) => {
    reportFailure($, 'cache-view', next.error)
    return { text: 'Token Shield: the view failed to open; details are in the debug log.', isTextDisplayOnly: true as const }
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => (await drawPane($, e)) ?? next(e)).catch(($, e, next) => {
    reportFailure($, 'pane', next.error)
    return next(e)
  })

  on('ui.render', { component: 'Placed' }, async ($, e, next) => (await drawLeverBar($, e)) ?? next(e)).catch(($, e, next) => {
    reportFailure($, 'lever bar', next.error)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => (await drawBand($, e)) ?? next(e)).catch(($, e, next) => {
    reportFailure($, 'band', next.error)
    return next(e)
  })

  on('classic.SessionStart', async ($, e, next) => {
    const h = host()
    // The last recorded TTL: what the session's own history says, read once.
    if (historyTtl === null && h !== null) historyTtl = continueHistory($, h.companions.dataDir, h.sessionId)
    const resume = resumeInfo(e, await $.clock.now(), (await historyTtl) ?? undefined)
    if (resume !== null) {
      applyFacts({ kind: 'resume', resume })
      await publish($)
      await showResume($, resume)
    }
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
  await clearGuardIfUnchanged($, snapshot)
  for (const event of modelState().events) if (!before.has(event)) recordEvent(event)
  return true
}

/**
 * Flushes buffered history, reporting a failure once as the history writer
 * rather than failing whichever hook flushed: a broken store must never stop
 * the status, prompts or commands (REQ-21.0.3).
 */
async function saveHistory($: EngineInterface): Promise<void> {
  const h = host()
  if (h === null) return
  try {
    await flushHistory($, h.companions.dataDir, h.sessionId)
  } catch (err) {
    reportFailure($, 'history writer', err)
  }
}

/** Polls the snapshot, reporting a failure once as the snapshot reader. */
async function safePoll($: EngineInterface): Promise<boolean> {
  try {
    return await pollSnapshot($)
  } catch (err) {
    reportFailure($, 'snapshot reader', err)
    return false
  }
}

/** The 5-second tick: a changed snapshot redraws. */
async function tick($: EngineInterface): Promise<void> {
  try {
    if (await safePoll($)) await publish($)
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
    if (historyDirty()) await saveHistory($)
  } catch (err) {
    reportFailure($, 'heartbeat', err)
  }
}
