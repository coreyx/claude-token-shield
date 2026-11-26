import type { EngineInterface } from 'claude-code'

import type { AssessmentRecord } from '../../core/history/calibrate'
import type { SessionHistory } from '../../core/history/summarize'
import type { EventRecord, RequestRecord, Ttl } from '../../core/model/types'

/**
 * The history writer (design D16): records buffered in memory and flushed
 * with a debounce, each flush rewriting the open chunk
 * `history/<session>/<seq>.json` whole. A chunk closes at 500 records or
 * 256 KiB, and the next flush starts the next one. Only whitelisted record
 * shapes are written: ids, numbers, enums and timestamps (REQ-1.0.2).
 */

/** One history record, as tshield's history reader expects it. */
export type HistoryRecord =
  | { readonly type: 'request'; readonly request: RequestRecord }
  | { readonly type: 'event'; readonly event: EventRecord }
  | { readonly type: 'assessment'; readonly assessment: AssessmentRecord }

/** Chunk limits (D16). */
export const MAX_RECORDS = 500
export const MAX_BYTES = 256 * 1024

/** The chunk format version. */
const CHUNK_FORMAT = 1

let seq = 0
let records: HistoryRecord[] = []
let dirty = false

/** Starts the writer over for a new session. */
export function resetHistory(): void {
  seq = 0
  records = []
  dirty = false
}

/** Copies a request field by field, so nothing else rides along. */
function cleanRequest(r: RequestRecord): RequestRecord {
  return {
    id: r.id,
    lane: r.lane,
    tsStart: r.tsStart,
    tsStartTier: r.tsStartTier,
    ...(r.durationMs !== undefined ? { durationMs: r.durationMs } : {}),
    model: r.model,
    speed: r.speed,
    ...(r.effort !== undefined ? { effort: r.effort } : {}),
    ...(r.ttl !== undefined ? { ttl: r.ttl } : {}),
    usage: { input: r.usage.input, read: r.usage.read, write5m: r.usage.write5m, write1h: r.usage.write1h, output: r.usage.output },
    source: r.source,
  }
}

/** Copies an event field by field. */
function cleanEvent(e: EventRecord): EventRecord {
  const detail = e.detail === undefined ? undefined : { ...(e.detail.from !== undefined ? { from: e.detail.from } : {}), ...(e.detail.to !== undefined ? { to: e.detail.to } : {}) }
  return { ts: e.ts, kind: e.kind, ...(detail !== undefined ? { detail } : {}) }
}

/** Copies an assessment record field by field: numbers, enums and ids only. */
function cleanAssessment(a: AssessmentRecord): AssessmentRecord {
  return {
    ts: a.ts,
    state: a.state,
    pHit: a.pHit,
    interval: [a.interval[0], a.interval[1]],
    ttl: a.ttl,
    remainingSec: a.remainingSec,
    marginSec: a.marginSec,
    ccVersion: a.ccVersion,
    model: a.model,
    outcome: a.outcome,
  }
}

/** Buffers the assessment that preceded a main request, with its outcome (REQ-14.0.4). */
export function recordAssessment(a: AssessmentRecord): void {
  records.push({ type: 'assessment', assessment: cleanAssessment(a) })
  dirty = true
}

/** Buffers a request for the next flush. */
export function recordRequest(r: RequestRecord): void {
  records.push({ type: 'request', request: cleanRequest(r) })
  dirty = true
}

/** Buffers an event for the next flush. */
export function recordEvent(e: EventRecord): void {
  records.push({ type: 'event', event: cleanEvent(e) })
  dirty = true
}

/** Whether there is anything to flush. */
export function historyDirty(): boolean {
  return dirty
}

/**
 * Writes the open chunk whole, then closes it when full.
 *
 * @param $ the engine interface
 * @param dataDir the data directory
 * @param sessionId the session's id, which names its folder
 */
export async function flushHistory($: EngineInterface, dataDir: string, sessionId: string): Promise<void> {
  if (!dirty || dataDir === '' || sessionId === '') return
  const text = JSON.stringify({ v: CHUNK_FORMAT, session_id: sessionId, seq, records })
  await $.fs.write(`${dataDir}/history/${sessionId}/${String(seq).padStart(6, '0')}.json`, text)
  dirty = false
  if (records.length >= MAX_RECORDS || text.length >= MAX_BYTES) {
    seq += 1
    records = []
  }
}

/** A chunk's file name for its number. */
const CHUNK_NAME = /^(\d{6})\.json$/

/**
 * Picks a session's history up where an earlier run left it, and returns
 * the TTL of its last recorded main request. A resumed session keeps its
 * id, so starting again at chunk 0 would overwrite what the earlier run
 * wrote; the next chunk after the highest on disk is used instead.
 *
 * @param $ the engine interface
 * @param dataDir the data directory
 * @param sessionId the session's id
 * @returns the last recorded TTL, if any
 */
export async function continueHistory($: EngineInterface, dataDir: string, sessionId: string): Promise<Ttl | undefined> {
  if (dataDir === '' || sessionId === '') return undefined
  const dir = `${dataDir}/history/${sessionId}`
  const entries = await $.fs.list(dir).catch(() => [])
  const seqs = entries
    .map(e => (e.kind === 'file' ? CHUNK_NAME.exec(e.name)?.[1] : undefined))
    .filter((s): s is string => s !== undefined)
    .map(Number)
    .sort((a, b) => a - b)
  if (seqs.length === 0) return undefined
  seq = Math.max(seq, seqs[seqs.length - 1]! + 1)
  // The newest chunks first; a few are enough to find the last main request.
  for (const n of seqs.slice(-3).reverse()) {
    try {
      const doc = JSON.parse(await $.fs.read(`${dir}/${String(n).padStart(6, '0')}.json`)) as { records?: HistoryRecord[] }
      for (const r of [...(doc.records ?? [])].reverse()) {
        if (r.type === 'request' && r.request.lane === 'main' && (r.request.ttl === '5m' || r.request.ttl === '1h')) return r.request.ttl
      }
    } catch {
      // An unreadable chunk is skipped; tshield's reader reports it.
    }
  }
  return undefined
}

/**
 * Writes the heartbeat that tells the bridge the mod is drawing the segment
 * (design D14: the bridge draws its own when this is older than 90 s).
 *
 * @param $ the engine interface
 * @param dataDir the data directory
 * @param sessionId the session's id
 * @param pluginVersion the plugin's version, for diagnosis
 */
export async function writeHeartbeat($: EngineInterface, dataDir: string, sessionId: string, pluginVersion: string): Promise<void> {
  if (dataDir === '' || sessionId === '') return
  await $.fs.write(`${dataDir}/sessions/${sessionId}/mod-heartbeat.json`, JSON.stringify({ v: 1, ts: await $.clock.now(), pluginVersion }))
}

/**
 * Reads one session's history from its chunks, in seq order, as tshield's
 * reader does: an unreadable chunk or one from a newer format is skipped and
 * counted, never fatal.
 *
 * @param $ the engine interface
 * @param dataDir the data directory
 * @param sessionId the session's id
 */
export async function readSessionHistory($: EngineInterface, dataDir: string, sessionId: string): Promise<SessionHistory> {
  const dir = `${dataDir}/history/${sessionId}`
  const entries = await $.fs.list(dir).catch(() => [])
  const chunks: { seq: number; records: HistoryRecord[] }[] = []
  let skipped = 0
  for (const e of entries) {
    if (e.kind !== 'file' || !e.name.endsWith('.json')) continue
    try {
      const doc = JSON.parse(await $.fs.read(`${dir}/${e.name}`)) as { v?: number; seq?: number; records?: HistoryRecord[] }
      if (typeof doc.v !== 'number' || doc.v > CHUNK_FORMAT || !Array.isArray(doc.records)) {
        skipped += 1
        continue
      }
      chunks.push({ seq: doc.seq ?? 0, records: doc.records })
    } catch {
      skipped += 1
    }
  }
  chunks.sort((a, b) => a.seq - b.seq)
  const requests: RequestRecord[] = []
  const events: EventRecord[] = []
  const assessments: AssessmentRecord[] = []
  for (const c of chunks) {
    for (const r of c.records) {
      if (r.type === 'request' && r.request !== undefined) requests.push(r.request)
      else if (r.type === 'event' && r.event !== undefined) events.push(r.event)
      else if (r.type === 'assessment' && r.assessment !== undefined) assessments.push(r.assessment)
    }
  }
  return { sessionId, requests, events, assessments, skipped }
}

/**
 * The sessions with history in the data directory.
 *
 * @param $ the engine interface
 * @param dataDir the data directory
 */
export async function historySessions($: EngineInterface, dataDir: string): Promise<string[]> {
  const entries = await $.fs.list(`${dataDir}/history`).catch(() => [])
  return entries.filter(e => e.kind === 'dir').map(e => e.name)
}
