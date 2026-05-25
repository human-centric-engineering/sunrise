/**
 * Cohen's d — pooled-SD effect size for two independent samples.
 *
 * Reports how *meaningful* a difference is, on top of the t-test's
 * "is this difference reliable" answer. The winner-badge logic in the
 * compare view (Phase 2.5) requires |d| above a configurable threshold
 * (default 0.5 — Cohen's "medium" effect) so that statistical
 * significance alone doesn't crown a winner that's actually a
 * negligible 0.01-point improvement.
 *
 * Pooled SD is the standard estimator: `√[((n1-1)·s1² + (n2-1)·s2²) / (n1+n2-2)]`.
 * Returns null when either sample has <2 values or the pooled SD is
 * zero (e.g. both samples are constant) — there's no defined effect
 * size in that case.
 */

export interface CohensDResult {
  /** Effect size in pooled-SD units. Null on insufficient samples. */
  d: number | null;
  /**
   * Conventional magnitude label following Cohen (1988):
   *   |d| < 0.2 → 'negligible'
   *   |d| < 0.5 → 'small'
   *   |d| < 0.8 → 'medium'
   *   |d| ≥ 0.8 → 'large'
   * Null when `d` is null.
   */
  magnitude: 'negligible' | 'small' | 'medium' | 'large' | null;
}

export function cohensD(a: number[], b: number[]): CohensDResult {
  const n1 = a.length;
  const n2 = b.length;
  if (n1 < 2 || n2 < 2) return { d: null, magnitude: null };

  const m1 = mean(a);
  const m2 = mean(b);
  const v1 = sampleVariance(a, m1);
  const v2 = sampleVariance(b, m2);

  const pooledVariance = ((n1 - 1) * v1 + (n2 - 1) * v2) / (n1 + n2 - 2);
  // Floating-point accumulation: a sample of e.g. [0.7, 0.7, 0.7] does
  // not have exactly-zero variance because 0.7 isn't representable in
  // IEEE 754. Treating anything below the rounding floor as zero.
  if (pooledVariance < 1e-12) return { d: null, magnitude: null };

  const d = (m1 - m2) / Math.sqrt(pooledVariance);
  return { d, magnitude: classify(d) };
}

function classify(d: number): CohensDResult['magnitude'] {
  const abs = Math.abs(d);
  if (abs < 0.2) return 'negligible';
  if (abs < 0.5) return 'small';
  if (abs < 0.8) return 'medium';
  return 'large';
}

function mean(xs: number[]): number {
  let total = 0;
  for (const x of xs) total += x;
  return total / xs.length;
}

function sampleVariance(xs: number[], m: number): number {
  let total = 0;
  for (const x of xs) total += (x - m) ** 2;
  return total / (xs.length - 1);
}
