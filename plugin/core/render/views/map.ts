/** The prefix map (REQ-13.0.1, AC 13.1). */

import type { Prices } from '../../data/types';
import { summarize } from '../../history/summarize';
import type { Cause } from '../../history/summarize';
import type { EventRecord, RequestRecord } from '../../model/types';
import type { CheckRenderOptions } from '../check';
import { fit, formatClock, formatTokensShort } from '../format';
import { apportion, cells, fmt } from './cells';

/** The prefix's layers by size, from the context breakdown, when known. */
export interface Layers {
  readonly system: number;
  readonly project: number;
  readonly conversation: number;
}

/** How many recent main requests the prefix map draws. */
export const MAP_ROWS = 8;

/**
 * The prefix map (REQ-13.0.1): one bar per recent main request, patterned by
 * the tokens read from cache, written and uncached, in that order, which is
 * how a prefix is laid out: the cached part first. A rebuild row carries its
 * cause. When the context breakdown is known, a ruler above splits the bars
 * into system and tools, project context and conversation.
 *
 * @param requests the session's requests
 * @param events the session's events, for the causes
 * @param layers the prefix's layers, if known
 * @param width columns
 * @param o glyphs, catalog and time zone
 * @param prices the price table, which the cause attribution needs
 */
export function renderPrefixMap(
  requests: readonly RequestRecord[],
  events: readonly EventRecord[],
  layers: Layers | null,
  width: number,
  o: CheckRenderOptions,
  prices: Prices,
): string {
  const t = fmt(o);
  const c = cells(o);
  const main = requests.filter(r => r.lane === 'main').slice().sort((a, b) => a.tsStart - b.tsStart);
  if (main.length === 0) return fit(t('view.map.none'), width, o.glyphs.ellipsis);
  const shown = main.slice(-MAP_ROWS);
  const causes = new Map<number, Cause>();
  for (const row of summarize([{ sessionId: 'this', requests: main, events, skipped: 0 }], { from: -Infinity, to: Infinity }, { misses: true }, prices, 'firstParty').rows) {
    if (row.cause !== null) causes.set(row.ts, row.cause);
  }
  const LABEL = 15;
  const CAUSE = 13;
  const bar = Math.max(10, width - LABEL - CAUSE - 2);
  const largest = Math.max(...shown.map(r => r.usage.input + r.usage.read + r.usage.write5m + r.usage.write1h));
  const lines = [t('view.map.title', { n: shown.length })];
  if (layers !== null) {
    // A letter per layer, so the ruler reads without colour; a layer too small for a cell still gets one.
    const sizes = [layers.system, layers.project, layers.conversation];
    const n = apportion(sizes, bar - sizes.filter(x => x > 0).length).map((k, i) => (sizes[i]! > 0 ? k + 1 : 0));
    lines.push(' '.repeat(LABEL) + 's'.repeat(n[0]!) + 'p'.repeat(n[1]!) + 'c'.repeat(n[2]!));
    lines.push(
      ' '.repeat(LABEL) +
        t('view.map.layers', { system: formatTokensShort(layers.system), project: formatTokensShort(layers.project), conversation: formatTokensShort(layers.conversation) }),
    );
  }
  for (const r of shown) {
    const write = r.usage.write5m + r.usage.write1h;
    const total = r.usage.input + r.usage.read + write;
    // Bars share one scale, so a smaller prefix after /compact or /clear draws shorter.
    const len = largest > 0 ? Math.max(1, Math.round((total / largest) * bar)) : 1;
    const [nRead, nWritten, nUncached] = apportion([r.usage.read, write, r.usage.input], len);
    const drawn = c.read.repeat(nRead!) + c.written.repeat(nWritten!) + c.uncached.repeat(nUncached!);
    const cause = causes.get(r.tsStart);
    lines.push(`${formatClock(r.tsStart, o.tzOffsetMin, true)}  ${formatTokensShort(total).padStart(5)} ${drawn.padEnd(bar)} ${cause !== undefined ? t(`history.cause_short.${cause}`) : ''}`.trimEnd());
  }
  lines.push('', t('view.map.legend', { read: c.read, written: c.written, uncached: c.uncached }));
  return lines.map(l => fit(l, width, o.glyphs.ellipsis)).join('\n');
}

/** A context category as `$.session.usage` reports it. */
export interface ContextRow {
  readonly name: string;
  readonly tokens: number;
  readonly kind: string;
}

/** Whether a category stays the same turn to turn: the conversation alone grows. */
export function stable(name: string): boolean {
  return !/message|conversation/i.test(name);
}

/**
 * The layers a context breakdown puts in the prefix, for the prefix map:
 * the conversation, project context (memory files such as CLAUDE.md), and
 * everything else Claude Code sends first (system prompt, tools, agents).
 *
 * @param rows the breakdown's categories
 */
export function layersOf(rows: readonly ContextRow[]): Layers | null {
  let system = 0;
  let project = 0;
  let conversation = 0;
  for (const r of rows) {
    if (r.kind !== 'used') continue;
    if (!stable(r.name)) conversation += r.tokens;
    else if (/memory/i.test(r.name)) project += r.tokens;
    else system += r.tokens;
  }
  return system + project + conversation > 0 ? { system, project, conversation } : null;
}
