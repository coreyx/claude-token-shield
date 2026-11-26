import { atom, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import { gateDecision } from '../../core/gate/gate'
import type { HeldPrompt } from '../../core/gate/gate'
import { sha256Hex } from '../../core/gate/sha256'
import { gateText, recommendationLine } from '../../core/render/band'
import { glyphSet } from '../../core/render/format'
import type { TokenShieldBand } from '../../types'
import { host } from '../host/host'
import { currentEvaluation, noteToast } from '../session/model'

/** The band, set to gate mode while a prompt is held. */
const bandAtom = atom({ plugin: 'token-shield', key: 'band' } as const, null as TokenShieldBand)

/**
 * The prompt held last: its SHA-256 and when, in this module's memory only.
 * It is never written to $.state, $.store or disk, and a reload forgets it,
 * which at worst holds the same prompt once more (design D9).
 */
let held: HeldPrompt | null = null

/** Forgets the held prompt, for a new session. */
export function resetGate(): void {
  held = null
}

/**
 * Decides a prompt the person typed (REQ-12, design D9). Returns `null` to
 * let it through untouched, or the drop reason to hold it; Claude Code puts
 * a dropped prompt back in the box, so Enter sends it again unchanged. With
 * the gate set to warn it toasts the cost and lets the prompt through. The
 * text is only hashed: never kept, changed or added to.
 *
 * @param $ the engine interface
 * @param text the prompt as typed
 */
export async function gateSubmit($: EngineInterface, text: string): Promise<string | null> {
  const h = host()
  const ev = await currentEvaluation($)
  if (h === null || h.data === null || ev === null || ev.cost === null) return null
  const now = await $.clock.now()
  // Only COLD and INVALIDATED can hold, so only then is the text worth hashing.
  const canHold = ev.a.state === 'COLD' || ev.a.state === 'INVALIDATED'
  const d = gateDecision(ev.a, ev.cost, ev.billing, h.config, held, canHold ? sha256Hex(text) : '', now)
  held = d.held
  if (d.action === 'pass') {
    // A released or unheld prompt ends any hold the band still shows.
    await update($, bandAtom, current => (current !== null && current.mode === 'gate' ? null : current))
    return null
  }
  const o = { glyphs: glyphSet(h.config.glyphs), strings: h.data.strings, display: h.data.rules.display, tzOffsetMin: h.tzOffsetMin }
  const reason = gateText(d, ev.view, ev.rec.lever, o)
  if (d.action === 'warn') {
    $.ui.toast(reason)
    noteToast(now)
    return null
  }
  const lever = ev.rec.lever === 'none' ? null : ev.rec.lever
  await update($, bandAtom, current =>
    current !== null && current.mode === 'confirm' ? current : { mode: 'gate' as const, text: `${reason}${recommendationLine(ev.view, o)}`, lever },
  )
  return reason
}
