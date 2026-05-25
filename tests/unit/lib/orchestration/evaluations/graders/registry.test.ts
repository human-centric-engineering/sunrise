/**
 * Unit tests for the grader registry module.
 *
 * Drives the registry directly without going through the barrel —
 * `__resetGraderRegistryForTests()` is invoked in `beforeEach` so each
 * test starts from a known-empty state. Two tiny fixture graders (one
 * heuristic, one pairwise) cover the type-narrow lookup branches without
 * pulling in real grader modules that would self-register on import.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  __resetGraderRegistryForTests,
  getGrader,
  getPairwiseGrader,
  getRegisteredSlugs,
  hasGrader,
  listGraders,
  registerGrader,
} from '@/lib/orchestration/evaluations/graders/registry';
import type { Grader, PairwiseGrader } from '@/lib/orchestration/evaluations/graders/types';

function makeHeuristicGrader(slug: string, description = `desc-${slug}`): Grader<{ x: number }> {
  return {
    slug,
    family: 'heuristic',
    referenceRequired: false,
    configSchema: z.object({ x: z.number() }),
    grade: async () => ({ score: 1 }),
    description,
  };
}

function makePairwiseGrader(slug: string): PairwiseGrader<{ y: string }> {
  return {
    slug,
    family: 'pairwise',
    configSchema: z.object({ y: z.string() }),
    grade: async () => ({ verdict: 'tie', reasoning: 'fixture' }),
    description: `pair-${slug}`,
  };
}

beforeEach(() => {
  __resetGraderRegistryForTests();
});

describe('grader registry', () => {
  it('registers a grader and round-trips it via getGrader', () => {
    const g = makeHeuristicGrader('alpha');
    registerGrader(g);

    const fetched = getGrader('alpha');
    expect(fetched).toBe(g);
    expect(fetched.slug).toBe('alpha');
    expect(fetched.family).toBe('heuristic');
  });

  it('hasGrader returns true after register, false for unknown slug', () => {
    expect(hasGrader('alpha')).toBe(false);
    registerGrader(makeHeuristicGrader('alpha'));
    expect(hasGrader('alpha')).toBe(true);
    expect(hasGrader('beta')).toBe(false);
  });

  it('listGraders returns entries in registration order', () => {
    const a = makeHeuristicGrader('alpha');
    const b = makeHeuristicGrader('beta');
    const c = makePairwiseGrader('charlie');
    registerGrader(a);
    registerGrader(b);
    registerGrader(c);

    const list = listGraders();
    expect(list).toEqual([a, b, c]);
  });

  it('getRegisteredSlugs returns slugs in registration order', () => {
    registerGrader(makeHeuristicGrader('alpha'));
    registerGrader(makePairwiseGrader('beta'));
    registerGrader(makeHeuristicGrader('gamma'));

    expect(getRegisteredSlugs()).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('getGrader throws when the slug is not registered', () => {
    expect(() => getGrader('ghost')).toThrow(/No grader registered for slug "ghost"/);
  });

  it('getGrader throws when the slug names a pairwise grader', () => {
    registerGrader(makePairwiseGrader('pair-1'));
    expect(() => getGrader('pair-1')).toThrow(/Grader "pair-1" is pairwise; use getPairwiseGrader/);
  });

  it('getPairwiseGrader returns the pairwise entry', () => {
    const p = makePairwiseGrader('pair-1');
    registerGrader(p);

    const fetched = getPairwiseGrader('pair-1');
    expect(fetched).toBe(p);
    expect(fetched.family).toBe('pairwise');
  });

  it('getPairwiseGrader throws when the slug is not registered', () => {
    expect(() => getPairwiseGrader('ghost')).toThrow(/No grader registered for slug "ghost"/);
  });

  it('getPairwiseGrader throws when the slug names a single-output grader', () => {
    registerGrader(makeHeuristicGrader('alpha'));
    expect(() => getPairwiseGrader('alpha')).toThrow(/Grader "alpha" is not pairwise/);
  });

  it('re-registering the same slug overrides the previous entry (idempotent on slug)', () => {
    const first = makeHeuristicGrader('alpha', 'first');
    const second = makeHeuristicGrader('alpha', 'second');
    registerGrader(first);
    registerGrader(second);

    expect(getGrader('alpha')).toBe(second);
    expect(getGrader('alpha').description).toBe('second');
    // Slug count must not double — Map semantics on the slug key.
    expect(getRegisteredSlugs()).toEqual(['alpha']);
    expect(listGraders()).toHaveLength(1);
  });

  it('__resetGraderRegistryForTests clears all entries', () => {
    registerGrader(makeHeuristicGrader('alpha'));
    registerGrader(makeHeuristicGrader('beta'));
    expect(listGraders()).toHaveLength(2);

    __resetGraderRegistryForTests();

    expect(listGraders()).toEqual([]);
    expect(getRegisteredSlugs()).toEqual([]);
    expect(hasGrader('alpha')).toBe(false);
  });
});
