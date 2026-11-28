import { atom, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import { formatString } from '../../core/data/load'
import { glyphParams, glyphSet } from '../../core/render/format'
import type { TokenShieldBand } from '../../types'
import { reportFailure } from '../host/failure'
import { describeProblem } from '../host/companions'
import { host } from '../host/host'

/** The band, set to confirm mode for forget and the backfill offer. */
const bandAtom = atom({ plugin: 'token-shield', key: 'band' } as const, null as TokenShieldBand)

/** The `$.store` key marking the backfill as offered: it is offered once (design D17). */
const BACKFILL_OFFERED = 'backfillOffered'

/** The string formatter with glyphs, or `null` before the host starts. */
function formatter() {
  const h = host()
  if (h === null || h.data === null) return null
  const g = glyphParams(glyphSet(h.config.glyphs))
  return (key: string, params: Record<string, string> = {}) => formatString(h.data!.strings, key, { ...g, ...params })
}

/** The last line a companion printed, as the reason a step didn't complete. */
function lastLine(r: { stdout: string; stderr: string; exitCode: number }): string {
  return (r.stderr || r.stdout).trim().split('\n').pop() || `exit ${r.exitCode}`
}

/**
 * Prunes history older than `historyDays` through tshield, at session start
 * and in the background (design D16): the mod's file access can't delete.
 *
 * @param $ the engine interface
 */
export async function pruneInBackground($: EngineInterface): Promise<void> {
  const bin = host()?.companions.bin
  if (!bin) return
  try {
    const r = await $.process.run([bin, 'prune', '--json'], { timeoutMs: 30_000 })
    if (r.exitCode !== 0) reportFailure($, 'prune', new Error(lastLine(r)))
  } catch (err) {
    reportFailure($, 'prune', err)
  }
}

/**
 * `/cache-check forget` (REQ-14.0.9): asks in the band's confirm mode before
 * deleting all stored history, snapshots and backfill.
 *
 * @param $ the engine interface
 * @returns the line /cache-check answers with
 */
export async function offerForget($: EngineInterface): Promise<string> {
  const t = formatter()
  if (t === null) return 'Token Shield: not started.'
  const h = host()!
  if (!h.companions.bin) return t('forget.no_binary', { reason: describeProblem(h.data!.strings, h.companions.problem) })
  const text = t('forget.confirm')
  await update($, bandAtom, () => ({ mode: 'confirm' as const, text, lever: 'forget' }))
  return text
}

/**
 * Deletes everything stored, through `tshield forget --yes`, once confirmed.
 *
 * @param $ the engine interface
 */
export async function runForget($: EngineInterface): Promise<void> {
  await update($, bandAtom, () => null)
  const t = formatter()
  const bin = host()?.companions.bin
  if (t === null || !bin) return
  try {
    const r = await $.process.run([bin, 'forget', '--yes'], { timeoutMs: 60_000 })
    $.ui.toast(r.exitCode === 0 ? t('forget.done') : t('forget.failed', { reason: lastLine(r) }))
  } catch (err) {
    $.ui.toast(t('forget.failed', { reason: err instanceof Error ? err.message : 'tshield did not run' }))
  }
}

/**
 * Offers the backfill once, after setup (design D17): numbers only, from
 * Claude Code's transcripts, for the pre-install baseline. It runs only on
 * the person's Confirm.
 *
 * @param $ the engine interface
 */
export async function offerBackfillOnce($: EngineInterface): Promise<void> {
  const t = formatter()
  if (t === null || !host()?.companions.bin) return
  if ((await $.store.get(BACKFILL_OFFERED)) === true) return
  await $.store.set(BACKFILL_OFFERED, true)
  await update($, bandAtom, () => ({ mode: 'confirm' as const, text: t('backfill.offer'), lever: 'backfill' }))
}

/**
 * Runs the confirmed backfill through tshield and reports its coverage.
 *
 * @param $ the engine interface
 */
export async function runBackfill($: EngineInterface): Promise<void> {
  await update($, bandAtom, () => null)
  const t = formatter()
  const bin = host()?.companions.bin
  if (t === null || !bin) return
  try {
    const r = await $.process.run([bin, 'backfill'], { timeoutMs: 300_000 })
    $.ui.toast(r.exitCode === 0 ? r.stdout.trim() : t('backfill.failed', { reason: lastLine(r) }))
  } catch (err) {
    $.ui.toast(t('backfill.failed', { reason: err instanceof Error ? err.message : 'tshield did not run' }))
  }
}
