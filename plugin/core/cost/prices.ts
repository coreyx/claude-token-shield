/**
 * Price-table lookups and the user's override (REQ-3.0.5, 3.0.6; design D4).
 * Prices come only from the bundled table and the user's override file; the
 * core has no I/O, so it cannot fetch anything.
 */

import { DataError } from '../data/load';
import type { ModelPrice, PriceTable, Prices, ProviderPrice } from '../data/types';
import { baseModelId } from '../model/ids';

/**
 * The table in effect on a date: the newest whose `effective` day is on or
 * before it. A date before every table gets the oldest, so a cost is never
 * left unpriced only because a request predates the bundled history.
 *
 * @param prices all tables
 * @param at the request's time, epoch ms
 */
export function tableAt(prices: Prices, at: number): PriceTable {
  const day = new Date(at).toISOString().slice(0, 10);
  const sorted = [...prices.tables].sort((a, b) => a.effective.localeCompare(b.effective));
  let chosen = sorted[0]!;
  for (const t of sorted) if (t.effective <= day) chosen = t;
  return chosen;
}

/** A model's prices, matched on its base id; `undefined` when the table has none (costs are then unknown). */
export function modelPrice(table: PriceTable, model: string): ModelPrice | undefined {
  return table.models[baseModelId(model)];
}

/**
 * The user's override: rates for some models and providers, applied over every
 * bundled table (they describe the user's own contract, which doesn't change
 * with Anthropic's list price history).
 */
export interface PriceOverride {
  readonly models?: Readonly<Record<string, Partial<ModelPrice>>>;
  readonly providers?: Readonly<Record<string, Partial<ProviderPrice>>>;
}

/**
 * Merges the user's override (`prices.override.json`, already parsed) over the
 * bundled prices. A model the bundled table lacks may be added if the override
 * gives every required rate.
 *
 * @throws DataError when the override isn't an object of the documented shape
 */
export function mergeOverride(prices: Prices, override: unknown): Prices {
  const o = checkOverride(override);
  return {
    ...prices,
    tables: prices.tables.map(t => ({
      ...t,
      models: mergeEntries(t.models, o.models, isCompleteModel),
      providers: mergeEntries(t.providers, o.providers, p => typeof p.multiplier === 'number' && p.basis !== undefined),
    })),
  };
}

/** Overlays partial entries on a record; a new key is added only when `complete` accepts it. */
function mergeEntries<T>(
  base: Readonly<Record<string, T>>,
  over: Readonly<Record<string, Partial<T>>> | undefined,
  complete: (entry: Partial<T>) => boolean,
): Readonly<Record<string, T>> {
  if (over === undefined) return base;
  const out: Record<string, T> = { ...base };
  for (const [key, partial] of Object.entries(over)) {
    const existing = base[key];
    if (existing !== undefined) out[key] = { ...existing, ...partial };
    else if (complete(partial)) out[key] = partial as T;
  }
  return out;
}

/** Whether a partial model price has every required rate. */
function isCompleteModel(m: Partial<ModelPrice>): boolean {
  return [m.input, m.read_mult, m.write_5m_mult, m.write_1h_mult, m.output_mult].every(x => typeof x === 'number');
}

const MODEL_KEYS = new Set(['input', 'read_mult', 'write_5m_mult', 'write_1h_mult', 'output_mult', 'fast_input', 'tiers']);
const PROVIDER_KEYS = new Set(['multiplier', 'regional_multiplier', 'data_zone_multiplier', 'basis']);

/** Checks the override's shape; every rate must be a number above 0. */
function checkOverride(value: unknown): PriceOverride {
  const file = 'prices.override.json';
  if (!isObject(value)) throw new DataError(file, '', 'must be an object');
  for (const [section, keys] of [['models', MODEL_KEYS], ['providers', PROVIDER_KEYS]] as const) {
    const entries = value[section];
    if (entries === undefined) continue;
    if (!isObject(entries)) throw new DataError(file, section, 'must be an object');
    for (const [id, entry] of Object.entries(entries)) {
      if (!isObject(entry)) throw new DataError(file, `${section}.${id}`, 'must be an object');
      for (const [k, v] of Object.entries(entry)) {
        const path = `${section}.${id}.${k}`;
        if (!keys.has(k)) throw new DataError(file, path, 'is not a known field');
        if (k === 'basis') {
          if (v !== 'list' && v !== 'estimated') throw new DataError(file, path, 'must be "list" or "estimated"');
        } else if (k === 'tiers') {
          if (!Array.isArray(v) || !v.every(t => isObject(t) && positive(t.above) && positive(t.input))) {
            throw new DataError(file, path, 'must be a list of { above, input } with numbers above 0');
          }
        } else if (!positive(v)) {
          throw new DataError(file, path, 'must be a number above 0');
        }
      }
    }
  }
  return value as PriceOverride;
}

/** Whether a value is a plain object. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A finite number above 0. */
function positive(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}
