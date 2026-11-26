import type { EngineInterface } from 'claude-code'

/** What the mod knows about its companion binaries and where data lives. */
export interface Companions {
  /** The tshield binary that answered, or `null` when none runs here. */
  readonly bin: string | null
  /** The data directory: tshield's answer, else the plugin's own data folder. */
  readonly dataDir: string
  /** The bridge and CLI features work only when a binary runs (design D15). */
  readonly available: boolean
  readonly version: string | null
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

/**
 * Finds the tshield binary for this machine among the plugin's
 * `bin/<os>-<arch>/`, asks it where the data directory is (it honors
 * TOKEN_SHIELD_HOME), and installs it into the data directory when the copy
 * there is missing or from another version, so a configured statusline keeps
 * working across plugin updates (design D14, D15). When no binary runs, the
 * mod keeps its history in its own data folder and reports the bridge and CLI
 * as unavailable.
 *
 * @param $ the engine interface
 */
export async function resolveCompanions($: EngineInterface): Promise<Companions> {
  const machine = await $.session.machine()
  const p = platform(machine.sysname, machine.machine)
  if (p !== null) {
    const bin = `${$.plugin.root}/bin/${p.os}-${p.arch}/tshield${p.ext}`
    const version = await runJson($, [bin, 'version', '--json'])
    const paths = version === null ? null : await runJson($, [bin, 'paths', '--json'])
    if (version !== null && paths !== null && typeof paths.dataDir === 'string') {
      const installed = await runJson($, [`${paths.dataDir}/bin/tshield${p.ext}`, 'version', '--json'])
      if (installed === null || installed.version !== version.version) await runJson($, [bin, 'self-install', '--json'])
      return { bin, dataDir: paths.dataDir, available: true, version: String(version.version) }
    }
  }
  const env = await $.process.hookEnv()
  return { bin: null, dataDir: env.CLAUDE_PLUGIN_DATA ?? '', available: false, version: null }
}
