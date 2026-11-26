/**
 * The settings lever's pure half (REQ-5.0.2, design D11): which settings a
 * lever may change, the change itself as a merge into the user settings
 * JSON, a fingerprint to notice the file changing between showing and
 * writing, and the snippet to paste when writing is refused.
 */

/** A settings value as Claude Code's settings JSON holds it. */
export type SettingValue = string | boolean | number;

/** The settings a lever may change, each with the values it accepts. */
export const SETTING_LEVERS: Readonly<Record<string, readonly SettingValue[]>> = {
  promptCacheTtl: ['5m', '1h'],
  subagentPromptCacheTtl: ['5m', '1h'],
  idleCompaction: [true, false],
};

/** One proposed change: a key in the user settings file and its new value. */
export interface SettingChange {
  readonly key: string;
  readonly value: SettingValue;
}

/**
 * Whether a change is one a lever may make: a known key and one of its values.
 *
 * @param change the proposed change
 */
export function isAllowedSetting(change: SettingChange): boolean {
  return SETTING_LEVERS[change.key]?.includes(change.value) ?? false;
}

/**
 * A short fingerprint of a settings file's text (FNV-1a, 32 bits), or `none`
 * when there is no file. Comparing fingerprints tells whether the file
 * changed after it was shown; it is not a security measure.
 *
 * @param text the file's text, or `null` when it doesn't exist
 */
export function fingerprint(text: string | null): string {
  if (text === null) return 'none';
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${text.length}:${h.toString(16).padStart(8, '0')}`;
}

/** The outcome of merging a change into the settings text. */
export type ApplyResult = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly reason: 'unparseable' | 'not-object' };

/**
 * Sets one key in the settings JSON, keeping every other key and its order.
 * A missing file becomes one holding just the key. A file that isn't a JSON
 * object (comments, a syntax error) is left alone: the caller shows the
 * snippet to paste instead of rewriting a file it can't read faithfully.
 *
 * @param text the file's text, or `null` when it doesn't exist
 * @param change the key and value to set
 */
export function applySetting(text: string | null, change: SettingChange): ApplyResult {
  let doc: unknown = {};
  if (text !== null && text.trim() !== '') {
    try {
      doc = JSON.parse(text);
    } catch {
      return { ok: false, reason: 'unparseable' };
    }
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return { ok: false, reason: 'not-object' };
  const next = { ...(doc as Record<string, unknown>), [change.key]: change.value };
  return { ok: true, text: `${JSON.stringify(next, null, 2)}\n` };
}

/**
 * The JSON to paste into the settings file by hand when writing is refused.
 *
 * @param change the key and value to set
 */
export function pasteSnippet(change: SettingChange): string {
  return JSON.stringify({ [change.key]: change.value });
}
