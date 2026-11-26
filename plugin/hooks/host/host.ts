import type { EngineInterface } from 'claude-code'

import type { Config } from '../../core/config/config'
import { validateConfig } from '../../core/config/config'
import { formatString } from '../../core/data/load'
import type { SharedData } from '../../core/data/types'
import { compareVersions } from '../../core/model/ids'
import { MIN_CLAUDE_CODE_VERSION } from '../../core/version'
import { readSharedData } from '../persist/data'
import type { Companions } from './companions'
import { resolveCompanions } from './companions'
import { announceInvalid, mirrorConfig } from './config'
import { reportFailure } from './failure'

/** Everything the mod's hooks share for the session. */
export interface Host {
  readonly config: Config
  /** The shared data files, or `null` when they couldn't be read (cache features off). */
  readonly data: SharedData | null
  readonly companions: Companions
  /** Claude Code's version, as the engine reports it. */
  readonly ccVersion: string
  /** Cache features run only on a supported Claude Code (REQ-1.0.4); missing data fails each feature on its own. */
  readonly enabled: boolean
}

/** The session's host, set at session start; `null` before it. */
let current: Host | null = null

/** The session's host, or `null` before session start has finished. */
export function host(): Host | null {
  return current
}

/**
 * Sets the mod up for a session: reads the shared data, validates the
 * configuration (toasting each invalid setting), checks Claude Code's version
 * (cache features off below the minimum, with a message naming it), finds the
 * companion binaries and mirrors the effective config for them.
 *
 * Each step fails on its own: an unreadable data file turns cache features
 * off rather than failing the session.
 *
 * @param $ the engine interface
 * @param options the plugin's userConfig values
 */
export async function startHost($: EngineInterface, options: Readonly<Record<string, unknown>>): Promise<Host> {
  let data: SharedData | null = null
  try {
    data = await readSharedData($)
  } catch (err) {
    reportFailure($, 'data', err)
  }
  const { config, invalid } = validateConfig(options)
  if (data !== null) announceInvalid($, invalid, data.strings)

  const ccVersion = (await $.session.version()).version
  const min = data?.rules.minClaudeCodeVersion ?? MIN_CLAUDE_CODE_VERSION
  const supported = !(compareVersions(ccVersion, min) < 0)
  if (!supported) {
    $.ui.toast(data !== null ? formatString(data.strings, 'error.version', { version: min }) : `Token Shield needs Claude Code v${min} or later; cache features are off.`)
  }

  let companions: Companions
  try {
    companions = await resolveCompanions($)
  } catch (err) {
    reportFailure($, 'companions', err)
    companions = { bin: null, dataDir: '', available: false, version: null }
  }
  try {
    await mirrorConfig($, companions.dataDir, config)
  } catch (err) {
    reportFailure($, 'config mirror', err)
  }
  current = { config, data, companions, ccVersion, enabled: supported }
  return current
}

/** Ends the session's host; the next session builds its own. */
export function stopHost(): void {
  current = null
}
