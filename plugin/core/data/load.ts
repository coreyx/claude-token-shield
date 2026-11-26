/**
 * Parses and checks the shared data files. The core never reads files itself:
 * the mod reads the text with `$.fs.read` and tests read it from disk, and
 * both hand it here, so the core stays pure and testable.
 *
 * The checks are the invariants the core relies on, not a full JSON Schema
 * validation: the plugin ships no runtime dependencies, and the test suites
 * validate the files against `schemas/` in full.
 */

import type {
  CatalogString,
  EventRule,
  Impact,
  ModelPrice,
  PriceTable,
  Prices,
  ProviderPrice,
  Rules,
  SharedData,
  Strings,
} from './types';

/** The data-file format version this core understands. */
export const DATA_VERSION = 1;

/** A shared data file is missing a field, holds a wrong value, or is not JSON. */
export class DataError extends Error {
  /**
   * @param file the file's name, e.g. `prices.json`
   * @param path where in the file the problem is, e.g. `tables[0].models.x.input`
   * @param problem what is wrong there
   */
  constructor(
    readonly file: string,
    readonly path: string,
    readonly problem: string,
  ) {
    super(`${file}: ${path === '' ? '' : `${path}: `}${problem}`);
    this.name = 'DataError';
  }
}

/** The raw text of each file, as read from disk. */
export interface SharedDataText {
  readonly prices: string;
  readonly rules: string;
  readonly strings: string;
}

/** Parses all three files and checks them; throws {@link DataError} on the first problem. */
export function parseSharedData(text: SharedDataText): SharedData {
  return {
    prices: parsePrices(text.prices),
    rules: parseRules(text.rules),
    strings: parseStrings(text.strings),
  };
}

/** Parses `prices.json`. */
export function parsePrices(text: string): Prices {
  const c = new Checker('prices.json', parseJson('prices.json', text));
  const root = c.object(c.value, '');
  c.version(root);
  if (root.unit !== 'USD per million tokens') c.fail('unit', 'must be "USD per million tokens"');
  const tables = c.array(root.tables, 'tables');
  if (tables.length === 0) c.fail('tables', 'needs at least one table');
  tables.forEach((t, i) => checkTable(c, t, `tables[${i}]`));
  return root as unknown as Prices;
}

/** Checks one dated price table. */
function checkTable(c: Checker, value: unknown, path: string): void {
  const table = c.object(value, path) as Partial<Record<keyof PriceTable, unknown>>;
  if (typeof table.effective !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(table.effective)) {
    c.fail(`${path}.effective`, 'must be a YYYY-MM-DD date');
  }
  for (const [id, m] of Object.entries(c.object(table.models, `${path}.models`))) {
    const mp = `${path}.models.${id}`;
    const model = c.object(m, mp) as Partial<Record<keyof ModelPrice, unknown>>;
    for (const key of ['input', 'read_mult', 'write_5m_mult', 'write_1h_mult'] as const) c.positive(model[key], `${mp}.${key}`);
    if (model.fast_input !== undefined) c.positive(model.fast_input, `${mp}.fast_input`);
    if (model.tiers !== undefined) {
      c.array(model.tiers, `${mp}.tiers`).forEach((tier, i) => {
        const tp = `${mp}.tiers[${i}]`;
        const t = c.object(tier, tp);
        c.positive(t.above, `${tp}.above`);
        c.positive(t.input, `${tp}.input`);
      });
    }
  }
  for (const [key, p] of Object.entries(c.object(table.providers, `${path}.providers`))) {
    const pp = `${path}.providers.${key}`;
    const provider = c.object(p, pp) as Partial<Record<keyof ProviderPrice, unknown>>;
    c.positive(provider.multiplier, `${pp}.multiplier`);
    if (provider.basis !== 'list' && provider.basis !== 'estimated') c.fail(`${pp}.basis`, 'must be "list" or "estimated"');
  }
}

const IMPACTS: readonly Impact[] = ['WILL', 'MAY', 'NO_EFFECT'];

/** Parses `rules.json`. */
export function parseRules(text: string): Rules {
  const c = new Checker('rules.json', parseJson('rules.json', text));
  const root = c.object(c.value, '') as Partial<Record<keyof Rules, unknown>> & Record<string, unknown>;
  c.version(root);
  if (typeof root.minClaudeCodeVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(root.minClaudeCodeVersion)) {
    c.fail('minClaudeCodeVersion', 'must be a version like 2.1.260');
  }
  c.array(root.perMessageEffortModels, 'perMessageEffortModels');
  const seen = new Set<string>();
  c.array(root.events, 'events').forEach((e, i) => {
    const ep = `events[${i}]`;
    const event = c.object(e, ep) as Partial<Record<keyof EventRule, unknown>>;
    if (typeof event.kind !== 'string' || event.kind === '') c.fail(`${ep}.kind`, 'must be a non-empty string');
    // A duplicate kind would make the table's answer depend on row order.
    if (seen.has(event.kind as string)) c.fail(`${ep}.kind`, `duplicate kind "${String(event.kind)}"`);
    seen.add(event.kind as string);
    c.impact(event.impact, `${ep}.impact`);
    if (event.cases !== undefined) {
      c.array(event.cases, `${ep}.cases`).forEach((k, j) => {
        const kp = `${ep}.cases[${j}]`;
        const kase = c.object(k, kp);
        c.object(kase.when, `${kp}.when`);
        c.impact(kase.impact, `${kp}.impact`);
      });
    }
  });
  const windows = c.object(root.warnWindowsSec, 'warnWindowsSec');
  c.nonNegative(windows['1h'], 'warnWindowsSec.1h');
  c.nonNegative(windows['5m'], 'warnWindowsSec.5m');
  const timing = c.object(root.timing, 'timing');
  for (const key of ['skewSec', 'baseMarginSec', 'nativeTimeErrSec']) c.nonNegative(timing[key], `timing.${key}`);
  for (const key of ['staleSnapshotSec', 'heartbeatFreshSec']) c.positive(timing[key], `timing.${key}`);
  const priors = c.object(root.priors, 'priors');
  c.probability(priors.epsWithin, 'priors.epsWithin');
  c.probability(priors.epsAfter, 'priors.epsAfter');
  const may = c.object(priors.mayEvent, 'priors.mayEvent');
  c.positive(may.alpha, 'priors.mayEvent.alpha');
  c.positive(may.beta, 'priors.mayEvent.beta');
  c.positive(priors.minCalibrationN, 'priors.minCalibrationN');
  const display = c.object(root.display, 'display');
  c.probability(display.maxProb, 'display.maxProb');
  c.probability(display.minProb, 'display.minProb');
  if ((display.minProb as number) >= (display.maxProb as number)) c.fail('display', 'minProb must be below maxProb');
  return root as unknown as Rules;
}

/** Parses a string catalog such as `strings.en.json`. */
export function parseStrings(text: string): Strings {
  const c = new Checker('strings.en.json', parseJson('strings.en.json', text));
  const root = c.object(c.value, '');
  c.version(root);
  if (typeof root.locale !== 'string') c.fail('locale', 'must be a string');
  for (const [key, s] of Object.entries(c.object(root.strings, 'strings'))) {
    const entry = c.object(s, `strings.${key}`) as Partial<Record<keyof CatalogString, unknown>>;
    if (typeof entry.text !== 'string' || entry.text === '') c.fail(`strings.${key}.text`, 'must be a non-empty string');
    if (entry.tense !== 'future' && entry.tense !== 'past' && entry.tense !== 'none') {
      c.fail(`strings.${key}.tense`, 'must be "future", "past" or "none"');
    }
  }
  return root as unknown as Strings;
}

/**
 * Looks up a catalog string and fills its `{placeholders}`. A missing key or
 * placeholder is shown, not hidden, so a gap is visible in output and tests.
 *
 * @param strings the catalog
 * @param key the string's key, e.g. `segment.HOT`
 * @param params values for the placeholders
 */
export function formatString(
  strings: Strings,
  key: string,
  params: Readonly<Record<string, string | number>> = {},
): string {
  const entry = strings.strings[key];
  if (entry === undefined) return `[${key}]`;
  return entry.text.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = params[name];
    return value === undefined ? whole : String(value);
  });
}

/** Parses JSON, turning a syntax error into a {@link DataError}. */
function parseJson(file: string, text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    throw new DataError(file, '', `not valid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
}

/** Small assertion helpers that name the file and path of the first problem. */
class Checker {
  constructor(
    private readonly file: string,
    readonly value: unknown,
  ) {}

  /** Throws a {@link DataError} at `path`. */
  fail(path: string, problem: string): never {
    throw new DataError(this.file, path, problem);
  }

  /** Requires a plain object and returns it. */
  object(value: unknown, path: string): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) this.fail(path, 'must be an object');
    return value as Record<string, unknown>;
  }

  /** Requires an array and returns it. */
  array(value: unknown, path: string): readonly unknown[] {
    if (!Array.isArray(value)) this.fail(path, 'must be an array');
    return value;
  }

  /** Requires the file's `v` to be the version this core understands. */
  version(root: Record<string, unknown>): void {
    if (root.v !== DATA_VERSION) this.fail('v', `version ${String(root.v)} is not supported (expected ${DATA_VERSION})`);
  }

  /** Requires a finite number greater than 0. */
  positive(value: unknown, path: string): void {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) this.fail(path, 'must be a number above 0');
  }

  /** Requires a finite number of 0 or more. */
  nonNegative(value: unknown, path: string): void {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) this.fail(path, 'must be a number of 0 or more');
  }

  /** Requires a number strictly between 0 and 1. */
  probability(value: unknown, path: string): void {
    if (typeof value !== 'number' || !(value > 0 && value < 1)) this.fail(path, 'must be a number between 0 and 1');
  }

  /** Requires one of the three impacts. */
  impact(value: unknown, path: string): void {
    if (!IMPACTS.includes(value as Impact)) this.fail(path, 'must be "WILL", "MAY" or "NO_EFFECT"');
  }
}
