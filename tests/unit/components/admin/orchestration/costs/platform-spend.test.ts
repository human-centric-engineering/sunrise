/**
 * platformSpend — the platform's part of a cost figure (§137).
 *
 * @see components/admin/orchestration/costs/platform-spend.ts
 */

import { describe, expect, it } from 'vitest';

import { platformSpend } from '@/components/admin/orchestration/costs/platform-spend';

describe('platformSpend', () => {
  it('is all spend less the part on orgs’ own keys', () => {
    expect(platformSpend(60, 50)).toBe(10);
    expect(platformSpend(0.03, 0)).toBe(0.03);
  });

  it('reads a float residue from two separate sums as zero', () => {
    // 0.1 + 0.2 summed one way and 0.3 another: not exactly equal.
    const total = 0.1 + 0.2;
    expect(total - 0.3).not.toBe(0);
    expect(platformSpend(total, 0.3)).toBe(0);
    expect(platformSpend(0.3, total)).toBe(0);
  });

  it('keeps a real sub-cent figure', () => {
    // A millionth of a dollar is a real (tiny) spend, not residue.
    expect(platformSpend(0.000_002, 0.000_001)).toBeCloseTo(0.000_001, 12);
  });
});
