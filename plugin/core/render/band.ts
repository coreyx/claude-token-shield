/**
 * The above-prompt band and the notification toasts as text (REQ-9, design
 * D13), from the string catalog only.
 */

import { formatString } from '../data/load';
import type { Notification } from '../notify/notify';
import type { CheckView } from '../view/view';
import { recommendationText } from './check';
import type { CheckRenderOptions } from './check';
import { formatClock, formatTokensLong, formatUsd, glyphParams } from './format';

/** The states that show the band (REQ-9.0.3); it is hidden in all others. */
const BAND_STATES = new Set(['EXPIRING', 'COLD', 'INVALIDATED']);

/**
 * The band's text for a check view: the state, the cost and the recommended
 * lever, labelled Token Shield; `null` when the state shows no band.
 *
 * @param view the check view
 * @param o glyphs, catalog, display caps and time zone
 */
export function bandText(view: CheckView, o: CheckRenderOptions): string | null {
  if (!BAND_STATES.has(view.state)) return null;
  const t = (key: string, params: Record<string, string | number> = {}): string =>
    formatString(o.strings, key, { ...glyphParams(o.glyphs), ...params });
  const clock = (ms: number) => formatClock(ms, o.tzOffsetMin);
  const c = view.cost;
  const usd = c === null ? null : view.state === 'EXPIRING' ? (c.coldUsd !== null && c.warmUsd !== null ? c.coldUsd - c.warmUsd : null) : c.coldUsd;
  const cost = c !== null && c.showDollars && usd !== null ? t('band.cost', { cost: formatUsd(usd) }) : '';
  const tokens = c !== null ? formatTokensLong(c.tokens) : view.prefixTokens.value !== null ? formatTokensLong(view.prefixTokens.value) : t('check.unknown_value');
  const pendingCause = view.pending.find(p => p.impact === 'WILL')?.kind;
  const text = t(`band.${view.state}`, {
    time: view.expiresAt.value !== null ? clock(view.expiresAt.value) : t('check.unknown_value'),
    tokens,
    cost,
    cause: pendingCause !== undefined ? t(`event.${pendingCause}`) : t('check.unknown_value'),
  });
  return text + t('band.advice', { text: recommendationText(view, t, clock) });
}

/**
 * A toast's text: the notification's catalog string with its parameters in
 * words (a time as the clock reads, a cause as its name).
 *
 * @param n the notification
 * @param o glyphs, catalog and time zone
 */
export function notificationText(n: Notification, o: CheckRenderOptions): string {
  const params: Record<string, string | number> = { ...glyphParams(o.glyphs), ...n.params };
  if (typeof n.params.expiresAt === 'number') params.time = formatClock(n.params.expiresAt, o.tzOffsetMin);
  if (typeof n.params.cause === 'string') params.cause = formatString(o.strings, `event.${n.params.cause}`);
  return formatString(o.strings, n.key, params);
}
