import type { EngineInterface } from 'claude-code'

import type { Config } from '../../core/config/config'
import { DEFAULT_CONFIG } from '../../core/config/config'
import { formatString } from '../../core/data/load'
import type { Strings } from '../../core/data/types'

/**
 * Tells the user about each setting that fell back to its default, one toast
 * per setting (REQ-22.0.2, AC 22.2).
 *
 * @param $ the engine interface
 * @param invalid the settings validateConfig named
 * @param strings the catalog
 */
export function announceInvalid($: EngineInterface, invalid: readonly string[], strings: Strings): void {
  for (const key of invalid) {
    const def = DEFAULT_CONFIG[configKey(key)]
    $.ui.toast(formatString(strings, 'error.config_invalid', { key, default: Array.isArray(def) ? def.join(', ') || 'none' : String(def ?? 'default') }))
  }
}

/** The Config field a userConfig key fills (the warn windows are named in seconds there). */
function configKey(key: string): keyof Config {
  if (key === 'warnWindow1h') return 'warnWindow1hSec'
  if (key === 'warnWindow5m') return 'warnWindow5mSec'
  return key as keyof Config
}

/**
 * Mirrors the effective configuration to `config.json` in the data directory,
 * where the bridge and tshield read the glyph set and thresholds (design D20).
 *
 * @param $ the engine interface
 * @param dataDir the data directory
 * @param config the effective configuration
 */
export async function mirrorConfig($: EngineInterface, dataDir: string, config: Config): Promise<void> {
  if (dataDir === '') return
  await $.fs.write(`${dataDir}/config.json`, `${JSON.stringify({ v: 1, ...config }, null, 2)}\n`)
}
