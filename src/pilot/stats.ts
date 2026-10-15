/** Pure statistics for the gate and the review-time baseline (step 6, §5). */

export const WILSON_Z = 1.959964;

/**
 * Wilson score interval: `(p + z²/2n ± z·sqrt(p(1−p)/n + z²/4n²)) / (1 + z²/n)`.
 * `null` when `n` is 0. The bounds are clamped to [0, 1] (the formula gives exactly 1 for
 * `up = n` and 0 for `up = 0`, but floating point may land a few ulps off).
 */
export function wilson(
  up: number,
  n: number,
  z: number = WILSON_Z,
): { lower: number; upper: number } | null {
  if (n <= 0) return null;
  const p = up / n;
  const z2 = z * z;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  const denom = 1 + z2 / n;
  let lower = (centre - margin) / denom;
  let upper = (centre + margin) / denom;
  if (up >= n) upper = 1;
  if (up <= 0) lower = 0;
  return { lower: Math.max(0, lower), upper: Math.min(1, upper) };
}

/** Type 7 (linear interpolation, the R / NumPy default) percentile of a sorted list; p in [0, 1]. */
export function percentile(sorted: readonly number[], p: number): number | null {
  const n = sorted.length;
  if (n === 0) return null;
  if (n === 1) return sorted[0] as number;
  const h = (n - 1) * Math.min(1, Math.max(0, p));
  const lo = Math.floor(h);
  const hi = Math.min(n - 1, lo + 1);
  return (sorted[lo] as number) + (h - lo) * ((sorted[hi] as number) - (sorted[lo] as number));
}

export interface Summary {
  n: number;
  p50: number | null;
  p75: number | null;
  p90: number | null;
}

const round1 = (x: number | null): number | null => (x === null ? null : Math.round(x * 10) / 10);

/** n and the 50th, 75th and 90th percentiles (one decimal) of a list of values. */
export function summarize(values: readonly number[]): Summary {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: sorted.length,
    p50: round1(percentile(sorted, 0.5)),
    p75: round1(percentile(sorted, 0.75)),
    p90: round1(percentile(sorted, 0.9)),
  };
}
