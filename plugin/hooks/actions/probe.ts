import { atom, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import { TTL_SEC } from '../../core/assess/assess'
import { requestUsd } from '../../core/cost/cost'
import { formatString } from '../../core/data/load'
import { classifyProbe, PROBE_PROMPT, probeQuote, probeRecord } from '../../core/probe/probe'
import { formatClock, formatTokensLong, formatUsd, glyphParams, glyphSet } from '../../core/render/format'
import type { TokenShieldBand } from '../../types'
import { host } from '../host/host'
import { reportFailure } from '../host/failure'
import { recordLeverTaken, recordRequest } from '../persist/history'
import { applyFacts, currentEvaluation, publish } from '../session/model'

/** The band, set to confirm mode while a probe waits for Confirm. */
const bandAtom = atom({ plugin: 'token-shield', key: 'band' } as const, null as TokenShieldBand)

/** The string formatter with glyphs, or `null` before the host starts. */
function formatter() {
  const h = host()
  if (h === null || h.data === null) return null
  const g = glyphParams(glyphSet(h.config.glyphs))
  return (key: string, params: Record<string, string | number> = {}) => formatString(h.data!.strings, key, { ...g, ...params })
}

/**
 * `/cache-check --probe [--force]` (REQ-7.0.1, 7.0.4): declines with the
 * reason when a probe would tell nothing worth its price, otherwise shows
 * both prices and the side effect in the band's confirm mode. Nothing is
 * sent until Confirm (REQ-7.0.6).
 *
 * @param $ the engine interface
 * @param force whether `--force` was given
 * @returns the line /cache-check answers with
 */
export async function offerProbe($: EngineInterface, force: boolean): Promise<string> {
  const t = formatter()
  const ev = await currentEvaluation($, true)
  if (t === null || ev === null) return 'Token Shield: not started.'
  const q = probeQuote(ev.a, ev.cost, force)
  if (q.action === 'decline') return t(q.reasonKey)
  const unknown = t('check.unknown_value')
  const showDollars = ev.view.cost?.showDollars ?? ev.billing !== 'subscription'
  const price = (usd: number | null) => (usd !== null && showDollars ? formatUsd(usd) : unknown)
  const text = t('probe.confirm', { tokens: q.tokens !== null ? formatTokensLong(q.tokens) : unknown, warm: price(q.warmUsd), cold: price(q.coldUsd) })
  await update($, bandAtom, () => ({ mode: 'confirm' as const, text, lever: 'probe' }))
  return text
}

/**
 * Runs the confirmed probe (REQ-7.0.2, 7.0.3): a fork of the main
 * conversation with a one-line prompt and no effort of its own, so it
 * re-sends the exact cached prefix at the session's level. The measured
 * usage becomes a probe record (history keeps it for calibration) and the
 * result is reported: what was read, written and uncached, the outcome,
 * the cost and the new expiry. No fork, or a failed one, changes nothing.
 *
 * @param $ the engine interface
 */
export async function runProbe($: EngineInterface): Promise<void> {
  await update($, bandAtom, () => null)
  const h = host()
  const t = formatter()
  if (h === null || h.data === null || t === null) return
  try {
    const before = await currentEvaluation($, true)
    const startedAt = await $.clock.now()
    recordLeverTaken({ ts: startedAt, lever: 'probe' })
    const r = await $.model.fork({ prompt: PROBE_PROMPT })
    const endedAt = await $.clock.now()
    if (!r.isAnswered) {
      if (r.reason === 'nothing-to-fork') $.ui.toast(t('probe.nothing'))
      else $.ui.toast(t('probe.failed', { reason: r.reason === 'api-error' && 'status' in r ? `API error ${String(r.status)}` : r.reason.replace(/-/g, ' ') }))
      return
    }
    const model = before?.model ?? (await $.session.model())
    const ttl = before !== null && before.a.ttl.tier !== 'absent' ? before.a.ttl.value : undefined
    const record = probeRecord(r.usage, startedAt, endedAt - startedAt, model, ttl)
    applyFacts({ kind: 'request', request: record })
    recordRequest(record)
    await publish($)

    const u = r.usage
    const prefix = before !== null && before.a.prefixTokens.tier !== 'absent' ? before.a.prefixTokens.value : u.cache_read_input_tokens + u.cache_creation_input_tokens + u.input_tokens
    const usd = requestUsd(record, h.data.prices)
    $.ui.toast(
      t('probe.result', {
        outcome: t(`probe.outcome.${classifyProbe(u.cache_read_input_tokens, prefix)}`),
        read: formatTokensLong(u.cache_read_input_tokens),
        write: formatTokensLong(u.cache_creation_input_tokens),
        uncached: formatTokensLong(u.input_tokens),
        cost: usd !== null ? formatUsd(usd) : t('check.unknown_value'),
        time: ttl !== undefined ? formatClock(startedAt + TTL_SEC[ttl] * 1000, h.tzOffsetMin) : t('check.unknown_value'),
      }),
    )
  } catch (err) {
    reportFailure($, 'probe', err)
    $.ui.toast(t('probe.failed', { reason: err instanceof Error ? err.message : 'it was refused' }))
  }
}
