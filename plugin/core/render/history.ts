/**
 * The history summary as text (AC 6.5, 14.1, 14.2): totals, spend by cause,
 * the avoidable share and the per-turn rows, from the string catalog only,
 * so `/cache-check history` and `tshield history` print the same lines.
 */

import { formatString } from '../data/load';
import type { AdviceReport } from '../history/advice';
import type { Calibration } from '../history/calibrate';
import { MIN_GAPS, MIN_SESSIONS } from '../history/ttl';
import type { TtlAdvice } from '../history/ttl';
import { CAUSES } from '../history/summarize';
import type { HistorySummary } from '../history/summarize';
import type { CheckRenderOptions } from './check';
import { fit, formatPercent, formatStamp, formatTokensLong, formatUsd, glyphParams } from './format';

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
 * @param advice the advice report for the same sessions, when there is one
 */
export function renderHistory(s: HistorySummary, width: number, o: CheckRenderOptions, advice: AdviceReport | null = null): string {
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
    if (advice !== null) {
      lines.push(
        advice.share !== null
          ? t('history.advice', { cheapest: advice.cheapest, n: advice.evaluated, share: formatPercent(advice.share, 0) })
          : t('history.advice_none', { unevaluated: advice.unevaluated }),
      );
    }

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

/**
 * Renders calibration (REQ-14.0.5): the reliability table by state, TTL and
 * remaining-time band with each bucket's Wilson interval, the Brier score
 * overall and per version × model × TTL, and drift or how far the priors
 * still stand.
 *
 * @param c the calibration
 * @param minCalibrationN the HOT predictions needed to leave the priors
 * @param width terminal columns; lines are fitted to it
 * @param o glyphs, catalog and time zone
 */
export function renderCalibration(c: Calibration, minCalibrationN: number, width: number, o: CheckRenderOptions): string {
  const t = (key: string, params: Record<string, string | number> = {}): string =>
    formatString(o.strings, key, { ...glyphParams(o.glyphs), ...params });
  if (c.n === 0) return fit(t('calibration.none'), width, o.glyphs.ellipsis);
  const lines = [t('calibration.title', { n: c.n, brier: (c.brier ?? 0).toFixed(4) }), '', t('calibration.header')];
  for (const b of c.buckets) {
    lines.push(
      b.state.padEnd(13) +
        (b.ttl ?? '-').padEnd(5) +
        t(`calibration.band.${b.band}`).padEnd(12) +
        String(b.n).padStart(3) +
        formatPercent(b.meanPredicted).padStart(11) +
        formatPercent(b.observed).padStart(10) +
        `  ${formatPercent(b.wilson[0])}${o.glyphs.dash}${formatPercent(b.wilson[1])}`,
    );
  }
  lines.push('', t('calibration.brier_title'));
  for (const g of c.brierBy) {
    lines.push(`  ${(g.ccVersion ?? '-').padEnd(10)}${(g.model ?? '-').padEnd(21)}${(g.ttl ?? '-').padEnd(5)}n ${String(g.n).padEnd(6)}${g.brier.toFixed(4)}`);
  }
  if (c.drift) {
    lines.push('', t('calibration.drift', { observed: formatPercent(c.hot.missRate ?? 0), stated: formatPercent(c.hot.statedUpper ?? 0) }));
  } else if (c.hot.n < minCalibrationN) {
    lines.push('', t('calibration.priors', { n: c.hot.n, min: minCalibrationN }));
  }
  return lines.map(l => fit(l, width, o.glyphs.ellipsis)).join('\n');
}

/**
 * Renders the TTL advisor (REQ-16): for the main conversation and subagents,
 * the idle gaps by length and both TTLs' costs with the cheaper one, or how
 * far the history is from enough; then the billing explanation (REQ-16.0.3).
 *
 * @param advice the advice
 * @param width terminal columns; lines are fitted to it
 * @param o glyphs, catalog and time zone
 */
export function renderTtlAdvice(advice: TtlAdvice, width: number, o: CheckRenderOptions): string {
  const t = (key: string, params: Record<string, string | number> = {}): string =>
    formatString(o.strings, key, { ...glyphParams(o.glyphs), ...params });
  const stamp = (ms: number) => formatStamp(ms, o.tzOffsetMin);
  const lines = [t('ttl.title', { from: stamp(advice.range.from), to: stamp(advice.range.to) })];
  for (const name of ['main', 'subagent'] as const) {
    const b = advice[name];
    lines.push(
      '',
      t('ttl.gaps', { label: t(`ttl.bucket.${name}`), sessions: b.sessions, gaps: b.gapCount }),
      t('ttl.gap_lengths', { a: b.gaps.under5m, b: b.gaps.under1h, c: b.gaps.over1h }),
    );
    if (b.recommended !== null) {
      lines.push(
        t('ttl.costs', {
          cost5m: formatUsd(b.cost5mUsd!),
          cost1h: formatUsd(b.cost1hUsd!),
          ttl: t(`ttl.name.${b.recommended}`),
          savings: formatUsd(b.savingsUsd!),
        }),
      );
    } else if (b.sessions >= MIN_SESSIONS && b.gapCount >= MIN_GAPS) {
      lines.push(t('ttl.unpriced'));
    } else {
      lines.push(t('ttl.not_enough', { sessions: b.sessions, minSessions: MIN_SESSIONS, gaps: b.gapCount, minGaps: MIN_GAPS }));
    }
  }
  lines.push('', t('ttl.billing'), t('ttl.billing_credits'), t('ttl.billing_api'));
  return lines.map(l => fit(l, width, o.glyphs.ellipsis)).join('\n');
}
