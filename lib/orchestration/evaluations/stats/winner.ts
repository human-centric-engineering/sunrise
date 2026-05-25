/**
 * Variant winner decision — composes Welch's t-test + Cohen's d.
 *
 * A variant "wins" on a given metric when ALL THREE conditions hold:
 *
 *   1. The variant's mean score is higher than the other's.
 *   2. The two-sided p-value is below the configured significance
 *      threshold (default 0.05).
 *   3. The absolute effect size |d| is above the configured magnitude
 *      threshold (default 0.5 — Cohen's "medium").
 *
 * Anything else → `'no_clear_winner'` so the UI doesn't crown a
 * statistical noise-effect or a difference too small to matter.
 *
 * Two-variant case is the canonical use; the compare view supports
 * 2–5 variants, but the winner-per-metric logic still resolves
 * pairwise (best variant vs. each runner-up).
 */

import { welchTTest } from '@/lib/orchestration/evaluations/stats/welch';
import { cohensD } from '@/lib/orchestration/evaluations/stats/cohens-d';

export const DEFAULT_P_THRESHOLD = 0.05;
export const DEFAULT_EFFECT_SIZE_THRESHOLD = 0.5;

export interface PairwiseWinnerResult {
  /** 'a' | 'b' | 'no_clear_winner' */
  winner: 'a' | 'b' | 'no_clear_winner';
  meanA: number | null;
  meanB: number | null;
  meanDifference: number | null;
  pValue: number | null;
  effectSize: number | null;
  /** Why this verdict — surfaced in the UI tooltip. */
  reason:
    | 'insufficient_samples'
    | 'p_above_threshold'
    | 'effect_size_too_small'
    | 'tied_means'
    | 'a_wins'
    | 'b_wins';
  n1: number;
  n2: number;
}

export interface DecideWinnerOptions {
  pThreshold?: number;
  effectSizeThreshold?: number;
}

export function decidePairwiseWinner(
  a: number[],
  b: number[],
  options: DecideWinnerOptions = {}
): PairwiseWinnerResult {
  const pThreshold = options.pThreshold ?? DEFAULT_P_THRESHOLD;
  const effectThreshold = options.effectSizeThreshold ?? DEFAULT_EFFECT_SIZE_THRESHOLD;

  const t = welchTTest(a, b);
  const d = cohensD(a, b);

  const meanA = a.length > 0 ? mean(a) : null;
  const meanB = b.length > 0 ? mean(b) : null;
  const meanDifference = meanA !== null && meanB !== null ? meanA - meanB : null;

  const base = {
    meanA,
    meanB,
    meanDifference,
    pValue: t.p,
    effectSize: d.d,
    n1: t.n1,
    n2: t.n2,
  };

  if (t.p === null || d.d === null) {
    return { ...base, winner: 'no_clear_winner', reason: 'insufficient_samples' };
  }
  if (t.p >= pThreshold) {
    return { ...base, winner: 'no_clear_winner', reason: 'p_above_threshold' };
  }
  if (Math.abs(d.d) < effectThreshold) {
    return { ...base, winner: 'no_clear_winner', reason: 'effect_size_too_small' };
  }
  if (meanDifference === null || meanDifference === 0) {
    return { ...base, winner: 'no_clear_winner', reason: 'tied_means' };
  }
  return {
    ...base,
    winner: meanDifference > 0 ? 'a' : 'b',
    reason: meanDifference > 0 ? 'a_wins' : 'b_wins',
  };
}

function mean(xs: number[]): number {
  let total = 0;
  for (const x of xs) total += x;
  return total / xs.length;
}
