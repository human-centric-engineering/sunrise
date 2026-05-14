/**
 * Tests for the pattern-advisor starter prompt pool.
 *
 * The pool is the canonical input to both the starter grid (5 random
 * prompts shown before any messages) and the in-chat suggest-a-prompt
 * button. The invariants below — coverage, count, uniqueness — are
 * what we rely on when sampling; regressions here ripple into the
 * Learning Lab UX immediately.
 */

import { describe, expect, it } from 'vitest';

import {
  ADVISOR_PROMPTS,
  ADVISOR_PROMPT_STRINGS,
  PATTERN_NAMES,
  pickAdvisorPrompt,
  sampleAdvisorPrompts,
} from '@/lib/orchestration/learn/advisor-prompts';

describe('advisor prompt pool', () => {
  it('contains at least 64 prompts', () => {
    expect(ADVISOR_PROMPTS.length).toBeGreaterThanOrEqual(64);
  });

  it('covers every one of the 21 patterns at least once', () => {
    const covered = new Set(ADVISOR_PROMPTS.map((p) => p.patternNumber));
    for (let n = 1; n <= 21; n++) {
      expect(covered.has(n), `pattern ${n} (${PATTERN_NAMES[n]}) has no prompt`).toBe(true);
    }
  });

  it('uses only valid pattern numbers (1–21)', () => {
    for (const entry of ADVISOR_PROMPTS) {
      expect(entry.patternNumber).toBeGreaterThanOrEqual(1);
      expect(entry.patternNumber).toBeLessThanOrEqual(21);
    }
  });

  it('has no duplicate prompt strings', () => {
    const set = new Set(ADVISOR_PROMPT_STRINGS);
    expect(set.size).toBe(ADVISOR_PROMPT_STRINGS.length);
  });

  it('keeps every prompt as a non-empty trimmed string', () => {
    for (const s of ADVISOR_PROMPT_STRINGS) {
      expect(typeof s).toBe('string');
      expect(s.trim()).toBe(s);
      expect(s.length).toBeGreaterThan(0);
    }
  });
});

describe('sampleAdvisorPrompts', () => {
  it('returns the requested count of distinct prompts when count <= pool size', () => {
    const picked = sampleAdvisorPrompts(5);
    expect(picked).toHaveLength(5);
    expect(new Set(picked).size).toBe(5);
    for (const p of picked) {
      expect(ADVISOR_PROMPT_STRINGS).toContain(p);
    }
  });

  it('clamps to the pool size when count exceeds it', () => {
    const picked = sampleAdvisorPrompts(ADVISOR_PROMPT_STRINGS.length + 50);
    expect(picked).toHaveLength(ADVISOR_PROMPT_STRINGS.length);
    expect(new Set(picked).size).toBe(ADVISOR_PROMPT_STRINGS.length);
  });

  it('returns an empty array for non-positive counts', () => {
    expect(sampleAdvisorPrompts(0)).toEqual([]);
    expect(sampleAdvisorPrompts(-3)).toEqual([]);
  });

  it('uses the injected random source so results are reproducible in tests', () => {
    // Pin the random source so the test does not rely on Math.random
    // ordering. Two identical sequences must produce identical picks
    // — that is what we'll rely on when snapshotting Learning Lab
    // renders.
    const seq = [0.1, 0.2, 0.3, 0.4, 0.5];
    let idx = 0;
    const rng = () => seq[idx++ % seq.length] ?? 0;
    const a = sampleAdvisorPrompts(5, rng);
    idx = 0;
    const b = sampleAdvisorPrompts(5, rng);
    expect(a).toEqual(b);
  });
});

describe('pickAdvisorPrompt', () => {
  it('returns a prompt from the pool', () => {
    const picked = pickAdvisorPrompt();
    expect(ADVISOR_PROMPT_STRINGS).toContain(picked);
  });

  it('falls back to the first prompt when the index lookup produces undefined', () => {
    // The defensive `?? ADVISOR_PROMPT_STRINGS[0]` guard only fires
    // when `pool[idx]` is undefined. We can't shrink the pool, so we
    // feed a `random` source that produces NaN — `Math.floor(NaN * n)`
    // is NaN and `pool[NaN]` is undefined, hitting the fallback.
    const picked = pickAdvisorPrompt(() => Number.NaN);
    expect(picked).toBe(ADVISOR_PROMPT_STRINGS[0]);
  });

  it('honours an injected random source', () => {
    // rng → 0 always picks index 0; that nails down which prompt
    // the caller gets without making the test sensitive to
    // additions at the end of the pool.
    const first = pickAdvisorPrompt(() => 0);
    expect(first).toBe(ADVISOR_PROMPT_STRINGS[0]);
  });
});
