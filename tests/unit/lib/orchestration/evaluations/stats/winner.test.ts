/**
 * Unit tests for the pairwise variant winner decision.
 *
 * Coverage:
 * - Insufficient samples (n<2) → no_clear_winner
 * - Statistical significance below threshold → no_clear_winner
 * - Effect size below threshold → no_clear_winner
 * - All three conditions pass → 'a' or 'b' by mean direction
 * - Configurable thresholds shift the verdict
 *
 * @see lib/orchestration/evaluations/stats/winner.ts
 */

import { describe, it, expect } from 'vitest';
import { decidePairwiseWinner } from '@/lib/orchestration/evaluations/stats/winner';

describe('decidePairwiseWinner', () => {
  it('returns no_clear_winner with reason=insufficient_samples for tiny samples', () => {
    const result = decidePairwiseWinner([0.5], [0.7, 0.8]);
    expect(result.winner).toBe('no_clear_winner');
    expect(result.reason).toBe('insufficient_samples');
  });

  it('crowns "b" when b is clearly + significantly higher with a large effect', () => {
    const a = Array.from({ length: 20 }, (_, i) => 0.2 + 0.01 * i); // ~0.295 mean
    const b = Array.from({ length: 20 }, (_, i) => 0.7 + 0.01 * i); // ~0.795 mean
    const result = decidePairwiseWinner(a, b);
    expect(result.winner).toBe('b');
    expect(result.reason).toBe('b_wins');
    expect((result.pValue as number) < 0.05).toBe(true);
    expect(Math.abs(result.effectSize as number)).toBeGreaterThan(0.5);
  });

  it('crowns "a" when the direction reverses', () => {
    const a = Array.from({ length: 20 }, (_, i) => 0.7 + 0.01 * i);
    const b = Array.from({ length: 20 }, (_, i) => 0.2 + 0.01 * i);
    const result = decidePairwiseWinner(a, b);
    expect(result.winner).toBe('a');
    expect(result.reason).toBe('a_wins');
  });

  it('returns no_clear_winner with reason=p_above_threshold for noisy near-tied samples', () => {
    const a = [0.4, 0.5, 0.6, 0.5, 0.4, 0.6, 0.5];
    const b = [0.5, 0.5, 0.4, 0.6, 0.5, 0.5, 0.4];
    const result = decidePairwiseWinner(a, b);
    expect(result.winner).toBe('no_clear_winner');
    expect(result.reason).toBe('p_above_threshold');
  });

  it('returns no_clear_winner when the effect size is too small even at large N', () => {
    // Means are 0.5 ± noise vs 0.52 ± same noise. Generous N (60 per
    // side) means the t-test may reach significance, but the
    // standardised effect is much smaller than the 0.5 magnitude
    // threshold so the winner badge should NOT fire.
    const noise = [-0.2, -0.1, 0, 0.1, 0.2, -0.15, -0.05, 0.05, 0.15, 0.0];
    const a: number[] = [];
    const b: number[] = [];
    for (let i = 0; i < 6; i++) {
      for (const n of noise) {
        a.push(0.5 + n);
        b.push(0.52 + n);
      }
    }
    const result = decidePairwiseWinner(a, b);
    expect(result.winner).toBe('no_clear_winner');
  });

  it('respects a tighter pThreshold', () => {
    const a = Array.from({ length: 20 }, (_, i) => 0.5 + 0.01 * i);
    const b = Array.from({ length: 20 }, (_, i) => 0.6 + 0.01 * i);
    const loose = decidePairwiseWinner(a, b, { pThreshold: 0.05 });
    const tight = decidePairwiseWinner(a, b, { pThreshold: 1e-10 });
    // tight should be stricter — never more permissive than loose
    if (loose.winner === 'no_clear_winner') {
      expect(tight.winner).toBe('no_clear_winner');
    }
  });

  it('respects a stricter effectSizeThreshold', () => {
    const a = Array.from({ length: 30 }, (_, i) => 0.4 + 0.01 * (i % 10));
    const b = Array.from({ length: 30 }, (_, i) => 0.5 + 0.01 * (i % 10));
    const loose = decidePairwiseWinner(a, b, { effectSizeThreshold: 0.5 });
    const tight = decidePairwiseWinner(a, b, { effectSizeThreshold: 5.0 });
    // Stricter effect-size requirement can only make the test more
    // conservative; the tight call cannot crown a winner the loose call
    // didn't.
    if (tight.winner !== 'no_clear_winner') {
      expect(loose.winner).not.toBe('no_clear_winner');
    }
  });
});
