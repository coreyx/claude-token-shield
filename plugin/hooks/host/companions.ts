import type { EngineInterface } from 'claude-code'

import { formatString } from '../../core/data/load'
import type { Strings } from '../../core/data/types'

/**
 * Why no tshield binary runs here, kept so the messages that need one can
 * name what was tried and what to do: no build for this platform, the file
 * missing from the plugin, or a file that's there but doesn't answer (a
 * library archive or another platform's build under the right name).
 */
export type CompanionProblem =
  | { readonly kind: 'no-platform'; readonly platform: string }
  | { readonly kind: 'not-found' | 'not-runnable'; readonly path: string }

/** What the mod knows about its companion binaries and where data lives. */
export interface Companions {
  /** The tshield binary that answered, or `null` when none runs here. */
  readonly bin: string | null
  /** The data directory: tshield's answer, else the plugin's own data folder. */
  readonly dataDir: string
  /** The bridge and CLI features work only when a binary runs (design D15). */
  readonly available: boolean
  readonly version: string | null
  /** Why no binary runs, or `null` when one does or the check itself failed. */
  readonly problem: CompanionProblem | null
}

/** Maps `uname` names to Go's GOOS and GOARCH, which name the bin folders. */
function platform(sysname: string, machine: string): { os: string; arch: string; ext: string } | null {
  const os = sysname === 'Linux' ? 'linux' : sysname === 'Darwin' ? 'darwin' : sysname.startsWith('Windows') ? 'windows' : null
  const arch = machine === 'x86_64' || machine === 'amd64' ? 'amd64' : machine === 'arm64' || machine === 'aarch64' ? 'arm64' : null
  if (os === null || arch === null) return null
  return { os, arch, ext: os === 'windows' ? '.exe' : '' }
}

/** Runs a command and parses its JSON output, or `null` if it doesn't answer. */
async function runJson($: EngineInterface, argv: readonly string[]): Promise<Record<string, unknown> | null> {
  try {
    const r = await $.process.run(argv, { timeoutMs: 10_000 })
    if (r.exitCode !== 0) return null
    const parsed = JSON.parse(r.stdout) as unknown
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** Whether a file exists, counting a failed check as absent. */
async function exists($: EngineInterface, path: string): Promise<boolean> {
  try {
    return await $.fs.exists(path)
  } catch {
    return false
  }
}

/**
 * Finds the tshield binary for this machine among the plugin's
 * `bin/<os>-<arch>/`, asks it where the data directory is (it honors
 * TOKEN_SHIELD_HOME), and installs it into the data directory when the copy
 * there is missing or from another version, so a configured statusline keeps
 * working across plugin updates (design D14, D15). When no binary runs, the
 * mod keeps its history in its own data folder, reports the bridge and CLI
 * as unavailable, and records why.
 *
 * @param $ the engine interface
 */
export async function resolveCompanions($: EngineInterface): Promise<Companions> {
  const machine = await $.session.machine()
  const p = platform(machine.sysname, machine.machine)
  let problem: CompanionProblem
  if (p === null) {
    problem = { kind: 'no-platform', platform: `${machine.sysname} ${machine.machine}` }
  } else {
    const bin = `${$.plugin.root}/bin/${p.os}-${p.arch}/tshield${p.ext}`
    const version = await runJson($, [bin, 'version', '--json'])
    const paths = version === null ? null : await runJson($, [bin, 'paths', '--json'])
    if (version !== null && paths !== null && typeof paths.dataDir === 'string') {
      const installed = await runJson($, [`${paths.dataDir}/bin/tshield${p.ext}`, 'version', '--json'])
      if (installed === null || installed.version !== version.version) await runJson($, [bin, 'self-install', '--json'])
      return { bin, dataDir: paths.dataDir, available: true, version: String(version.version), problem: null }
    }
    // The path is shown to the person, so it takes the platform's separators.
    const shown = p.os === 'windows' ? bin.replaceAll('/', '\\') : bin
    problem = { kind: (await exists($, bin)) ? 'not-runnable' : 'not-found', path: shown }
  }
  const env = await $.process.hookEnv()
  return { bin: null, dataDir: env.CLAUDE_PLUGIN_DATA ?? '', available: false, version: null, problem }
}

/**
 * Says why no tshield binary runs, for the messages that need one: the path
 * tried and what to do about it.
 *
 * @param strings the string catalog
 * @param problem what resolution found, or `null` when it couldn't check
 * @returns a clause that completes "because …" or "and …"
 */
export function describeProblem(strings: Strings, problem: CompanionProblem | null): string {
  if (problem === null) return formatString(strings, 'companions.unchecked')
  if (problem.kind === 'no-platform') return formatString(strings, 'companions.no_platform', { platform: problem.platform })
  return formatString(strings, problem.kind === 'not-found' ? 'companions.not_found' : 'companions.not_runnable', { path: problem.path })
}
