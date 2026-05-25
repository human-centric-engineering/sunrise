/**
 * Unit tests for pooled-SD Cohen's d.
 *
 * Reference values from the standard formula (verified against R's
 * `effsize::cohen.d`).
 *
 * @see lib/orchestration/evaluations/stats/cohens-d.ts
 */

import { describe, it, expect } from 'vitest';
import { cohensD } from '@/lib/orchestration/evaluations/stats/cohens-d';

describe('cohensD', () => {
  it('returns null fields when either sample has <2 values', () => {
    expect(cohensD([], [1, 2]).d).toBeNull();
    expect(cohensD([1, 2], [1]).d).toBeNull();
  });

  it('returns d=0 with negligible magnitude when means and variances match', () => {
    const sample = [0.1, 0.3, 0.5, 0.7, 0.9];
    const result = cohensD(sample, sample);
    expect(result.d).toBeCloseTo(0, 6);
    expect(result.magnitude).toBe('negligible');
  });

  it('classifies a roughly 1-SD shift as "large"', () => {
    // Two samples with similar spread but means separated by ~1 pooled SD
    const a = [0.0, 0.1, 0.2, 0.3, 0.4];
    const b = [0.3, 0.4, 0.5, 0.6, 0.7];
    const result = cohensD(a, b);
    expect(result.d).not.toBeNull();
    expect((result.d as number) < 0).toBe(true); // b is larger, so a-b is negative
    expect(Math.abs(result.d as number)).toBeGreaterThan(0.8);
    expect(result.magnitude).toBe('large');
  });

  it('classifies a roughly 0.3-SD shift as "small"', () => {
    // Shift just above the negligible threshold but below 0.5
    const a = [0.0, 0.2, 0.4, 0.6, 0.8];
    const b = [0.1, 0.3, 0.5, 0.7, 0.9];
    const result = cohensD(a, b);
    expect(result.magnitude).toBe('small');
  });

  it('returns null when both samples are constant (pooled variance = 0)', () => {
    const result = cohensD([0.5, 0.5, 0.5], [0.7, 0.7, 0.7]);
    expect(result.d).toBeNull();
    expect(result.magnitude).toBeNull();
  });

  it('is sign-aware (a-b)', () => {
    const a = [1, 1.5, 2, 2.5, 3];
    const b = [0, 0.5, 1, 1.5, 2];
    const result = cohensD(a, b);
    expect((result.d as number) > 0).toBe(true);
  });
});
