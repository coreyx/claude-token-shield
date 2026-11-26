import type { EngineInterface } from 'claude-code'

/** Failures already reported this session, by where and what kind. */
const reported = new Set<string>()

/**
 * Reports a failed Token Shield hook to the debug log, once per place and
 * kind of failure per session (design.md "Error handling": the error
 * boundary). The hook's `.catch` handler then answers `next(e)`, so a bug in
 * Token Shield never blocks a prompt, a command or a render (REQ-21.0.3).
 *
 * Only the failure's kind and a short message are logged; the message comes
 * from Token Shield's own code, never from session content.
 *
 * @param $ the engine interface of the failing hook's handler
 * @param where the event or component that failed, e.g. `prompt.submit`
 * @param error the failure the engine reported (`next.error`) or one caught here
 */
export function reportFailure($: EngineInterface, where: string, error: unknown): void {
  const kind = failureKind(error)
  const key = `${where}:${kind}`
  if (reported.has(key)) return
  reported.add(key)
  const message = failureMessage(error)
  $.ui.log(`Token Shield: ${where} failed (${kind}${message === '' ? '' : `: ${message}`}); carrying on without it.`, { to: 'debug' })
}

/** A short name for a failure: the engine's kind, or the error's class name. */
function failureKind(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const e = error as { kind?: unknown; name?: unknown }
    if (typeof e.kind === 'string') return e.kind
    if (typeof e.name === 'string') return e.name
  }
  return 'error'
}

/** The failure's message, cut to one short line. */
function failureMessage(error: unknown): string {
  const raw = typeof error === 'object' && error !== null && typeof (error as { message?: unknown }).message === 'string' ? (error as { message: string }).message : ''
  const line = raw.split('\n')[0] ?? ''
  return line.length > 160 ? `${line.slice(0, 157)}...` : line
}

/** Forgets what was reported; tests start each case clean. */
export function resetReported(): void {
  reported.clear()
}
