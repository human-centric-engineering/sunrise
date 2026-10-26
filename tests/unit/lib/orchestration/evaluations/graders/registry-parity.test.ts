/**
 * Parity test for the grader registry.
 *
 * Asserts every slug enumerated in `KNOWN_GRADER_SLUGS` is registered
 * after importing the barrel. A grader file that forgets to call
 * `registerGrader` fails this test rather than silently disappearing
 * from the run-creation UI.
 *
 * Mirrors the workflow executor-registry parity test pattern.
 */

import { describe, it, expect, vi } from 'vitest';

// Count only core's graders. `getRegisteredSlugs()` runs the fork seam first,
// so a fork that registers its own grader would otherwise show up as `extra`.
vi.mock('@/lib/app/evaluations', () => ({ initAppGraders: vi.fn() }));

import { KNOWN_GRADER_SLUGS, getRegisteredSlugs } from '@/lib/orchestration/evaluations/graders';

describe('grader registry parity', () => {
  it('registers every slug listed in KNOWN_GRADER_SLUGS at module load', () => {
    const registered = new Set(getRegisteredSlugs());
    const expected = new Set<string>(KNOWN_GRADER_SLUGS);
    const missing = [...expected].filter((s) => !registered.has(s));
    const extra = [...registered].filter((s) => !expected.has(s));
    expect(missing).toEqual([]);
    expect(extra).toEqual([]);
  });
});
