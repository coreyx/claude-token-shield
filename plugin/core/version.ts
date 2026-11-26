/**
 * Version of the shared decision core.
 *
 * Bumped when the core's observable behavior changes (assessment, pricing,
 * recommendation or rendering), so history records and parity fixtures can
 * say which core produced them. Independent of the plugin's own version,
 * which also moves for UI-only changes.
 */
export const CORE_VERSION = 1;

/**
 * Minimum Claude Code version Token Shield supports: the first release whose
 * statusline `prompt_cache` object carries miss causes (requirements REQ-1.0.4).
 */
export const MIN_CLAUDE_CODE_VERSION = '2.1.260';
