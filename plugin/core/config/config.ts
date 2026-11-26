/**
 * Token Shield's settings (design D20): the defaults, and validation that
 * keeps each valid value and replaces each invalid one with its default,
 * naming it so the user can be told (REQ-22.0.2).
 */

/** Notification levels, mutable individually (REQ-9.0.4). */
export type Level = 'info' | 'warning' | 'critical';

/** The effective configuration. */
export interface Config {
  /** Rebuilds above this many API-equivalent dollars are held or warned about. */
  readonly thresholdUsd: number;
  /** Rebuilds above this many tokens are held or warned about; the only threshold on a subscription. */
  readonly thresholdTokens: number;
  /** Warn window for the 1-hour TTL, in seconds. */
  readonly warnWindow1hSec: number;
  /** Warn window for the 5-minute TTL, in seconds. */
  readonly warnWindow5mSec: number;
  /** `hold` holds an expensive prompt, `warn` shows a warning instead, `off` does neither. */
  readonly gate: 'hold' | 'warn' | 'off';
  /** Put the rebuild cost inside Claude Code's switch confirmation (REQ-10.0.6). */
  readonly switchConfirm: 'on' | 'off';
  readonly mutedLevels: readonly Level[];
  readonly glyphs: 'unicode' | 'ascii';
  readonly keepAliveDefaultBudgetUsd: number;
  readonly keepAliveDefaultMinutes: number;
  /** Days of history kept. */
  readonly historyDays: number;
  /** Where the user's price override lives; `null` for the default `<data>/prices.override.json`. */
  readonly priceOverridesPath: string | null;
}

/** The defaults: a fresh install holds a $2-or-250k-token rebuild (REQ-12.0.6). */
export const DEFAULT_CONFIG: Config = {
  thresholdUsd: 2,
  thresholdTokens: 250_000,
  warnWindow1hSec: 600,
  warnWindow5mSec: 60,
  gate: 'hold',
  switchConfirm: 'off',
  mutedLevels: [],
  glyphs: 'unicode',
  keepAliveDefaultBudgetUsd: 1,
  keepAliveDefaultMinutes: 60,
  historyDays: 90,
  priceOverridesPath: null,
};

/** The validated configuration and the keys that fell back to their defaults. */
export interface ConfigResult {
  readonly config: Config;
  readonly invalid: readonly string[];
}

const LEVELS: readonly Level[] = ['info', 'warning', 'critical'];

/**
 * Validates raw settings (from `userConfig`). A missing key takes its default
 * silently; a present but invalid one takes its default and is named in
 * `invalid`. Unknown keys are ignored.
 *
 * @param raw the user's values by key
 */
export function validateConfig(raw: Readonly<Record<string, unknown>>): ConfigResult {
  const invalid: string[] = [];
  /** Takes `raw[key]` through `parse`, or the default when absent or invalid. */
  const pick = <K extends keyof Config>(key: K, parse: (v: unknown) => Config[K] | undefined, rawKey: string = key): Config[K] => {
    if (!(rawKey in raw) || raw[rawKey] === undefined) return DEFAULT_CONFIG[key];
    const parsed = parse(raw[rawKey]);
    if (parsed === undefined) {
      invalid.push(rawKey);
      return DEFAULT_CONFIG[key];
    }
    return parsed;
  };
  const config: Config = {
    thresholdUsd: pick('thresholdUsd', positiveNumber),
    thresholdTokens: pick('thresholdTokens', v => (positiveNumber(v) !== undefined && Number.isInteger(v) ? (v as number) : undefined)),
    warnWindow1hSec: pick('warnWindow1hSec', v => duration(v, 3600), 'warnWindow1h'),
    warnWindow5mSec: pick('warnWindow5mSec', v => duration(v, 300), 'warnWindow5m'),
    gate: pick('gate', v => oneOf(v, ['hold', 'warn', 'off'] as const)),
    switchConfirm: pick('switchConfirm', v => oneOf(v, ['on', 'off'] as const)),
    mutedLevels: pick('mutedLevels', levels),
    glyphs: pick('glyphs', v => oneOf(v, ['unicode', 'ascii'] as const)),
    keepAliveDefaultBudgetUsd: pick('keepAliveDefaultBudgetUsd', positiveNumber),
    keepAliveDefaultMinutes: pick('keepAliveDefaultMinutes', positiveNumber),
    historyDays: pick('historyDays', v => (positiveNumber(v) !== undefined && Number.isInteger(v) ? (v as number) : undefined)),
    priceOverridesPath: pick('priceOverridesPath', v => (typeof v === 'string' && v.trim() !== '' ? v : undefined)),
  };
  return { config, invalid };
}

/** A finite number above 0; numeric strings count, since settings UIs often store text. */
function positiveNumber(v: unknown): number | undefined {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : undefined;
}

/** One of the allowed strings. */
function oneOf<T extends string>(v: unknown, allowed: readonly T[]): T | undefined {
  return allowed.includes(v as T) ? (v as T) : undefined;
}

/** A list of notification levels, or a comma-separated string of them. */
function levels(v: unknown): readonly Level[] | undefined {
  const items = typeof v === 'string' ? (v.trim() === '' ? [] : v.split(',').map(s => s.trim())) : v;
  if (!Array.isArray(items) || !items.every(i => LEVELS.includes(i as Level))) return undefined;
  return [...new Set(items as Level[])];
}

/**
 * A duration such as `10m`, `90s` or `1h` (or a bare number of seconds), in
 * seconds, no longer than `maxSec`: a warn window can't exceed its TTL.
 */
function duration(v: unknown, maxSec: number): number | undefined {
  let sec: number | undefined;
  if (typeof v === 'number') sec = v;
  else if (typeof v === 'string') {
    const m = /^\s*(\d+(?:\.\d+)?)\s*(s|m|h)?\s*$/.exec(v);
    if (m) sec = Number(m[1]) * (m[2] === 'h' ? 3600 : m[2] === 'm' ? 60 : 1);
  }
  return sec !== undefined && Number.isFinite(sec) && sec >= 0 && sec <= maxSec ? sec : undefined;
}
