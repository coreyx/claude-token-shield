/**
 * The engine stand-ins the mod's tests share. In `claude plugin test` nothing
 * sits beneath the plugin's hooks, so every call the mod makes on `$` is
 * answered here: data files, version, machine, environment, processes, the
 * clock, file reads and writes, toasts, logs and the status line.
 */

import type { On } from 'claude-code'
import { mock } from 'claude-code/testing'
import type { MockClock } from 'claude-code/testing'

import { PRICES_JSON, RULES_JSON, STRINGS_JSON } from './data.generated'

/** What the stand-ins saw the plugin do, and files the test can place. */
export interface Seen {
  toasts: string[]
  /** Each toast's timeoutMs, in the same order. */
  toastTimeouts: (number | undefined)[]
  logs: { text: string; to?: string }[]
  /** Files by forward-slash path without a drive letter; reads see writes. */
  files: Map<string, { text: string; mtimeMs: number }>
  runs: string[][]
  statuses: (string | undefined)[]
  clock: MockClock
}

/** Options for the stand-ins. */
export interface EngineOptions {
  version?: string
  rules?: string
  /** Answer as if the companion binary ran (data in /home/example/.token-shield). */
  binary?: boolean
  env?: Record<string, string>
  model?: string
  now?: number
}

/** The session id every test session has. */
export const SESSION = '11111111-2222-3333-4444-555555555555'

/** 2026-01-01T15:52:02Z, the time tests start at unless told otherwise. */
export const T0 = Date.UTC(2026, 0, 1, 15, 52, 2)

/** Paths arrive in the platform's form; the stand-ins key them with forward slashes. */
export function norm(path: string): string {
  return path.replaceAll('\\', '/').replace(/^[A-Za-z]:/, '')
}

/** Registers the stand-ins and returns what they record. */
export function engine(on: On, o: EngineOptions = {}): Seen {
  const clock = mock.clock(on, { now: o.now ?? T0 })
  mock.env(on, o.env ?? {})
  const seen: Seen = { toasts: [], toastTimeouts: [], logs: [], files: new Map(), runs: [], statuses: [], clock }
  const data: Record<string, string> = { 'prices.json': PRICES_JSON, 'rules.json': o.rules ?? RULES_JSON, 'strings.en.json': STRINGS_JSON }
  on('fs.read', (_, e) => {
    const p = norm(e.path)
    const placed = seen.files.get(p)
    if (placed !== undefined) return { value: placed.text }
    const name = p.split('/').pop() ?? ''
    if (p.includes('/data/') && name in data) return { value: data[name]! }
    throw new Error(`no file ${p}`)
  })
  // The cross-session store: kept for the whole test, as $.store keeps it across sessions.
  const store = new Map<string, unknown>()
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', (_, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  // Lists the stand-in files and the folders their paths imply, one level down.
  on('fs.list', (_, e) => {
    const dir = norm(e.path ?? '')
    const names = new Map<string, 'file' | 'dir'>()
    for (const p of seen.files.keys()) {
      if (!p.startsWith(`${dir}/`)) continue
      const [first, ...rest] = p.slice(dir.length + 1).split('/')
      names.set(first!, rest.length > 0 ? 'dir' : 'file')
    }
    return { value: [...names].map(([name, kind]) => ({ name, kind, size: 0, mtimeMs: T0, isLink: false })) }
  })
  on('fs.stat', (_, e) => {
    const f = seen.files.get(norm(e.path))
    if (f === undefined) throw new Error(`no file ${norm(e.path)}`)
    return { value: { kind: 'file', size: f.text.length, mtimeMs: f.mtimeMs, isLink: false } }
  })
  on('fs.write', (_, e) => {
    seen.files.set(norm(e.path), { text: e.text, mtimeMs: clock.now() })
    return { value: undefined }
  })
  on('session.version', () => ({ value: { version: o.version ?? '2.1.332', base: o.version ?? '2.1.332' } }))
  on('session.machine', () => ({ value: { sysname: 'Linux', release: '6.8.0', machine: 'x86_64', packageManagers: [], runtimes: [] } }))
  on('session.id', () => ({ value: SESSION }))
  on('session.model', () => ({ value: o.model ?? 'claude-opus-5-5' }))
  on('process.hookEnv', () => ({ value: { CLAUDE_PLUGIN_DATA: '/plugin-data' } }))
  on('process.run', (_, e) => {
    seen.runs.push([...e.argv])
    const [bin, cmd] = e.argv
    const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (o.binary === true && bin!.includes('/bin/linux-amd64/')) {
      if (cmd === 'version') return ok('{"version":"0.2.0"}')
      if (cmd === 'paths') return ok('{"dataDir":"/home/example/.token-shield"}')
      if (cmd === 'self-install') return ok('{"installed":[]}')
    }
    return { value: { exitCode: 1, stdout: '', stderr: 'not found', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.toast', (_, e) => {
    seen.toasts.push(e.text)
    seen.toastTimeouts.push(e.timeoutMs)
    return { value: undefined }
  })
  on('ui.log', (_, e) => {
    seen.logs.push({ text: e.text, ...(e.to !== undefined ? { to: e.to } : {}) })
    return { value: undefined }
  })
  on('ui.status', (_, e) => {
    seen.statuses.push(e.text)
    return { value: undefined }
  })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', () => ({ sessionId: SESSION }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  return seen
}

/** A session start as an interactive terminal makes it. */
export const START = { cwd: '/home/example/project', surface: 'terminal', isInteractive: true } as const

/** A prompt typed at the composer. */
export function prompt(text: string) {
  return { text, origin: { kind: 'composer' as const }, wait: false }
}
