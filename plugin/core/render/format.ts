/**
 * Number, time and glyph formatting shared by the renderers. Everything here
 * is locale-free on purpose: the hooks module has no guarantee of `Intl`, and
 * the Go port must produce byte-identical text for the parity fixtures.
 */

/** Glyphs for one rendering style (REQ-22.0.1: Unicode or ASCII). */
export interface GlyphSet {
  readonly name: 'unicode' | 'ascii';
  readonly state: Readonly<Record<'HOT' | 'EXPIRING' | 'UNCERTAIN' | 'INVALIDATED' | 'COLD' | 'UNKNOWN', string>>;
  /** Horizontal rule character. */
  readonly rule: string;
  /** Marks the recommended lever. */
  readonly pick: string;
  readonly arrow: string;
  readonly dot: string;
  readonly approx: string;
  readonly ellipsis: string;
  /** At least / at most, for capped probabilities. */
  readonly ge: string;
  readonly le: string;
  /** Range separator. */
  readonly dash: string;
  /** The miss-rate symbol in rationale lines. */
  readonly eps: string;
}

export const UNICODE: GlyphSet = {
  name: 'unicode',
  state: { HOT: '●', EXPIRING: '◐', UNCERTAIN: '◌', INVALIDATED: '✕', COLD: '○', UNKNOWN: '?' },
  rule: '─',
  pick: '▶',
  arrow: '→',
  dot: '·',
  approx: '≈',
  ellipsis: '…',
  ge: '≥',
  le: '≤',
  dash: '–',
  eps: 'ε',
};

export const ASCII: GlyphSet = {
  name: 'ascii',
  state: { HOT: '*', EXPIRING: '~', UNCERTAIN: '?', INVALIDATED: 'x', COLD: 'o', UNKNOWN: '?' },
  rule: '-',
  pick: '>',
  arrow: '->',
  dot: '|',
  approx: '~',
  ellipsis: '...',
  ge: '>=',
  le: '<=',
  dash: '-',
  eps: 'eps',
};

/** The catalog placeholders every glyph set fills, so any string renders in either style. */
export function glyphParams(g: GlyphSet): Record<string, string> {
  return { dot: g.dot, approx: g.approx, arrow: g.arrow, ge: g.ge, le: g.le, dash: g.dash, epsilon: g.eps };
}

/** The glyph set for a configured style. */
export function glyphSet(style: 'unicode' | 'ascii'): GlyphSet {
  return style === 'ascii' ? ASCII : UNICODE;
}

/** Two digits, zero-padded. */
function two(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * A wall-clock time, `HH:MM` or `HH:MM:SS`, at a fixed offset from UTC. The
 * caller supplies the offset (the user's local one), which keeps this pure.
 *
 * @param ms epoch ms
 * @param tzOffsetMin minutes east of UTC
 * @param seconds include seconds
 */
export function formatClock(ms: number, tzOffsetMin: number, seconds = false): string {
  const d = new Date(ms + tzOffsetMin * 60_000);
  const hm = `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`;
  return seconds ? `${hm}:${two(d.getUTCSeconds())}` : hm;
}

/** A duration: `45s`, `12m`, `59m 48s` (under an hour, seconds when not a whole minute), `2h 05m`. */
export function formatDuration(totalSec: number): string {
  const s = Math.max(0, Math.round(totalSec));
  if (s < 60) return `${s}s`;
  if (s < 3600) {
    const m = Math.floor(s / 60);
    const rest = s % 60;
    return rest === 0 ? `${m}m` : `${m}m ${two(rest)}s`;
  }
  return `${Math.floor(s / 3600)}h ${two(Math.floor((s % 3600) / 60))}m`;
}

/** Tokens in short form: `950`, `812k`, `1.2M`. */
export function formatTokensShort(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(Math.round(n / 100_000) / 10).toFixed(1)}M`;
}

/** Tokens in full with thousands separators: `812,470`. */
export function formatTokensLong(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Dollars to the cent, `$6.50`; below a cent, `<$0.01`; zero, `$0.00`. */
export function formatUsd(usd: number): string {
  if (usd > 0 && usd < 0.005) return '<$0.01';
  return `$${usd.toFixed(2)}`;
}

/** A 0–1 fraction as a percentage with `digits` decimals: `97.2%`. */
export function formatPercent(fraction: number, digits = 1): string {
  return `${(fraction * 100).toFixed(digits)}%`;
}

/**
 * Fits text to a width, cutting with an ellipsis. Widths count UTF-16 code
 * units, which matches terminal columns for every glyph Token Shield uses.
 */
export function fit(text: string, width: number, ellipsis: string): string {
  if (text.length <= width) return text;
  return width <= ellipsis.length ? text.slice(0, width) : text.slice(0, width - ellipsis.length) + ellipsis;
}

/**
 * A date and wall-clock time without the year, `01-29 14:10`, for history
 * rows that span days.
 *
 * @param ms epoch ms
 * @param tzOffsetMin minutes east of UTC
 */
export function formatStamp(ms: number, tzOffsetMin: number): string {
  const d = new Date(ms + tzOffsetMin * 60_000);
  return `${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`;
}
