/**
 * Renders the check view as text (REQ-6): the default view, the verbose view
 * with the timeline, both expiry values and a tier tag on every figure, and
 * the diff view. Reads only the string catalog, so the Go port and every
 * surface word things identically.
 */

import { formatProbability } from '../assess/format';
import { formatString } from '../data/load';
import type { Rules, Strings } from '../data/types';
import type { Tier } from '../model/types';
import { HORIZON_TURNS } from '../recommend/levers';
import type { CheckView } from '../view/view';
import { fit, formatClock, formatDuration, formatPercent, formatTokensLong, formatUsd, glyphParams } from './format';
import type { GlyphSet } from './format';

/** What rendering the check needs besides the view. */
export interface CheckRenderOptions {
  readonly glyphs: GlyphSet;
  readonly strings: Strings;
  readonly display: Rules['display'];
  /** Minutes east of UTC for wall-clock times. */
  readonly tzOffsetMin: number;
}

/** Width of the label column. */
const LABEL = 15;

/**
 * Renders a check view at a width.
 *
 * @param view the view model
 * @param width terminal columns; lines are fitted to it
 * @param o glyphs, catalog, display caps and time zone
 */
export function renderCheck(view: CheckView, width: number, o: CheckRenderOptions): string {
  const g = o.glyphs;
  const t = (key: string, params: Record<string, string | number> = {}): string =>
    formatString(o.strings, key, { ...glyphParams(g), ...params });
  const verbose = view.mode === 'verbose';
  const clock = (ms: number, seconds = false) => formatClock(ms, o.tzOffsetMin, seconds);
  const tag = (tier: Tier | 'absent'): string => (verbose ? t(tier === 'absent' ? 'tier.inferred' : `tier.${tier}`) : '');
  const usd = (x: number | null): string => (x === null ? t('cost.unknown') : formatUsd(x));
  const lines: string[] = [];

  /**
   * A row: labelled, indented under the label column (`''`), or at the margin
   * (`null`), with the tier tag right-aligned in verbose output.
   */
  const row = (label: string | null, value: string, tier?: Tier | 'absent'): void => {
    const left =
      label === null ? value : label === '' ? ' '.repeat(LABEL) + value : (label.length >= LABEL ? `${label} ` : label.padEnd(LABEL)) + value;
    const tg = tier === undefined ? '' : tag(tier);
    if (tg === '') {
      lines.push(fit(left, width, g.ellipsis));
      return;
    }
    const room = width - tg.length - 1;
    lines.push(left.length <= room ? left.padEnd(width - tg.length) + tg : `${fit(left, room, g.ellipsis)} ${tg}`);
  };

  // Header.
  if (view.state === 'UNKNOWN') {
    lines.push(fit(t('check.header_unknown', { reason: unknownReason(view, t) }), width, g.ellipsis));
    lines.push(g.rule.repeat(width));
    if (view.lastRequest !== null) row(t('check.label.last_request'), t('check.last_request', lastRequestParams(view, clock)), view.lastRequest.tier);
    lines.push('');
    row(null, t('check.recommend', { text: recommendationText(view, t, clock) }));
    return lines.map(l => l.trimEnd()).join('\n');
  }
  const prob = formatProbability(view.pHit, o.display, o.strings, g) ?? '';
  const interval = view.interval !== null ? ` (${formatPercent(view.interval[0])}${g.dash}${formatPercent(view.interval[1])})` : '';
  lines.push(
    fit(t('check.header', { state: view.state, prob: t('prob.read', { prob: prob + interval }), confidence: t(`confidence.${view.confidence}`) }), width, g.ellipsis),
  );
  lines.push(g.rule.repeat(width));
  if (view.stale) row('', t('check.stale', { seconds: view.drivers.find(d => d.key === 'driver.stale')?.params.seconds ?? t('check.unknown_value') }));

  if (view.mode === 'diff') {
    renderDiff(view, t, row);
    return lines.map(l => l.trimEnd()).join('\n');
  }

  // Core rows.
  row(
    t('check.label.last_request'),
    view.lastRequest !== null ? t('check.last_request', lastRequestParams(view, clock)) : t('check.last_request_none'),
    view.lastRequest?.tier ?? 'absent',
  );
  const ttl = view.ttl.value !== null ? ttlWords(view.ttl.value) : t('check.ttl_unknown');
  const expiry = view.expiresAt.value;
  const ttlKey = expiry === null ? 'check.ttl_no_expiry' : expiry > view.at ? 'check.ttl' : 'check.ttl_expired';
  row(t('check.label.ttl'), t(ttlKey, { ttl, time: expiry !== null ? clock(expiry) : '' }), view.expiresAt.tier);
  if (verbose) {
    const at = (ms: number | null) => (ms === null ? t('check.unknown_value') : clock(ms, true));
    row(t('check.label.expiry'), t('check.expiry', { native: at(view.expiry.native), shield: at(view.expiry.shield), drift: view.expiry.driftSec === null ? '0s' : `${view.expiry.driftSec}s` }), 'inferred');
  }
  row(
    t('check.label.prefix'),
    view.prefixTokens.value !== null ? t('check.prefix', { tokens: formatTokensLong(view.prefixTokens.value) }) : t('check.unknown_value'),
    view.prefixTokens.tier,
  );
  const s = view.session;
  row(
    t('check.label.session'),
    s.requests !== null
      ? t('check.session', { requests: s.requests, ratio: s.hitRatio !== null ? formatPercent(s.hitRatio) : t('check.unknown_value'), misses: s.misses ?? 0 })
      : t('check.session_unknown'),
    'measured',
  );
  if (s.lastMiss !== null) {
    row('', t('check.last_miss', { time: s.lastMiss.at !== null ? clock(s.lastMiss.at) : t('check.unknown_value'), causes: causeNames(s.lastMiss.causes, o.strings, t) }), 'inferred');
  }
  if (view.pending.length === 0) row(t('check.label.pending'), t('check.pending_none'), 'measured');
  view.pending.forEach((p, i) => row(i === 0 ? t('check.label.pending') : '', t('check.pending_event', { event: t(`event.${p.kind}`), impact: p.impact }), 'inferred'));

  // Next turn.
  const c = view.cost;
  if (c !== null) {
    if (c.showDollars && c.coldUsd !== null) {
      row(t('check.label.next_turn'), t('check.next_turn_usd', { warm: usd(c.warmUsd), cold: usd(c.coldUsd) }), 'estimated');
      row('', t(c.dollarLabel, { date: c.priceDate }), 'measured');
    } else {
      row(t('check.label.next_turn'), t(c.coldUsd === null && c.showDollars ? 'check.next_turn_unknown' : 'check.next_turn_tokens', { tokens: formatTokensLong(c.tokens) }), 'inferred');
    }
    if (c.planShare !== null) {
      const share = (p: typeof c.planShare.cold) => (p.status === 'estimated' ? `${p.pct.toFixed(1)}%` : '');
      const text =
        c.planShare.cold.status === 'learning'
          ? t('check.plan_share_learning', { n: c.planShare.cold.windows })
          : t('check.plan_share', { warm: share(c.planShare.warm), cold: share(c.planShare.cold) });
      row(t('check.label.plan_share'), text, 'estimated');
    }
  }

  // Levers, recommended one marked.
  if (view.levers.length > 0) {
    lines.push('', t('check.label.levers'));
    const nameWidth = Math.max(...view.levers.map(l => t(`lever.${l.lever}.name`).length));
    for (const l of view.levers) {
      const params = {
        mark: l.recommended ? g.pick : ' ',
        name: t(`lever.${l.lever}.name`).padEnd(nameWidth),
        now: l.nowUsd === null ? t('cost.unknown') : formatUsd(l.nowUsd),
        turns: HORIZON_TURNS,
        horizon: l.horizonUsd === null ? t('cost.unknown') : formatUsd(l.horizonUsd),
      };
      row('', t(l.horizonUsd !== null && l.horizonUsd !== l.nowUsd ? 'check.lever' : 'check.lever_now_only', params), l.tier);
      if (verbose) row('', `    ${t(l.effectKey)}`);
    }
  }

  // Verbose extras: timeline, rationale and calibration.
  if (verbose) {
    if (view.timeline !== null && view.timeline.length > 0) {
      lines.push('', t('check.label.timeline'));
      row('', t('check.timeline_head'));
      for (const r of view.timeline) {
        const cells = [
          clock(r.tsStart, true).padEnd(10),
          (r.gapSec === null ? '-' : formatDuration(r.gapSec)).padEnd(9),
          formatTokensLong(r.read).padEnd(9),
          formatTokensLong(r.write).padEnd(9),
          formatTokensLong(r.input).padEnd(8),
          t(`past.${outcomeKey(r.outcome)}`),
        ];
        row('', cells.join(''), 'measured');
      }
    }
    lines.push('', t('check.label.rationale'));
    view.drivers.forEach((d, i) => {
      const params: Record<string, string | number> = { ...d.params };
      if (typeof params.kind === 'string') params.kind = t(`event.${params.kind}`);
      row('', `${i + 1}. ${t(d.key, params)}`, d.tier);
    });
    const n = view.drivers.find(d => d.key === 'driver.eps')?.params.n ?? 0;
    row(t('check.label.calibration'), t(view.lowEvidence ? 'check.calibration_prior' : 'check.calibration_learned', { n }), 'estimated');
  }

  lines.push('');
  row(null, t('check.recommend', { text: recommendationText(view, t, clock) }), 'estimated');
  if (view.recommendation.probeHint) {
    const probe = view.levers.find(l => l.lever === 'probe');
    row('', t('check.probe_hint', { warm: usd(c?.warmUsd ?? null), cold: usd(c?.coldUsd ?? probe?.nowUsd ?? null) }), 'estimated');
  }
  return lines.map(l => l.trimEnd()).join('\n');

  /** The diff view's rows. */
  function renderDiff(v: CheckView, tr: typeof t, add: typeof row): void {
    const d = v.diff!;
    if (d.changes.length === 0) add('', tr('check.no_changes'));
    d.changes.forEach((ch, i) => {
      const text =
        ch.field === 'event'
          ? tr('check.change_event', { event: tr(`event.${ch.to}`) })
          : tr('check.change', { field: tr(`field.${ch.field}`), from: ch.from ?? tr('check.unknown_value'), to: ch.to ?? tr('check.unknown_value') });
      add(i === 0 ? tr('check.label.changes') : '', text);
    });
    if (d.missCauses.length > 0) add('', tr('check.miss_causes', { causes: causeNames(d.missCauses, o.strings, tr) }));
  }
}

/** The `check.last_request` parameters. */
function lastRequestParams(view: CheckView, clock: (ms: number, seconds?: boolean) => string): Record<string, string> {
  const r = view.lastRequest!;
  return { time: clock(r.tsStart, true), ago: formatDuration((view.at - r.tsStart) / 1000) };
}

/**
 * Claude Code's miss-cause names in words; a cause the catalog doesn't know
 * yet is shown as Claude Code named it, since its list isn't closed.
 */
function causeNames(causes: readonly string[], strings: Strings, t: (key: string) => string): string {
  return causes.map(c => (strings.strings[`cause.${c}`] !== undefined ? t(`cause.${c}`) : c)).join(', ');
}

/** `1h` → `1 hour`. */
function ttlWords(ttl: string): string {
  return ttl === '1h' ? '1 hour' : ttl === '5m' ? '5 minutes' : ttl;
}

/** The outcome's catalog suffix. */
function outcomeKey(outcome: string): string {
  return outcome === 'COLD_START' ? 'cold_start' : outcome.toLowerCase();
}

/** Why an `UNKNOWN` view has no state, in words. */
function unknownReason(view: CheckView, t: (key: string, params?: Record<string, string | number>) => string): string {
  if (view.unknownReason === 'version') {
    const min = view.drivers.find(d => d.key === 'driver.version')?.params.min ?? '';
    return t('unknown.version', { version: String(min) });
  }
  return t(view.unknownReason === 'caching_off' ? 'unknown.caching_off' : 'unknown.no_response');
}

/** The recommendation as one line. */
function recommendationText(
  view: CheckView,
  t: (key: string, params?: Record<string, string | number>) => string,
  clock: (ms: number) => string,
): string {
  const r = view.recommendation;
  const params: Record<string, string | number> = { ...r.params };
  if (typeof params.expiresAt === 'number') params.time = clock(params.expiresAt);
  if (typeof params.usd === 'number') params.cost = formatUsd(params.usd);
  if (typeof params.lever === 'string') params.lever = t(`lever.${params.lever}.name`);
  if (typeof params.reason === 'string') params.reason = unknownReason(view, t);
  params.turns = HORIZON_TURNS;
  return t(r.reasonKey, params);
}
