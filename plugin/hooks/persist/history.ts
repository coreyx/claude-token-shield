import type { EngineInterface } from 'claude-code'

import type { EventRecord, RequestRecord } from '../../core/model/types'

/**
 * The history writer (design D16): records buffered in memory and flushed
 * with a debounce, each flush rewriting the open chunk
 * `history/<session>/<seq>.json` whole. A chunk closes at 500 records or
 * 256 KiB, and the next flush starts the next one. Only whitelisted record
 * shapes are written: ids, numbers, enums and timestamps (REQ-1.0.2).
 */

/** One history record, as tshield's history reader expects it. */
export type HistoryRecord = { readonly type: 'request'; readonly request: RequestRecord } | { readonly type: 'event'; readonly event: EventRecord }

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
