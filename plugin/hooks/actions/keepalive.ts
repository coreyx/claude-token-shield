import { atom, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import { requestUsd } from '../../core/cost/cost'
import { formatString } from '../../core/data/load'
import { nextRefreshAt, parseKeepAlive, plan, tickDecision } from '../../core/keepalive/keepalive'
import type { KeepAliveRequest, StopReason } from '../../core/keepalive/keepalive'
import type { Ttl } from '../../core/model/types'
import { classifyProbe, PROBE_PROMPT, probeRecord } from '../../core/probe/probe'
import { formatClock, formatUsd, glyphParams, glyphSet } from '../../core/render/format'
import type { TokenShieldBand } from '../../types'
import { host } from '../host/host'
import { reportFailure } from '../host/failure'
import { recordLeverTaken, recordRequest } from '../persist/history'
import { applyFacts, currentEvaluation, publish } from '../session/model'

/** The band: confirm mode before it starts, keep-alive mode with the spend while it runs. */
const bandAtom = atom({ plugin: 'token-shield', key: 'band' } as const, null as TokenShieldBand)

/** A keep-alive confirmed and running, in module memory: a reload stops it, never restarts it. */
interface Running extends KeepAliveRequest {
  readonly ttl: Ttl
  spentUsd: number
  promptSince: boolean
  nextAt: number
  timer: { cancel: () => void } | null
}

/** The keep-alive the band offers, waiting for Confirm. */
let offered: (KeepAliveRequest & { readonly ttl: Ttl; readonly firstAt: number }) | null = null
let running: Running | null = null

/** The string formatter with glyphs, and the session's time zone; `null` before the host starts. */
function context() {
  const h = host()
  if (h === null || h.data === null) return null
  const g = glyphParams(glyphSet(h.config.glyphs))
  const t = (key: string, params: Record<string, string | number> = {}) => formatString(h.data!.strings, key, { ...g, ...params })
  return { h, t, clock: (ms: number) => formatClock(ms, h.tzOffsetMin) }
}

/**
 * `/cache-check keepalive …` or the band's Keep warm button (REQ-15.0.2,
 * 15.0.4): works out the refreshes that fit before the end and within the
 * budget, and shows their estimated total in the band's confirm mode.
 * Nothing runs until Confirm.
 *
 * @param $ the engine interface
 * @param words the arguments after `keepalive`
 * @returns the line /cache-check answers with
 */
export async function offerKeepAlive($: EngineInterface, words: readonly string[]): Promise<string> {
  const c = context()
  const ev = await currentEvaluation($, true)
  if (c === null || ev === null) return 'Token Shield: not started.'
  const { h, t, clock } = c
  if (words[0] === 'stop') return running === null ? t('keepalive.not_running') : (await stopKeepAlive($, 'user'), '')
  const req = parseKeepAlive(words, ev.a.at, h.tzOffsetMin, h.config)
  if (req === null) return t('keepalive.usage')
  if (ev.a.state === 'COLD' || ev.a.state === 'INVALIDATED') return t('keepalive.refused_lost')
  const warm = ev.cost?.usd?.warm ?? null
  if (warm === null || ev.a.ttl.tier === 'absent' || ev.a.expiresAt.tier === 'absent') return t('keepalive.refused_unpriced')
  const p = plan(ev.a.expiresAt.value, ev.a.ttl.value, req, warm, ev.a.at)
  const until = clock(req.until)
  const budget = formatUsd(req.budgetUsd)
  if (p.refreshes === 0) return t('keepalive.refused_none', { until, budget })
  offered = { ...req, ttl: ev.a.ttl.value, firstAt: p.firstAt }
  const text = t('keepalive.confirm', { until, budget, n: p.refreshes, each: formatUsd(warm), total: formatUsd(p.totalUsd) })
  await update($, bandAtom, () => ({ mode: 'confirm' as const, text, lever: 'keepalive' }))
  return text
}

/** Drops an offer the person cancelled. */
export function cancelKeepAliveOffer(): boolean {
  const had = offered !== null
  offered = null
  return had
}

/**
 * Starts the confirmed keep-alive: one timer at the first refresh, the band
 * showing the spend so far (REQ-15.0.1, 15.0.2).
 *
 * @param $ the engine interface
 */
export async function startKeepAlive($: EngineInterface): Promise<void> {
  const o = offered
  offered = null
  await update($, bandAtom, () => null)
  if (o === null || context() === null) return
  if (running !== null) await stopKeepAlive($, 'user')
  running = { until: o.until, budgetUsd: o.budgetUsd, ttl: o.ttl, spentUsd: 0, promptSince: false, nextAt: o.firstAt, timer: null }
  recordLeverTaken({ ts: await $.clock.now(), lever: 'keepalive' })
  await schedule($)
}

/** Arms the timer for the next refresh and redraws the band. */
async function schedule($: EngineInterface): Promise<void> {
  const r = running
  const c = context()
  if (r === null || c === null) return
  const now = await $.clock.now()
  // The end comes first when it's before the next refresh.
  const at = Math.min(r.nextAt, r.until)
  r.timer = $.clock.after(Math.max(0, at - now), () => void tick($))
  const text = c.t('keepalive.running', { until: c.clock(r.until), spent: formatUsd(r.spentUsd), budget: formatUsd(r.budgetUsd), next: c.clock(r.nextAt) })
  await update($, bandAtom, current => (current !== null && current.mode === 'confirm' ? current : { mode: 'keepalive' as const, text, lever: null, actions: ['stop'] }))
}

/**
 * One scheduled refresh (D12): stop if the person is back, the end has come
 * or the budget could be passed; otherwise fork as the probe does, add the
 * measured cost, record it on the keepalive lane, and schedule the next one
 * from this refresh. A miss stops it: the cache was already lost, and going
 * on would re-pay a rebuild.
 */
async function tick($: EngineInterface): Promise<void> {
  const r = running
  const c = context()
  if (r === null || c === null) return
  try {
    const ev = await currentEvaluation($, true)
    const now = await $.clock.now()
    const d = tickDecision(r, now, ev?.cost?.usd?.warm ?? null)
    if (d.action === 'stop') return await stopKeepAlive($, d.reason)
    const result = await $.model.fork({ prompt: PROBE_PROMPT })
    const ended = await $.clock.now()
    if (!result.isAnswered) {
      const reason = result.reason === 'api-error' && 'status' in result ? `API error ${String(result.status)}` : result.reason.replace(/-/g, ' ')
      return await stopKeepAlive($, 'failed', reason)
    }
    const model = ev?.model ?? (await $.session.model())
    const record = probeRecord(result.usage, now, ended - now, model, r.ttl, 'keepalive')
    applyFacts({ kind: 'request', request: record })
    recordRequest(record)
    r.spentUsd += requestUsd(record, c.h.data!.prices) ?? 0
    const prefix = ev !== null && ev.a.prefixTokens.tier !== 'absent' ? ev.a.prefixTokens.value : result.usage.cache_read_input_tokens
    if (classifyProbe(result.usage.cache_read_input_tokens, prefix) === 'MISS') return await stopKeepAlive($, 'miss')
    r.nextAt = nextRefreshAt(now, r.ttl)
    await publish($)
    await schedule($)
  } catch (err) {
    reportFailure($, 'keep-alive', err)
    await stopKeepAlive($, 'failed', err instanceof Error ? err.message : 'refused')
  }
}

/**
 * Stops the keep-alive and says why and what it spent.
 *
 * @param $ the engine interface
 * @param reason why it stopped
 * @param detail what went wrong, for a failed refresh
 */
export async function stopKeepAlive($: EngineInterface, reason: StopReason, detail = ''): Promise<void> {
  const r = running
  running = null
  if (r === null) return
  r.timer?.cancel()
  await update($, bandAtom, current => (current !== null && current.mode === 'keepalive' ? null : current))
  const c = context()
  if (c !== null) $.ui.toast(c.t(`keepalive.stopped.${reason}`, { spent: formatUsd(r.spentUsd), budget: formatUsd(r.budgetUsd), until: c.clock(r.until), reason: detail }))
  await publish($)
}

/**
 * The person sent a prompt: a running keep-alive stops at once, before its
 * next refresh (REQ-15.0.3).
 *
 * @param $ the engine interface
 */
export async function keepAliveOnPrompt($: EngineInterface): Promise<void> {
  if (running === null) return
  running.promptSince = true
  await stopKeepAlive($, 'prompt')
}

/** Forgets any keep-alive, for a new session or the module's end. */
export function resetKeepAlive(): void {
  running?.timer?.cancel()
  running = null
  offered = null
}
