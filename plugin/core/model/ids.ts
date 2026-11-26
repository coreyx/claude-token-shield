/**
 * Small helpers for the ids and versions Claude Code reports, shared by the
 * assessor (per-message-effort lookups, the version gate) and the cost model
 * (price lookups).
 */

/**
 * Reduces a model id to the base id the data files use, e.g.
 * `us.anthropic.claude-opus-5-5-v1:0` → `claude-opus-5-5`,
 * `claude-opus-5-5[1m]` → `claude-opus-5-5`,
 * `claude-haiku-4-5-20251001` → `claude-haiku-4-5`,
 * `claude-sonnet-5@20260101` → `claude-sonnet-5`.
 *
 * @param id the id as reported
 * @returns the base id, or the input lower-cased when it isn't a Claude id
 */
export function baseModelId(id: string): string {
  let s = id.trim().toLowerCase();
  s = s.replace(/\[[^\]]*\]$/, ''); // context-size suffix such as [1m]
  const at = s.indexOf('claude-');
  if (at > 0) s = s.slice(at); // provider prefix such as us.anthropic. or anthropic.
  s = s.replace(/@.*$/, ''); // Vertex version suffix
  s = s.replace(/-v\d+(:\d+)?$/, ''); // Bedrock version suffix
  s = s.replace(/-\d{8}$/, ''); // dated snapshot id
  return s;
}

/**
 * Compares two `major.minor.patch` versions.
 *
 * @returns a negative number when `a < b`, 0 when equal, positive when `a > b`;
 *          `NaN` when either isn't a version
 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (pa === null || pb === null) return Number.NaN;
  for (let i = 0; i < 3; i++) {
    const d = pa[i]! - pb[i]!;
    if (d !== 0) return d;
  }
  return 0;
}

/** Splits `x.y.z` (ignoring any pre-release or build suffix) into three numbers. */
function parseVersion(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
