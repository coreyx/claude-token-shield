import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { PRICES_JSON, RULES_JSON, STRINGS_JSON } from './data.generated'

/** What the engine stand-ins saw the plugin do. */
interface Seen {
  toasts: string[]
  logs: { text: string; to?: string }[]
  writes: Map<string, string>
  runs: string[][]
}

/**
 * Stands in for the engine beneath the plugin: data files, version, machine,
 * processes, file writes, toasts and logs. Nothing sits beneath a plugin in a
 * test, so every call the host makes is answered here.
 */
function engine(on: On, o: { version?: string; rules?: string; binary?: boolean } = {}): Seen {
  const seen: Seen = { toasts: [], logs: [], writes: new Map(), runs: [] }
  const files: Record<string, string> = { 'prices.json': PRICES_JSON, 'rules.json': o.rules ?? RULES_JSON, 'strings.en.json': STRINGS_JSON }
  on('fs.read', (_, e) => {
    const name = e.path.split(/[\\/]/).pop() ?? ''
    if (name in files) return { value: files[name]! }
    throw new Error(`no file ${e.path}`)
  })
  on('fs.write', (_, e) => {
    // Paths arrive in the platform's form; tests compare them with forward slashes.
    seen.writes.set(e.path.replaceAll('\\', '/').replace(/^[A-Za-z]:/, ''), e.text)
    return { value: undefined }
  })
  on('session.version', () => ({ value: { version: o.version ?? '2.1.332', base: o.version ?? '2.1.332' } }))
  on('session.machine', () => ({ value: { sysname: 'Linux', release: '6.8.0', machine: 'x86_64', packageManagers: [], runtimes: [] } }))
  on('process.hookEnv', () => ({ value: { CLAUDE_PLUGIN_DATA: '/plugin-data' } }))
  on('process.run', (_, e) => {
    seen.runs.push([...e.argv])
    const [bin, cmd] = e.argv
    if (o.binary === true && bin!.includes('/bin/linux-amd64/')) {
      if (cmd === 'version') return { value: { exitCode: 0, stdout: '{"version":"0.2.0"}', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
      if (cmd === 'paths') return { value: { exitCode: 0, stdout: '{"dataDir":"/home/example/.token-shield"}', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
      if (cmd === 'self-install') return { value: { exitCode: 0, stdout: '{"installed":[]}', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    return { value: { exitCode: 1, stdout: '', stderr: 'not found', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.toast', (_, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', (_, e) => {
    seen.logs.push({ text: e.text, ...(e.to !== undefined ? { to: e.to } : {}) })
    return { value: undefined }
  })
  on('clock.now', () => ({ value: Date.UTC(2026, 0, 1, 15, 52, 2) }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  return seen
}

const start = { cwd: '/home/example/project', surface: 'terminal', isInteractive: true } as const
const prompt = (text: string) => ({ text, origin: { kind: 'composer' as const }, wait: false })

test('an invalid threshold is named in a toast and the default applies (AC 22.2)', { options: { thresholdUsd: -1 } }, async ($, on) => {
  const seen = engine(on)
  await $.session.start(start)
  expect(seen.toasts.some(t => t.includes('thresholdUsd') && t.includes('(2)'))).toBe(true)
  const mirrored = JSON.parse(seen.writes.get('/plugin-data/config.json') ?? '{}')
  expect(mirrored.thresholdUsd).toBe(2)
})

test('below v2.1.260 cache features are off and the message names the version (AC 1.4)', async ($, on) => {
  const seen = engine(on, { version: '2.1.259' })
  await $.session.start(start)
  expect(seen.toasts.some(t => t.includes('v2.1.260'))).toBe(true)
})

test('a failing assessor leaves prompts submitting and logs once (AC 21.3)', async ($, on) => {
  const seen = engine(on, { rules: '{' })
  await $.session.start(start)
  for (const text of ['first', 'second', 'third']) {
    const result = await $.prompt.submit(prompt(text))
    expect(result).toEqual({ text })
  }
  const submitFailures = seen.logs.filter(l => l.to === 'debug' && l.text.includes('prompt.submit failed'))
  expect(submitFailures.length).toBe(1)
})

test('without a binary the mod keeps its data in the plugin folder', async ($, on) => {
  const seen = engine(on)
  await $.session.start(start)
  expect(seen.writes.has('/plugin-data/config.json')).toBe(true)
})

test('with a binary the mod uses its data directory and installs a newer version', async ($, on) => {
  const seen = engine(on, { binary: true })
  await $.session.start(start)
  expect(seen.writes.has('/home/example/.token-shield/config.json')).toBe(true)
  expect(seen.runs.some(r => r[1] === 'self-install')).toBe(true)
})
