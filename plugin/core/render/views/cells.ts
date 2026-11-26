/**
 * Shared primitives for the pane's views (REQ-13): patterned cells with a
 * glyph per meaning, so nothing depends on colour, and layout helpers that
 * fit any width.
 */

import { formatString } from '../../data/load';
import type { CheckRenderOptions } from '../check';
import { glyphParams } from '../format';

/** The cell patterns for read, written and uncached tokens, in each glyph set. */
export function cells(o: CheckRenderOptions): { read: string; written: string; uncached: string } {
  return o.glyphs.ellipsis === '…' ? { read: '█', written: '▓', uncached: '░' } : { read: '#', written: '=', uncached: '.' };
}

/** The string formatter with glyphs. */
export function fmt(o: CheckRenderOptions) {
  return (key: string, params: Record<string, string | number> = {}): string => formatString(o.strings, key, { ...glyphParams(o.glyphs), ...params });
}

/** Splits `width` cells among parts in proportion, rounding so the cells add up exactly. */
export function apportion(parts: readonly number[], width: number): number[] {
  const total = parts.reduce((s, p) => s + Math.max(0, p), 0);
  if (total <= 0 || width <= 0) return parts.map(() => 0);
  const exact = parts.map(p => (Math.max(0, p) / total) * width);
  const out = exact.map(Math.floor);
  let left = width - out.reduce((s, n) => s + n, 0);
  // The largest remainders get the leftover cells, earlier parts first on a tie.
  const order = exact.map((e, i) => [e - Math.floor(e), i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (const [, i] of order) {
    if (left <= 0) break;
    out[i]! += 1;
    left -= 1;
  }
  return out;
}

/** Breaks text into lines of at most `width` at spaces; a word longer than the width gets a line of its own. */
export function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line === '') line = word;
    else if (line.length + 1 + word.length <= width) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line !== '') lines.push(line);
  return lines;
}
