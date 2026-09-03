/**
 * Unit tests: the provider-eligibility seam itself.
 *
 * `agent-resolver.test.ts` covers what the seam DOES to a binding. This covers
 * the registry's own contract — the parts a fork interacts with directly, and
 * which no resolver test reaches.
 *
 * @see lib/orchestration/llm/provider-eligibility.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

import { logger } from '@/lib/logging';
import {
  registerProviderEligibility,
  resolveEligibleProviders,
  isProviderEligible,
  hasProviderEligibilityResolver,
  resetProviderEligibility,
  type ProviderEligibilityContext,
} from '@/lib/orchestration/llm/provider-eligibility';

const CTX: ProviderEligibilityContext = {
  task: 'chat',
  source: 'system',
  primarySlug: 'anthropic',
};

describe('provider eligibility registry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetProviderEligibility();
  });

  afterEach(() => {
    resetProviderEligibility();
  });

  it('reports nothing registered by default, and is the identity function', async () => {
    const candidates = ['a', 'b'];

    expect(hasProviderEligibilityResolver()).toBe(false);
    // Identity, not a copy: the default must not even allocate a new array, so
    // "unchanged" is a fact about the object rather than about its contents.
    await expect(resolveEligibleProviders(candidates, CTX)).resolves.toBe(candidates);
  });

  it('re-registering the SAME reference is a no-op', async () => {
    const rule = (c: readonly string[]) => c;

    registerProviderEligibility(rule);
    expect(() => registerProviderEligibility(rule)).not.toThrow();
    expect(hasProviderEligibilityResolver()).toBe(true);
  });

  it('registering a DIFFERENT rule throws rather than shadowing the first', async () => {
    // Two rules in a tree means one of them is not running, and there is no way
    // to tell which from the outside. Silently replacing would make an
    // eligibility policy that looks registered but is not.
    registerProviderEligibility((c) => c);

    expect(() => registerProviderEligibility((c) => c.slice(0, 1))).toThrow(/already registered/);
  });

  it('awaits an async rule', async () => {
    registerProviderEligibility(async (c) => c.filter((s) => s !== 'b'));

    await expect(resolveEligibleProviders(['a', 'b', 'c'], CTX)).resolves.toEqual(['a', 'c']);
  });

  it('denies everything and logs when the rule throws', async () => {
    registerProviderEligibility(() => {
      throw new Error('policy backend down');
    });

    await expect(resolveEligibleProviders(['a', 'b'], CTX)).resolves.toEqual([]);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('denying every candidate'),
      expect.objectContaining({ error: 'policy backend down', candidateCount: 2 })
    );
  });

  it('coerces a non-Error throw rather than logging "[object Object]"', async () => {
    // A fork can throw anything. The log has to stay readable, because it is
    // the only signal that a policy silently stopped applying.
    registerProviderEligibility(() => {
      // Deliberate: the rule is right about production code, but a fork's
      // resolver is code we do not control, and the `String(err)` in the catch
      // exists precisely because someone will throw a non-Error at it.
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw { code: 'weird' };
    });

    await expect(resolveEligibleProviders(['a'], CTX)).resolves.toEqual([]);
    expect(logger.error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ error: expect.stringContaining('object') })
    );
  });

  it('a rejected promise is caught like a synchronous throw', async () => {
    registerProviderEligibility(() => Promise.reject(new Error('async failure')));

    await expect(resolveEligibleProviders(['a', 'b'], CTX)).resolves.toEqual([]);
  });

  it('an empty result denies every fallback without erroring', async () => {
    // The deliberate deny-all case, distinct from the throw above: a fork
    // saying "no fallbacks for this org" is a valid answer, not a fault.
    registerProviderEligibility(() => []);

    await expect(resolveEligibleProviders(['a', 'b'], CTX)).resolves.toEqual([]);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('__reset restores the default', async () => {
    registerProviderEligibility(() => []);
    expect(hasProviderEligibilityResolver()).toBe(true);

    resetProviderEligibility();

    expect(hasProviderEligibilityResolver()).toBe(false);
    const candidates = ['a'];
    await expect(resolveEligibleProviders(candidates, CTX)).resolves.toBe(candidates);
  });
});

describe('isProviderEligible', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetProviderEligibility();
  });

  afterEach(() => {
    resetProviderEligibility();
  });

  it('permits everything by default, like the list form', async () => {
    await expect(isProviderEligible('openai', CTX)).resolves.toBe(true);
  });

  it('answers false when the rule excludes the slug', async () => {
    registerProviderEligibility((c) => c.filter((s) => s !== 'openai'));

    await expect(isProviderEligible('openai', CTX)).resolves.toBe(false);
    // Both directions from the SAME rule. A helper that always answered false
    // would satisfy the line above on its own.
    await expect(isProviderEligible('anthropic', CTX)).resolves.toBe(true);
  });

  it('passes the caller’s context through to the rule untouched', async () => {
    // A fork's rule is expected to branch on `source` and `task`; a helper that
    // dropped or rewrote them would make those branches unreachable while every
    // permit/deny assertion above still passed.
    const seen: ProviderEligibilityContext[] = [];
    registerProviderEligibility((c, ctx) => {
      seen.push(ctx);
      return c;
    });

    await isProviderEligible('openai', { task: 'chat', source: 'primary', primarySlug: null });

    expect(seen).toEqual([{ task: 'chat', source: 'primary', primarySlug: null }]);
  });

  it('denies when the rule throws', async () => {
    // Fail-closed, same as the list form — this is what the four non-resolver
    // callers rely on to refuse rather than run.
    registerProviderEligibility(() => {
      throw new Error('policy backend down');
    });

    await expect(isProviderEligible('openai', CTX)).resolves.toBe(false);
  });

  it('cannot be widened by a rule returning a provider that was not asked about', async () => {
    // The intersect in `resolveEligibleProviders` is what makes this true;
    // asserting it here stops the single-candidate path being rewritten as a
    // bare `eligible.includes(slug)` against an unintersected result.
    registerProviderEligibility(() => ['anthropic']);

    await expect(isProviderEligible('openai', CTX)).resolves.toBe(false);
  });
});
