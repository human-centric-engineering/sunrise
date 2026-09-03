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
  hasProviderEligibilityResolver,
  __resetProviderEligibility,
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
    __resetProviderEligibility();
  });

  afterEach(() => {
    __resetProviderEligibility();
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
      expect.stringContaining('denying all fallbacks'),
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

    __resetProviderEligibility();

    expect(hasProviderEligibilityResolver()).toBe(false);
    const candidates = ['a'];
    await expect(resolveEligibleProviders(candidates, CTX)).resolves.toBe(candidates);
  });
});
