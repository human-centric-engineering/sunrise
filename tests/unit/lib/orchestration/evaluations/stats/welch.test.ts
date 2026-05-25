/**
 * Unit tests for Welch's t-test.
 *
 * Canonical fixtures from R / scipy.stats.ttest_ind(equal_var=False).
 * The implementation uses Lentz's continued fraction for the incomplete
 * beta function, accurate to ~10⁻⁷ — assertions use toBeCloseTo with
 * 3 decimal precision so a future numerical-stability tweak doesn't
 * spuriously fail the suite.
 *
 * @see lib/orchestration/evaluations/stats/welch.ts
 */

import { describe, it, expect } from 'vitest';
import { welchTTest, twoSidedPValue } from '@/lib/orchestration/evaluations/stats/welch';

describe('welchTTest', () => {
  it('returns null fields when either sample has fewer than 2 values', () => {
    expect(welchTTest([], [1, 2]).t).toBeNull();
    expect(welchTTest([1], [1, 2]).t).toBeNull();
    expect(welchTTest([1, 2], [1]).p).toBeNull();
    expect(welchTTest([], []).df).toBeNull();
  });

  it('matches scipy on a clear-difference case (Welch, equal_var=False)', () => {
    // scipy: scipy.stats.ttest_ind([1,2,3,4,5], [4,5,6,7,8], equal_var=False)
    //   statistic = -3.0, pvalue ≈ 0.01693
    const result = welchTTest([1, 2, 3, 4, 5], [4, 5, 6, 7, 8]);
    expect(result.t).toBeCloseTo(-3.0, 3);
    expect(result.p).toBeCloseTo(0.01693, 3);
    expect(result.n1).toBe(5);
    expect(result.n2).toBe(5);
  });

  it('matches scipy on a no-difference case (means nearly identical)', () => {
    // scipy: ttest_ind([1,2,3,4,5], [1.1,2.0,3.1,3.9,5.0], equal_var=False) ≈ pvalue 0.961
    const a = [1, 2, 3, 4, 5];
    const b = [1.1, 2.0, 3.1, 3.9, 5.0];
    const result = welchTTest(a, b);
    expect(result.p).toBeGreaterThan(0.9);
    expect(Math.abs(result.t ?? 0)).toBeLessThan(0.1);
  });

  it('returns null when both samples have zero variance (degenerate)', () => {
    const result = welchTTest([0.5, 0.5, 0.5], [0.5, 0.5, 0.5]);
    expect(result.t).toBeNull();
    expect(result.p).toBeNull();
  });

  it('returns null when both samples are constant (zero within-sample variance)', () => {
    const a = Array(20).fill(0.2);
    const b = Array(20).fill(0.8);
    // Floating-point: constant samples have effectively-zero variance.
    // The t-statistic is undefined, not "significant". (The mean diff
    // is still informative but the test doesn't apply.)
    const result = welchTTest(a, b);
    expect(result.p).toBeNull();
  });

  it('rejects a tiny mean difference when within-sample variance is large', () => {
    // Two samples drawn from roughly the same distribution; means barely differ.
    const a = [0.1, 0.4, 0.5, 0.7, 0.9, 0.2, 0.6];
    const b = [0.15, 0.45, 0.5, 0.65, 0.85, 0.25, 0.55];
    const result = welchTTest(a, b);
    expect(result.p).not.toBeNull();
    expect(result.p as number).toBeGreaterThan(0.5);
  });
});

describe('twoSidedPValue', () => {
  it('returns 1 for t=0 (centered on the mean of the t-distribution)', () => {
    expect(twoSidedPValue(0, 5)).toBeCloseTo(1, 3);
  });

  it('approaches 0 as |t| grows for fixed df', () => {
    expect(twoSidedPValue(10, 5)).toBeLessThan(0.001);
  });

  it('is symmetric in the sign of t', () => {
    expect(twoSidedPValue(2.5, 10)).toBeCloseTo(twoSidedPValue(-2.5, 10), 6);
  });

  it('returns 1 for non-finite inputs (defensive)', () => {
    expect(twoSidedPValue(NaN, 5)).toBe(1);
    expect(twoSidedPValue(2, NaN)).toBe(1);
    expect(twoSidedPValue(2, 0)).toBe(1);
  });
});
