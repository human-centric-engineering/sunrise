/**
 * Unit Tests: coverage helper
 *
 * Covers the small pure helpers in lib/orchestration/knowledge/coverage.ts:
 *   - computeCoverage produces parsedChars / chunkChars / coveragePct
 *     correctly, with sensible behaviour on edge cases (empty source,
 *     over-100% capture, whitespace-only differences)
 *   - buildCoverageWarning returns a non-null warning only below the
 *     COVERAGE_WARNING_THRESHOLD and includes the percentage in the text
 */

import { describe, it, expect } from 'vitest';

import {
  COVERAGE_WARNING_THRESHOLD,
  buildCoverageWarning,
  computeCoverage,
} from '@/lib/orchestration/knowledge/coverage';

describe('computeCoverage', () => {
  it('reports 100% when every char of the source ends up in chunks', () => {
    const source = 'Hello, world.';
    const m = computeCoverage(source, [source]);
    expect(m.parsedChars).toBe(source.length);
    expect(m.chunkChars).toBe(source.length);
    expect(m.coveragePct).toBe(100);
  });

  it('reports the actual ratio when the chunker drops content', () => {
    const m = computeCoverage('a'.repeat(100), ['a'.repeat(50)]);
    expect(m.coveragePct).toBe(50);
  });

  it('rounds to 1 decimal place', () => {
    // 67 / 100 = 67% exactly
    expect(computeCoverage('a'.repeat(100), ['a'.repeat(67)]).coveragePct).toBe(67);
    // 1/3 ≈ 33.33...% → 33.3
    expect(computeCoverage('a'.repeat(3), ['a']).coveragePct).toBe(33.3);
  });

  it('allows over-100% when heading-aware chunking re-emits titles', () => {
    // Heading-aware chunker often prepends "# Section Title" to each child
    // chunk, so the sum exceeds the source. The metric should reflect that
    // honestly rather than capping at 100.
    const m = computeCoverage('body', ['# Title\nbody', '# Title\nbody']);
    expect(m.coveragePct).toBeGreaterThan(100);
  });

  it('treats empty source as 100% coverage (nothing to drop)', () => {
    const m = computeCoverage('', []);
    expect(m.coveragePct).toBe(100);
    expect(m.parsedChars).toBe(0);
    expect(m.chunkChars).toBe(0);
  });

  it('normalises by trimming whitespace on both sides', () => {
    // The chunker frequently strips surrounding whitespace — coverage
    // should not penalise that, otherwise every healthy upload would
    // get a warning.
    const source = '   hello   ';
    const m = computeCoverage(source, ['hello']);
    expect(m.coveragePct).toBe(100);
  });
});

describe('buildCoverageWarning', () => {
  it('returns null when coverage clears the threshold', () => {
    expect(
      buildCoverageWarning({
        parsedChars: 100,
        chunkChars: 100,
        coveragePct: COVERAGE_WARNING_THRESHOLD,
      })
    ).toBeNull();
  });

  it('returns a human-readable warning that includes the percentage', () => {
    const warning = buildCoverageWarning({
      parsedChars: 100,
      chunkChars: 50,
      coveragePct: 50,
    });
    expect(warning).not.toBeNull();
    expect(warning).toContain('50%');
    expect(warning).toContain('parsed text was captured');
  });
});
