/**
 * The status segment (REQ-8): one line with the state, the prefix size, and
 * either the expiry time (warm) or the cause and rebuild cost (not warm).
 * Rendered from the string catalog only, in either glyph set.
 */

import type { Assessment } from '../assess/types';
import { assessmentProbability } from '../assess/format';
import type { BillingMode, NextTurnCost } from '../cost/cost';
import { presentCost } from '../cost/cost';
import type { PlanShare } from '../cost/planshare';
import { formatString } from '../data/load';
import type { Rules, Strings } from '../data/types';
import { formatClock, formatTokensShort, formatUsd, glyphParams } from './format';
import type { GlyphSet } from './format';

/** What rendering needs besides the assessment and cost. */
export interface RenderOptions {
  readonly glyphs: GlyphSet;
  readonly strings: Strings;
  readonly display: Rules['display'];
  /** Minutes east of UTC for wall-clock times. */
  readonly tzOffsetMin: number;
  readonly billing: BillingMode;
}

/**
 * Renders the status segment.
 *
 * @param a the assessment
 * @param cost the next turn's cost (with its plan share, if any), or `null` when unknown
 * @param o glyphs, catalog, display caps, time zone and billing mode
 */
export function renderSegment(
  a: Assessment,
  cost: (NextTurnCost & { readonly planShare?: { readonly cold: PlanShare } }) | null,
  o: RenderOptions,
): string {
  const t = (key: string, params: Record<string, string | number> = {}): string =>
    formatString(o.strings, key, { ...glyphParams(o.glyphs), ...params });
  const tokens = a.prefixTokens.tier !== 'absent' ? formatTokensShort(a.prefixTokens.value) : t('check.unknown_value');
  const time = a.expiresAt.tier !== 'absent' ? formatClock(a.expiresAt.value, o.tzOffsetMin) : undefined;
  // EXPIRING quotes what waiting would cost (the penalty); not-warm states quote the full rebuild.
  const costText = rebuildCost(cost, o, a.state === 'EXPIRING' ? 'penalty' : 'cold');
  const prob = assessmentProbability(a, o.display, o.strings, o.glyphs) ?? '';
  const cause = a.cause !== undefined ? t(`event.${a.cause.kind}`) : '';
  const reason = uncertainReason(a, t);
  const unknown = unknownText(a, t);

  if (o.glyphs.name === 'ascii') {
    const parts: string[] = [];
    if (a.state !== 'UNKNOWN') parts.push(tokens);
    if (a.state === 'HOT' || a.state === 'EXPIRING') if (time !== undefined) parts.push(`->${time}`);
    if (a.state === 'UNCERTAIN') parts.push(prob);
    if (a.state === 'INVALIDATED') parts.push(cause.replaceAll(' ', '-'));
    if ((a.state === 'EXPIRING' || a.state === 'INVALIDATED' || a.state === 'COLD') && costText !== null) parts.push(`~${costText}`);
    if (a.state === 'UNKNOWN') parts.push(unknown);
    if (a.stale) parts.push('stale');
    return t('segment.ascii', { state: a.state, parts: parts.map(p => ` ${p}`).join('') });
  }

  const glyph = o.glyphs.state[a.state];
  let line: string;
  switch (a.state) {
    case 'HOT':
      line = time !== undefined ? t('segment.HOT', { glyph, tokens, time }) : t('segment.HOT.notime', { glyph, tokens });
      break;
    case 'EXPIRING':
      line = t('segment.EXPIRING', { glyph, tokens, time: time ?? t('check.unknown_value') });
      if (costText !== null) line += t('segment.EXPIRING.cost', { cost: costText });
      break;
    case 'UNCERTAIN':
      line = t('segment.UNCERTAIN', { glyph, reason, prob });
      break;
    case 'INVALIDATED':
      line = t('segment.INVALIDATED', { glyph, cause, tokens });
      if (costText !== null) line += t('segment.cost', { cost: costText });
      break;
    case 'COLD':
      line = time !== undefined ? t('segment.COLD', { glyph, tokens, time }) : t('segment.COLD.notime', { glyph, tokens });
      if (costText !== null) line += t('segment.cost', { cost: costText });
      break;
    case 'UNKNOWN':
      line = t('segment.UNKNOWN', { glyph, reason: unknown });
      break;
  }
  return a.stale ? line + t('segment.stale') : line;
}

/**
 * The rebuild cost as the billing mode shows it: dollars where shown, else the
 * plan share once learned, else nothing (tokens are already in the segment).
 */
function rebuildCost(
  cost: (NextTurnCost & { readonly planShare?: { readonly cold: PlanShare } }) | null,
  o: RenderOptions,
  which: 'cold' | 'penalty',
): string | null {
  if (cost === null) return null;
  if (presentCost(o.billing, false).dollars && cost.usd !== null) return formatUsd(cost.usd[which]);
  const share = cost.planShare?.cold;
  if (share !== undefined && share.status === 'estimated') {
    return formatString(o.strings, 'cost.plan_share_short', { pct: Math.max(1, Math.round(share.pct)) });
  }
  return null;
}

/** Why the state is uncertain, in a few words. */
export function uncertainReason(a: Assessment, t: (key: string, params?: Record<string, string | number>) => string): string {
  const may = a.pending.find(p => p.impact === 'MAY');
  if (may !== undefined) return t('segment.reason.event', { event: t(`event.${may.event.kind}`) });
  if (a.remainingSec !== null && Math.abs(a.remainingSec) <= a.marginSec) return t('segment.reason.boundary');
  return a.stale ? t('segment.reason.stale') : t('segment.reason.boundary');
}

/** What an `UNKNOWN` state is missing, in words. */
export function unknownText(a: Assessment, t: (key: string, params?: Record<string, string | number>) => string): string {
  if (a.unknownReason === 'version') {
    const v = a.drivers.find(d => d.key === 'driver.version');
    return t('unknown.version', { version: String(v?.params.min ?? '') });
  }
  return t(a.unknownReason === 'caching_off' ? 'unknown.caching_off' : 'unknown.no_response');
}
