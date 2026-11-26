/** The history dashboard (REQ-13.0.5, AC 13.5). */

import { CAUSES } from '../../history/summarize';
import type { Cause, HistorySummary } from '../../history/summarize';
import type { CheckRenderOptions } from '../check';
import { fit, formatTokensLong, formatUsd } from '../format';
import { apportion, cells, fmt } from './cells';

/** One day's re-cache spend by cause. */
export interface DayCauses {
  /** The local date, `MM-DD`. */
  readonly day: string;
  readonly byCause: Readonly<Record<Cause, number>>;
  readonly total: number;
}

/** Each cause's letter in the stacked bars, so a bar reads without colour. */
const CAUSE_LETTER: Readonly<Record<Cause, string>> = {
  ttl_expiry: 'T',
  switch: 'S',
  tools: 'X',
  compaction: 'C',
  server_side: 'V',
  unexplained: '?',
};

/**
 * Re-cache spend per local day and cause, from a summary's rows; the days
 * sum to the summary's priced re-cache spend (AC 13.5).
 *
 * @param s the summary
 * @param tzOffsetMin minutes east of UTC
 */
export function dailyByCause(s: HistorySummary, tzOffsetMin: number): DayCauses[] {
  const days = new Map<string, Record<Cause, number>>();
  for (const r of s.rows) {
    if (r.cause === null || r.recacheUsd === null) continue;
    const d = new Date(r.ts + tzOffsetMin * 60_000);
    const day = `${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
    const row = days.get(day) ?? (Object.fromEntries(CAUSES.map(c => [c, 0])) as Record<Cause, number>);
    row[r.cause] += r.recacheUsd;
    days.set(day, row);
  }
  return [...days].map(([day, byCause]) => ({ day, byCause, total: CAUSES.reduce((sum, c) => sum + byCause[c], 0) }));
}

/** Idle-gap buckets for the histogram, upper bounds in seconds. */
const GAP_BUCKETS: readonly (readonly [string, number])[] = [
  ['< 1 min', 60],
  ['1-5 min', 300],
  ['5-15 min', 900],
  ['15-30 min', 1800],
  ['30-60 min', 3600],
  ['1-2 h', 7200],
  ['> 2 h', Infinity],
];

/**
 * The history dashboard (REQ-13.0.5): re-cache spend by cause per day as
 * stacked bars (one letter per cause, the days summing to the total), the
 * idle gaps between main requests against the TTL, the advice line, and the
 * reliability table and TTL advisor as their own views render them.
 *
 * @param s the summary, with every row (not only misses)
 * @param extra the advice line and the calibration and TTL advisor texts
 * @param width columns
 * @param o glyphs, catalog and time zone
 */
export function renderDashboard(
  s: HistorySummary,
  extra: { readonly advice: string | null; readonly calibration: string | null; readonly ttl: string | null },
  width: number,
  o: CheckRenderOptions,
): string {
  const t = fmt(o);
  const lines = [t('view.history.title')];
  const days = dailyByCause(s, o.tzOffsetMin);
  if (days.length === 0) lines.push(t('view.history.none'));
  else {
    const bar = Math.max(10, width - 20);
    const top = Math.max(...days.map(d => d.total));
    for (const d of days) {
      const len = top > 0 ? Math.max(1, Math.round((d.total / top) * bar)) : 1;
      const parts = apportion(CAUSES.map(c => d.byCause[c]), len);
      const drawn = CAUSES.map((c, i) => CAUSE_LETTER[c].repeat(parts[i]!)).join('');
      lines.push(`${d.day}  ${drawn.padEnd(bar)} ${formatUsd(d.total).padStart(8)}`);
    }
    // Wrapped between causes rather than cut, so every cause stays named at 80 columns.
    let legend = t('view.history.legend', { legend: '' }).trimEnd();
    for (const [i, c] of CAUSES.entries()) {
      const item = `${CAUSE_LETTER[c]} ${t(`history.cause_short.${c}`)}`;
      const sep = i === 0 ? ' ' : ` ${o.glyphs.dot} `;
      if (legend.length + sep.length + item.length > width) {
        lines.push(legend);
        legend = `  ${item}`;
      } else legend += sep + item;
    }
    lines.push(legend);
    lines.push(t('history.recache', { usd: formatUsd(s.recacheUsd), count: s.recaches, tokens: formatTokensLong(s.recacheTokens) }));
  }

  const ttls = s.rows.map(r => r.ttl).filter((x): x is NonNullable<typeof x> => x !== null);
  const ttlSec = ttls.length > 0 && ttls.filter(x => x === '1h').length >= ttls.length / 2 ? 3600 : 300;
  const counts = GAP_BUCKETS.map(([, max], i) => s.rows.filter(r => r.gapSec <= max && r.gapSec > (i === 0 ? -Infinity : GAP_BUCKETS[i - 1]![1])).length);
  if (s.rows.length > 0) {
    lines.push('', t('view.history.gaps'));
    const most = Math.max(...counts, 1);
    const bar = Math.max(10, width - 22);
    GAP_BUCKETS.forEach(([label, max], i) => {
      lines.push(`${label.padEnd(11)}${cells(o).read.repeat(Math.round((counts[i]! / most) * bar)).padEnd(bar)} ${String(counts[i]).padStart(4)}`);
      // The TTL line falls after the bucket that ends at it.
      if (max === ttlSec) lines.push(t('view.history.ttl_line', { ttl: ttlSec === 3600 ? '1h' : '5m' }));
    });
  }
  for (const block of [extra.advice, extra.calibration, extra.ttl]) if (block !== null) lines.push('', ...block.split('\n'));
  return lines.map(l => fit(l, width, o.glyphs.ellipsis)).join('\n');
}
