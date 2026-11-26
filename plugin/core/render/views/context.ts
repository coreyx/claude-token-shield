/** The context composition view (REQ-13.0.4). */

import type { CheckRenderOptions } from '../check';
import { fit, formatTokensShort } from '../format';
import { cells, fmt } from './cells';
import { stable } from './map';
import type { ContextRow } from './map';

/**
 * The context composition (REQ-13.0.4): what makes up the prefix by
 * category, as bars, each marked stable or changing each turn.
 *
 * @param rows the breakdown's categories
 * @param width columns
 * @param o glyphs, catalog and time zone
 */
export function renderContext(rows: readonly ContextRow[], width: number, o: CheckRenderOptions): string {
  const t = fmt(o);
  const used = rows.filter(r => r.kind === 'used' && r.tokens > 0);
  if (used.length === 0) return fit(t('view.context.none'), width, o.glyphs.ellipsis);
  const total = used.reduce((s, r) => s + r.tokens, 0);
  const NAME = 22;
  const TAIL = 28;
  const bar = Math.max(10, width - NAME - TAIL);
  const lines = [t('view.context.title', { tokens: formatTokensShort(total) })];
  for (const r of used) {
    const n = Math.max(1, Math.round((r.tokens / total) * bar));
    const mark = stable(r.name) ? t('view.context.stable') : t('view.context.changing');
    lines.push(`${fit(r.name, NAME - 1, o.glyphs.ellipsis).padEnd(NAME)}${cells(o).read.repeat(n).padEnd(bar)} ${formatTokensShort(r.tokens).padStart(5)}  ${mark}`);
  }
  return lines.map(l => fit(l, width, o.glyphs.ellipsis)).join('\n');
}
