import type { EngineInterface } from 'claude-code'

import { parseSnapshot } from '../../core/model/snapshot'
import type { NativeSnapshot } from '../../core/model/types'

/** The bridge's snapshot.json format this reader understands. */
const SNAPSHOT_FORMAT = 1

/** When the snapshot file last changed, so an unchanged one isn't re-read. */
let lastMtime = -1

/** Forgets the last-read time; a new session starts clean. */
export function resetSnapshotReader(): void {
  lastMtime = -1
}

/**
 * Reads the bridge's snapshot for this session if it changed since the last
 * read (design: polled by mtime every 5 s and on turn.complete). The file
 * holds `{ v, receivedAt, payload }`, the payload being the whitelisted
 * statusline fields; the core's parseSnapshot reads it as the bridge's Go
 * parser does.
 *
 * @param $ the engine interface
 * @param dataDir the data directory
 * @param sessionId this session's id
 * @returns the new snapshot, or `null` when there is none or it hasn't changed
 */
export async function readChangedSnapshot($: EngineInterface, dataDir: string, sessionId: string): Promise<NativeSnapshot | null> {
  if (dataDir === '' || sessionId === '') return null
  const path = `${dataDir}/sessions/${sessionId}/snapshot.json`
  // No file is normal (no bridge yet, or not for this session); a file that
  // exists and can't be read is a real failure, left for the caller to report.
  if (!(await $.fs.exists(path))) return null
  const mtime = (await $.fs.stat(path)).mtimeMs
  if (mtime === lastMtime) return null
  lastMtime = mtime
  const file = JSON.parse(await $.fs.read(path)) as { v?: unknown; receivedAt?: unknown; payload?: unknown }
  if (file.v !== SNAPSHOT_FORMAT || typeof file.receivedAt !== 'number') return null
  return parseSnapshot(file.payload, file.receivedAt)
}
