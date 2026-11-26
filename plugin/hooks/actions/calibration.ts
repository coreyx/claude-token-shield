import type { EngineInterface } from 'claude-code'

import { formatString } from '../../core/data/load'
import { calibrate } from '../../core/history/calibrate'
import type { AssessmentRecord, Calibration } from '../../core/history/calibrate'
import { notifyCritical } from '../../core/notify/notify'
import { glyphParams, glyphSet } from '../../core/render/format'
import { reportFailure } from '../host/failure'
import { host } from '../host/host'
import { historySessions, readSessionHistory } from '../persist/history'
import { publish, setLearned } from '../session/model'

/** The `$.store` key marking a drift episode already alerted, across sessions. */
const DRIFT_ALERTED = 'calibrationDriftAlerted'

/**
 * Every recorded assessment within the history window, across sessions.
 *
 * @param $ the engine interface
 * @param sinceMs the window's start, epoch ms
 */
export async function recordedAssessments($: EngineInterface, sinceMs: number): Promise<AssessmentRecord[]> {
  const h = host()
  if (h === null) return []
  const dir = h.companions.dataDir
  const all: AssessmentRecord[] = []
  for (const id of await historySessions($, dir)) {
    const s = await readSessionHistory($, dir, id)
    for (const a of s.assessments ?? []) if (a.ts >= sinceMs) all.push(a)
  }
  return all.sort((a, b) => a.ts - b.ts)
}

/**
 * Calibrates from the recorded history and hands the learned rates to the
 * assessor (design D19). Run in the background at session start, off the
 * render path. A drift episode raises one critical toast, remembered across
 * sessions until the rate is back inside its interval (AC 14.4).
 *
 * @param $ the engine interface
 */
export async function calibrateInBackground($: EngineInterface): Promise<Calibration | null> {
  try {
    const h = host()
    if (h === null || h.data === null) return null
    const now = await $.clock.now()
    const p = h.data.rules.priors
    const cal = calibrate(await recordedAssessments($, now - h.config.historyDays * 86_400_000), {
      epsWithin: p.epsWithin,
      epsAfter: p.epsAfter,
      minCalibrationN: p.minCalibrationN,
    })
    setLearned(cal.n > 0 ? cal.learned : undefined)
    const alerted = (await $.store.get(DRIFT_ALERTED)) === true
    if (cal.drift && !alerted) {
      const n = notifyCritical('calibration_drift', {}, h.config)
      if (n !== null) $.ui.toast(formatString(h.data.strings, n.key, glyphParams(glyphSet(h.config.glyphs))))
      await $.store.set(DRIFT_ALERTED, true)
    } else if (!cal.drift && alerted) {
      await $.store.delete(DRIFT_ALERTED)
    }
    await publish($)
    return cal
  } catch (err) {
    reportFailure($, 'calibration', err)
    return null
  }
}
