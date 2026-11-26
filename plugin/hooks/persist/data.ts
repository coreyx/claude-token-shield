import type { EngineInterface } from 'claude-code'

import { parseSharedData } from '../../core/data/load'
import type { SharedData } from '../../core/data/types'

/**
 * Reads the shared data files the plugin ships in `data/` and parses them
 * with the core's loader. The core does no I/O, so this is the mod's only
 * path to prices, rules and strings.
 *
 * Declared at the top level of its own module because the validator only lets
 * `$` reach top-level functions (spikes.md, "Other findings").
 *
 * @param $ the engine interface of the calling hook
 * @returns the parsed data; rejects with a `DataError` when a file is invalid
 */
export async function readSharedData($: EngineInterface): Promise<SharedData> {
  const dir = `${$.plugin.root}/data`
  const [prices, rules, strings] = await Promise.all([
    $.fs.read(`${dir}/prices.json`),
    $.fs.read(`${dir}/rules.json`),
    $.fs.read(`${dir}/strings.en.json`),
  ])
  return parseSharedData({ prices, rules, strings })
}
