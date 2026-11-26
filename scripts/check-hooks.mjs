#!/usr/bin/env node
/**
 * Fails when the hooks module could write into the model's context or change
 * what Claude Code sends (requirements AC 5.4, REQ-20.0.1): it scans every
 * source file under plugin/hooks/ for registrations of context-writing events
 * and for result fields that add context or decide permissions.
 *
 * The scan is lexical on purpose: it is a tripwire that runs in CI on every
 * change, alongside `claude plugin validate`, not a proof. Comments are
 * removed before matching so prose can mention these names.
 *
 * One exception is allowed: the opt-in switch confirmation (REQ-10.0.6) may
 * return `permissionDecision`/`permissionDecisionReason`, on a line carrying,
 * or directly below, a `tshield-allow: REQ-10.0.6` comment.
 *
 * Usage: node scripts/check-hooks.mjs [dir]   (default: plugin/hooks)
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Events whose hooks write into the prompt, the system prompt or tool definitions. */
export const FORBIDDEN_EVENTS = ['prompt.compose', 'prompt.section', 'prompt.context', 'tool.describe', 'tool.list']

/** Result fields that add context or decide a permission. */
export const FORBIDDEN_FIELDS = ['context', 'additionalContext', 'permissionDecision', 'permissionDecisionReason']

/** Fields the REQ-10.0.6 marker may allow; `context` and `additionalContext` never are. */
const ALLOWABLE = new Set(['permissionDecision', 'permissionDecisionReason'])

const ALLOW_MARKER = 'tshield-allow: REQ-10.0.6'

/**
 * Replaces comments with spaces of the same shape, so line numbers survive and
 * prose in comments can't trip the check. Strings are left alone.
 *
 * @param {string} text source text
 * @returns {string}
 */
export function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, block => block.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`])\/\/.*$/gm, (_whole, before) => before)
}

/**
 * Scans one source file.
 *
 * @param {string} path the file's path, used in messages
 * @param {string} text the file's source text
 * @returns {string[]} one message per violation, `path:line: problem`
 */
export function scanSource(path, text) {
  const raw = text.split('\n')
  const code = stripComments(text).split('\n')
  const problems = []
  const eventPattern = new RegExp(`\\bon\\(\\s*['"\`](${FORBIDDEN_EVENTS.map(e => e.replace('.', '\\.')).join('|')})['"\`]`)
  const fieldPattern = new RegExp(`(?:^|[{,\\s])(${FORBIDDEN_FIELDS.join('|')})\\s*:`, 'g')
  code.forEach((line, i) => {
    const at = `${path}:${i + 1}`
    const event = eventPattern.exec(line)
    if (event) problems.push(`${at}: registers ${event[1]}, which writes into the model's context`)
    const allowed = raw[i]?.includes(ALLOW_MARKER) || raw[i - 1]?.includes(ALLOW_MARKER)
    for (const match of line.matchAll(fieldPattern)) {
      const field = match[1]
      if (allowed && ALLOWABLE.has(field)) continue
      problems.push(`${at}: sets ${field}, which ${ALLOWABLE.has(field) ? 'decides a permission' : 'adds context to a request'}`)
    }
  })
  return problems
}

/**
 * Lists the TypeScript and JavaScript sources under a directory.
 *
 * @param {string} dir directory to walk
 * @returns {string[]}
 */
export function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.(ts|tsx|js|mjs)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : []
  })
}

/** Runs the scan from the command line and exits 1 on any violation. */
function main() {
  const dir = process.argv[2] ?? 'plugin/hooks'
  const problems = sourceFiles(dir).flatMap(file => scanSource(relative(process.cwd(), file), readFileSync(file, 'utf8')))
  if (problems.length > 0) {
    console.error(`check-hooks: ${problems.length} violation(s)\n${problems.join('\n')}`)
    process.exit(1)
  }
  console.log(`check-hooks: ${dir} is clean`)
}

/** Whether this file was run directly, comparing paths case-insensitively on Windows drive letters. */
function isEntryPoint() {
  if (!process.argv[1]) return false
  const norm = (/** @type {string} */ p) => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p))
  return norm(fileURLToPath(import.meta.url)) === norm(process.argv[1])
}

if (isEntryPoint()) main()
