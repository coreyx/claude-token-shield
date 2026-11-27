#!/usr/bin/env node
/**
 * Stages the installable plugin in dist/plugin/ (tech.md "Distribution",
 * design D15): the plugin folder without its tests, plus both Go companions
 * cross-compiled for every target into bin/<os>-<arch>/. The release workflow
 * commits that folder to the release branch, which the marketplace entry
 * installs from, and archives each target's binaries for the GitHub Release.
 * CI runs it too, so a target that stops compiling fails before a release.
 *
 * Usage: node scripts/build-release.mjs <version>
 *   <version> is plugin.json's version, with or without a leading v; the
 *   build refuses one that doesn't match, so a tag can't ship mislabeled.
 */

import { execFileSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const stage = join(root, 'dist', 'plugin')

/** Every platform Token Shield ships for: three systems on both architectures. */
export const TARGETS = [
  ['linux', 'amd64'],
  ['linux', 'arm64'],
  ['darwin', 'amd64'],
  ['darwin', 'arm64'],
  ['windows', 'amd64'],
  ['windows', 'arm64'],
]

const COMMANDS = ['tshield', 'tshield-statusline']

const given = process.argv[2]
if (given === undefined) {
  console.error('usage: node scripts/build-release.mjs <version>')
  process.exit(2)
}
const version = given.replace(/^v/, '')
const manifest = JSON.parse(readFileSync(join(root, 'plugin', '.claude-plugin', 'plugin.json'), 'utf8'))
if (manifest.version !== version) {
  console.error(`version ${version} doesn't match plugin.json's ${manifest.version}`)
  process.exit(1)
}

rmSync(stage, { recursive: true, force: true })
mkdirSync(stage, { recursive: true })
// The tests and the engine-written types stay behind: an install needs neither,
// and the types are rewritten on every load anyway.
cpSync(join(root, 'plugin'), stage, {
  recursive: true,
  filter: src => {
    const rel = src.slice(join(root, 'plugin').length).replaceAll('\\', '/')
    return !(rel === '/test' || rel.startsWith('/test/') || rel === '/.claude-plugin/types' || rel.startsWith('/.claude-plugin/types/') || /^\/bin\/[a-z]+-[a-z0-9]+(\/|$)/.test(rel))
  },
})

for (const [os, arch] of TARGETS) {
  const out = join(stage, 'bin', `${os}-${arch}`)
  mkdirSync(out, { recursive: true })
  for (const cmd of COMMANDS) {
    const file = join(out, os === 'windows' ? `${cmd}.exe` : cmd)
    // Static, reproducible binaries: no cgo, no local paths, no symbol tables.
    execFileSync('go', ['build', '-trimpath', '-ldflags', `-s -w -X github.com/coreyx/claude-token-shield/internal/version.Version=${version}`, '-o', file, `./cmd/${cmd}`], {
      cwd: root,
      stdio: 'inherit',
      env: { ...process.env, CGO_ENABLED: '0', GOOS: os, GOARCH: arch },
    })
    chmodSync(file, 0o755)
  }
}
// The release branch is its own tree, so it carries its own line-ending rules:
// a Windows checkout with autocrlf would otherwise turn the POSIX launcher
// CRLF, which sh refuses, and could rewrite the binaries.
writeFileSync(
  join(stage, '.gitattributes'),
  ['* text=auto eol=lf', '*.cmd text eol=crlf', 'bin/*-*/** binary', ''].join('\n'),
)
// The POSIX launcher must stay executable however the checkout set its mode.
chmodSync(join(stage, 'bin', 'tshield'), 0o755)

for (const [os, arch] of TARGETS) {
  for (const cmd of COMMANDS) {
    if (!existsSync(join(stage, 'bin', `${os}-${arch}`, os === 'windows' ? `${cmd}.exe` : cmd))) {
      console.error(`missing ${cmd} for ${os}-${arch}`)
      process.exit(1)
    }
  }
}
console.log(`staged token-shield ${version} for ${TARGETS.length} targets in dist/plugin/`)
