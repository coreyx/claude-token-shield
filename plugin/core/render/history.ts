/**
 * The history summary as text (AC 6.5, 14.1, 14.2): totals, spend by cause,
 * the avoidable share and the per-turn rows, from the string catalog only,
 * so `/cache-check history` and `tshield history` print the same lines.
 */

import { formatString } from '../data/load';
import { CAUSES } from '../history/summarize';
import type { HistorySummary } from '../history/summarize';
import type { CheckRenderOptions } from './check';
import { fit, formatStamp, formatTokensLong, formatUsd, glyphParams } from './format';

/** The most recent rows shown; older ones are counted instead. */
export const MAX_ROWS = 30;

/** Width of the cause labels in the by-cause lines. */
const CAUSE_LABEL = 32;

/**
 * Renders a history summary at a width.
 *
 * @param s the summary
 * @param width terminal columns; lines are fitted to it
 * @param o glyphs, catalog and time zone
 */
export function renderHistory(s: HistorySummary, width: number, o: CheckRenderOptions): string {
  const t = (key: string, params: Record<string, string | number> = {}): string =>
    formatString(o.strings, key, { ...glyphParams(o.glyphs), ...params });
  const stamp = (ms: number) => formatStamp(ms, o.tzOffsetMin);
  const lines: string[] = [t('history.title', { from: stamp(s.range.from), to: stamp(s.range.to), sessions: s.sessions, requests: s.requests })];

  if (s.requests === 0) {
    lines.push(t('history.none'));
  } else {
    lines.push(t('history.recache', { usd: formatUsd(s.recacheUsd), count: s.recaches, tokens: formatTokensLong(s.recacheTokens) }));
    for (const c of CAUSES) {
      const total = s.byCause[c];
      if (total.count === 0) continue;
      lines.push(t('history.cause_row', { cause: t(`history.cause.${c}`).padEnd(CAUSE_LABEL), usd: formatUsd(total.usd), count: total.count }));
    }
    lines.push(t('history.avoidable', { usd: formatUsd(s.avoidableUsd), count: s.avoidableCount }));
    if (s.unpriced > 0) lines.push(t('history.unpriced', { count: s.unpriced }));

    if (s.rows.length > 0) {
      lines.push('', t('history.rows_header'));
      const shown = s.rows.slice(-MAX_ROWS);
      if (s.rows.length > shown.length) lines.push(t('history.earlier', { count: s.rows.length - shown.length }));
      for (const r of shown) {
        const cells = [
          stamp(r.ts).padEnd(13),
          r.session.slice(0, 8).padEnd(10),
          r.model.padEnd(21),
          t(`history.outcome.${r.outcome}`).padEnd(9),
          (r.cause !== null ? t(`history.cause_short.${r.cause}`) : '').padEnd(14),
          formatTokensLong(r.recacheTokens).padStart(7),
          (r.recacheUsd !== null ? formatUsd(r.recacheUsd) : '?').padStart(10),
        ];
        lines.push(cells.join('') + (r.avoidable ? `  ${t('history.avoidable_mark')}` : ''));
      }
    }
  }
  if (s.skippedChunks > 0) lines.push('', t('history.skipped', { count: s.skippedChunks }));
  return lines.map(l => fit(l, width, o.glyphs.ellipsis)).join('\n');
}
