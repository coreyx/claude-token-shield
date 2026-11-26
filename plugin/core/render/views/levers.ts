/** The lever comparator's table (REQ-13.0.3, AC 13.3, 17.5). */

import type { LeverQuote } from '../../recommend/levers';
import type { Recommendation } from '../../recommend/recommend';
import type { CheckRenderOptions } from '../check';
import { fit, formatUsd } from '../format';
import { fmt, wrap } from './cells';

/**
 * The lever comparator's table (REQ-13.0.3, AC 17.5): each lever's cost now,
 * its effect on later turns, how sure the figure is, and the one recommended,
 * marked. The pane draws a button beside each command lever.
 *
 * @param quotes the levers, priced
 * @param rec the recommendation
 * @param width columns
 * @param o glyphs, catalog and time zone
 */
export function renderLevers(quotes: readonly LeverQuote[], rec: Recommendation, width: number, o: CheckRenderOptions): string {
  const t = fmt(o);
  const names = quotes.map(q => t(`lever.${q.lever}.name`));
  const NAME = Math.max(12, ...names.map(n => n.length + 1));
  const header = `  ${t('view.levers.col.lever').padEnd(NAME)}${t('view.levers.col.cost').padStart(9)}  ${t('view.levers.col.effect')}`;
  const lines = [t('view.levers.title'), header];
  // The effect column takes what the width leaves after lever, cost and certainty; longer text wraps.
  const LEAD = 2 + NAME + 9 + 2;
  const effectWidth = Math.max(20, width - LEAD - 13);
  quotes.forEach((q, i) => {
    const mark = q.lever === rec.lever ? o.glyphs.pick : ' ';
    const now = q.now.usd !== null ? formatUsd(q.now.usd) : '?';
    const [first = '', ...rest] = wrap(t(q.effectKey), effectWidth);
    lines.push(`${mark} ${names[i]!.padEnd(NAME)}${now.padStart(9)}  ${first.padEnd(effectWidth)} [${q.tier}]`);
    for (const more of rest) lines.push(' '.repeat(LEAD) + more);
  });
  if (rec.lever === 'none') lines.push(t('view.levers.none'));
  lines.push('', t('view.levers.legend', { pick: o.glyphs.pick }));
  return lines.map(l => fit(l, width, o.glyphs.ellipsis)).join('\n');
}
