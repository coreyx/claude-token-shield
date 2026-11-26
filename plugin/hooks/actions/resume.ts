import { atom, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import { formatString } from '../../core/data/load'
import type { ResumeInfo } from '../../core/model/types'
import { formatClock, formatDuration, formatTokensLong, formatUsd, glyphParams, glyphSet } from '../../core/render/format'
import type { TokenShieldBand } from '../../types'
import { host } from '../host/host'
import { currentEvaluation, noteToast } from '../session/model'

/** The band, set to resume mode before the first prompt of a resumed session. */
const bandAtom = atom({ plugin: 'token-shield', key: 'band' } as const, null as TokenShieldBand)

/**
 * Shows resume guidance to the person only (REQ-11): for a resumed or forked
 * session whose cache Claude Code judges likely expired, the band in resume
 * mode with Claude Code's own estimate and the four options, before the first
 * prompt; for one still within its TTL, an info toast with the time it stays
 * warm until. Nothing is added to the session (REQ-11.0.3).
 *
 * @param $ the engine interface
 * @param r the resume facts, with the last recorded TTL
 */
export async function showResume($: EngineInterface, r: ResumeInfo): Promise<void> {
  const h = host()
  const ev = await currentEvaluation($, true)
  if (h === null || h.data === null || ev === null) return
  const g = glyphParams(glyphSet(h.config.glyphs))
  const t = (key: string, params: Record<string, string | number> = {}) => formatString(h.data!.strings, key, { ...g, ...params })

  if (r.likelyExpired === true) {
    const showDollars = ev.billing !== 'subscription' && r.estimatedCacheWriteUsd !== undefined
    const tokens = r.contextTokens ?? (ev.a.prefixTokens.tier !== 'absent' ? ev.a.prefixTokens.value : null)
    let text = t('resume.cold', {
      tokens: tokens !== null ? formatTokensLong(tokens) : t('check.unknown_value'),
      cost: showDollars ? formatUsd(r.estimatedCacheWriteUsd!) : '',
      idle: r.secondsSinceLastResponse !== undefined ? formatDuration(r.secondsSinceLastResponse) : t('check.unknown_value'),
      ...(showDollars ? {} : { approx: '' }),
    })
    // Without dollars the "≈ $x" pair goes, and the spacing it leaves.
    if (!showDollars) text = text.replace(/ {2,}/g, ' ').replace(/ +\(/g, ' (')
    await update($, bandAtom, current =>
      current !== null && current.mode === 'confirm' ? current : { mode: 'resume' as const, text: `${text} ${t('resume.options')}`, lever: null },
    )
    return
  }

  if (ev.a.state === 'HOT' && ev.a.expiresAt.tier !== 'absent' && !h.config.mutedLevels.includes('info')) {
    $.ui.toast(t('resume.warm', { time: formatClock(ev.a.expiresAt.value, h.tzOffsetMin) }))
    noteToast(ev.a.at)
  }
}

/**
 * Ends the resume band: the first prompt was sent.
 *
 * @param $ the engine interface
 */
export async function clearResume($: EngineInterface): Promise<void> {
  await update($, bandAtom, current => (current !== null && current.mode === 'resume' ? null : current))
}
