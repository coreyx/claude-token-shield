/** The expiry runway (REQ-13.0.2, AC 13.2). */

import type { Assessment } from '../../assess/types';
import type { NextTurnCost } from '../../cost/cost';
import type { CheckRenderOptions } from '../check';
import { fit, formatClock, formatUsd } from '../format';
import { fmt } from './cells';

/**
 * The expiry runway (REQ-13.0.2): a time axis from one TTL before the expiry
 * to just past its margin, with now, the warn window, the expiry and its
 * margin, and below it what acting before and after the expiry costs.
 *
 * @param a the assessment
 * @param cost the next turn's cost, if priced
 * @param width columns
 * @param o glyphs, catalog and time zone
 */
export function renderRunway(a: Assessment, cost: NextTurnCost | null, width: number, o: CheckRenderOptions): string {
  const t = fmt(o);
  const clock = (ms: number) => formatClock(ms, o.tzOffsetMin);
  // An UNKNOWN cache has no timeline worth drawing, whatever expiry is on record.
  if (a.state === 'UNKNOWN' || a.expiresAt.tier === 'absent' || a.ttl.tier === 'absent') return fit(t('view.runway.unknown'), width, o.glyphs.ellipsis);
  const expiry = a.expiresAt.value;
  const ttlMs = a.ttl.value === '1h' ? 3_600_000 : 300_000;
  const marginMs = a.marginSec * 1000;
  const start = Math.min(expiry - ttlMs, a.at);
  const end = Math.max(expiry + marginMs * 2, a.at + marginMs);
  const w = Math.max(20, width - 2);
  const x = (ms: number) => Math.min(w - 1, Math.max(0, Math.round(((ms - start) / (end - start)) * (w - 1))));
  const ascii = o.glyphs.ellipsis !== '…';
  const axis: string[] = Array.from({ length: w }, () => (ascii ? '-' : '─'));
  for (let i = x(expiry - a.warnWindowSec * 1000); i <= x(expiry); i++) axis[i] = '=';
  for (let i = x(expiry - marginMs); i <= x(expiry + marginMs); i++) axis[i] = '~';
  axis[x(expiry)] = '|';
  const nowAt = x(a.at);
  const marker = `${ascii ? '^' : '▲'}${t('view.runway.now')}`;
  const nowLine = ' '.repeat(Math.max(0, Math.min(nowAt, w - marker.length))) + marker;
  const startLabel = clock(start);
  const expiryLabel = clock(expiry);
  const labels = [...startLabel.padEnd(w)];
  const at = Math.max(startLabel.length + 1, Math.min(x(expiry) - Math.floor(expiryLabel.length / 2), w - expiryLabel.length));
  labels.splice(at, expiryLabel.length, ...expiryLabel);
  const lines = [
    t('view.runway.title', { state: a.state }),
    ` ${axis.join('')}`,
    ` ${nowLine}`,
    ` ${labels.join('').trimEnd()}`,
    t('view.runway.legend', { margin: Math.round(a.marginSec) }),
  ];
  if (cost?.usd !== null && cost?.usd !== undefined) {
    lines.push(t('view.runway.costs', { time: expiryLabel, before: formatUsd(cost.usd.warm), after: formatUsd(cost.usd.cold) }));
  }
  return lines.map(l => fit(l, width, o.glyphs.ellipsis)).join('\n');
}
