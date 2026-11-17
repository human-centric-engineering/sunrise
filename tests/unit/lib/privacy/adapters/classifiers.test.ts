/**
 * Tests: the sensitivity classifier slot (§130 t-1036) — its registration in
 * `lib/privacy/adapters/registry.ts` and its runner in
 * `lib/privacy/adapters/run.ts`.
 *
 * Both the fork seam and core's defaults are mocked, as in `registry.test.ts`,
 * so each case decides what core installs and what the app registers. Core's
 * own phrase classifier has its own tests.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const seam = vi.hoisted(() => ({ init: vi.fn<() => void>() }));
const core = vi.hoisted(() => ({ adapters: vi.fn() }));

vi.mock('@/lib/app/privacy-adapters', () => ({
  initAppPrivacyAdapters: () => seam.init(),
}));

vi.mock('@/lib/privacy/adapters/core-defaults', () => ({
  corePrivacyAdapters: () => core.adapters(),
}));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { logger } from '@/lib/logging';
import {
  __resetPrivacyAdaptersForTests,
  getPrivacyAdapters,
  MAX_DETECTOR_TIMEOUT_MS,
  registerPrivacyDetector,
  registerSensitivityClassifier,
} from '@/lib/privacy/adapters/registry';
import { runSensitivityClassifiers } from '@/lib/privacy/adapters/run';
import type {
  SensitivityClassifier,
  SensitivityFinding,
  SensitivityInput,
} from '@/lib/privacy/adapters/types';

function classifier(
  id: string,
  overrides: Partial<SensitivityClassifier> = {}
): SensitivityClassifier {
  return {
    id,
    egress: 'in_process',
    categories: { health: 'personal' },
    classify: () => Promise.resolve([]),
    ...overrides,
  };
}

/** A classifier that reports `found` whatever it is given. */
function reporting(
  id: string,
  categories: SensitivityClassifier['categories'],
  found: readonly string[]
): SensitivityClassifier {
  return classifier(id, {
    categories,
    classify: () => Promise.resolve(found.map((category) => ({ category }))),
  });
}

function emptyCore() {
  return {
    detectors: [],
    tokenStrategy: null,
    policyResolvers: [],
    observers: [],
    classifiers: [],
  };
}

/** Core installs one classifier, `core.phrases`, declaring `health` as personal. */
function coreWithClassifier(found: readonly string[] = []) {
  return {
    ...emptyCore(),
    classifiers: [{ classifier: reporting('core.phrases', { health: 'personal' }, found) }],
  };
}

const input: SensitivityInput = { parts: [{ role: 'user', text: 'hello' }] };

beforeEach(() => {
  __resetPrivacyAdaptersForTests();
  seam.init.mockReset();
  core.adapters.mockReset();
  core.adapters.mockImplementation(emptyCore);
  vi.mocked(logger.warn).mockClear();
  vi.mocked(logger.error).mockClear();
});

describe('registering a classifier', () => {
  it('installs core first, then the app, running in_process, then self_hosted, then external', () => {
    core.adapters.mockReturnValue(coreWithClassifier());
    seam.init.mockImplementation(() => {
      registerSensitivityClassifier(classifier('acme.remote', { egress: 'external' }));
      registerSensitivityClassifier(classifier('acme.local'));
    });
    const { classifiers, coreFailure, appInitFailure } = getPrivacyAdapters();
    expect(classifiers.map((c) => c.id)).toEqual(['core.phrases', 'acme.local', 'acme.remote']);
    expect(classifiers[0].core).toBe(true);
    expect(classifiers[1].core).toBe(false);
    expect(coreFailure).toBeNull();
    expect(appInitFailure).toBeNull();
  });

  it('is rolled back with everything else when the app init throws, and the failure is reported', () => {
    core.adapters.mockReturnValue(coreWithClassifier());
    seam.init.mockImplementation(() => {
      registerSensitivityClassifier(classifier('acme.first'));
      registerSensitivityClassifier(classifier('acme.replacement'), { replace: 'core.phrases' });
      throw new Error('init broke');
    });
    const snapshot = getPrivacyAdapters();
    // Core's is back, in place: the replacement and the app's own are gone.
    expect(snapshot.classifiers.map((c) => c.id)).toEqual(['core.phrases']);
    expect(snapshot.replacedCoreClassifiers).toEqual([]);
    expect(snapshot.appInitFailure).toMatch(/init broke/);
    // A rolled-back replacement was never reported as having happened.
    expect(logger.warn).not.toHaveBeenCalledWith(
      'privacy-adapters: a core sensitivity classifier was replaced',
      expect.anything()
    );
  });

  it('replaces a core classifier only when named, in its place, and says so once the init succeeds', () => {
    core.adapters.mockReturnValue({
      ...coreWithClassifier(),
      classifiers: [
        { classifier: reporting('core.phrases', { health: 'personal' }, []) },
        { classifier: reporting('core.second', { deal: 'commercial' }, []) },
      ],
    });
    seam.init.mockImplementation(() =>
      registerSensitivityClassifier(classifier('acme.phrases'), { replace: 'core.phrases' })
    );
    const { classifiers, replacedCoreClassifiers } = getPrivacyAdapters();
    expect(classifiers.map((c) => c.id)).toEqual(['acme.phrases', 'core.second']);
    expect(classifiers[0].replacesCore).toBe('core.phrases');
    expect(replacedCoreClassifiers).toEqual(['core.phrases']);
    expect(logger.warn).toHaveBeenCalledWith(
      'privacy-adapters: a core sensitivity classifier was replaced',
      { replaced: 'core.phrases', by: 'acme.phrases' }
    );
  });

  it('refuses a replace that names no core classifier, so a typo cannot turn nothing off', () => {
    core.adapters.mockReturnValue(coreWithClassifier());
    seam.init.mockImplementation(() =>
      registerSensitivityClassifier(classifier('acme.phrases'), { replace: 'core.phrase' })
    );
    const snapshot = getPrivacyAdapters();
    expect(snapshot.appInitFailure).toMatch(/not a registered core classifier/);
    expect(snapshot.classifiers.map((c) => c.id)).toEqual(['core.phrases']);
  });

  it('refuses a replace that names a core detector rather than a classifier', () => {
    core.adapters.mockReturnValue({
      ...emptyCore(),
      detectors: [
        {
          detector: {
            id: 'core.rules',
            egress: 'in_process',
            entityTypes: ['EMAIL'],
            detect: () => Promise.resolve([]),
          },
        },
      ],
    });
    getPrivacyAdapters();
    expect(() =>
      registerSensitivityClassifier(classifier('acme.phrases'), { replace: 'core.rules' })
    ).toThrow(/not a registered core classifier/);
  });

  it('refuses a category declared in another group from one already registered', () => {
    core.adapters.mockReturnValue(coreWithClassifier());
    getPrivacyAdapters();
    expect(() =>
      registerSensitivityClassifier(classifier('acme.x', { categories: { health: 'commercial' } }))
    ).toThrow(/health is in commercial, but core\.phrases declares it in personal/);
    // The same group is fine: categories may be shared.
    expect(() => registerSensitivityClassifier(classifier('acme.y'))).not.toThrow();
  });

  it('lets a replacement move a category to another group, since the one it replaces stops running', () => {
    core.adapters.mockReturnValue(coreWithClassifier());
    getPrivacyAdapters();
    expect(() =>
      registerSensitivityClassifier(
        classifier('acme.x', { categories: { health: 'commercial' } }),
        {
          replace: 'core.phrases',
        }
      )
    ).not.toThrow();
  });

  it('keeps what it validated, frozen, not the object it was handed', () => {
    getPrivacyAdapters();
    const categories: Record<string, 'personal' | 'commercial'> = { health: 'personal' };
    const handed = classifier('acme.x', { categories });
    registerSensitivityClassifier(handed);
    categories.deal = 'commercial';
    handed.id = 'acme.renamed';
    const [registration] = getPrivacyAdapters().classifiers;
    expect(registration.id).toBe('acme.x');
    expect(registration.categories).toEqual({ health: 'personal' });
    expect(Object.isFrozen(registration)).toBe(true);
    expect(Object.isFrozen(registration.categories)).toBe(true);
  });

  it.each([
    ['the core prefix', classifier('core.mine'), {}, /reserved/],
    ['an id with spaces', classifier(' acme.x'), {}, /id must be/],
    ['an unknown egress', classifier('acme.x', { egress: 'cloud' as never }), {}, /egress/],
    [
      'a jurisdiction that is not a string',
      classifier('acme.x', { jurisdiction: 3 as never }),
      {},
      /jurisdiction/,
    ],
    ['no categories', classifier('acme.x', { categories: {} }), {}, /at least one/],
    [
      'categories as a list',
      classifier('acme.x', { categories: ['health'] as never }),
      {},
      /map each category/,
    ],
    [
      'a category that is not lower snake case',
      classifier('acme.x', { categories: { Health: 'personal' } }),
      {},
      /not a valid name/,
    ],
    [
      'a group that is not a group',
      classifier('acme.x', { categories: { health: 'medical' as never } }),
      {},
      /one of personal, commercial/,
    ],
    [
      'classify that is not a function',
      classifier('acme.x', { classify: 'nope' as never }),
      {},
      /classify is not a function/,
    ],
    [
      'health that is not a function',
      classifier('acme.x', { health: 'nope' as never }),
      {},
      /health is not a function/,
    ],
    ['a zero timeout', classifier('acme.x'), { timeoutMs: 0 }, /timeoutMs/],
    [
      'a timeout past the maximum',
      classifier('acme.x'),
      { timeoutMs: MAX_DETECTOR_TIMEOUT_MS + 1 },
      /timeoutMs/,
    ],
  ])('refuses %s', (_name, c, options, message) => {
    getPrivacyAdapters();
    expect(() => registerSensitivityClassifier(c, options)).toThrow(message);
  });

  it('refuses a second registration of the same id', () => {
    getPrivacyAdapters();
    registerSensitivityClassifier(classifier('acme.x'));
    expect(() => registerSensitivityClassifier(classifier('acme.x'))).toThrow(/already registered/);
  });

  it('keeps classifiers and detectors apart: a detector cannot replace a classifier', () => {
    core.adapters.mockReturnValue(coreWithClassifier());
    getPrivacyAdapters();
    expect(() =>
      registerPrivacyDetector(
        {
          id: 'acme.d',
          egress: 'in_process',
          entityTypes: ['EMAIL'],
          detect: () => Promise.resolve([]),
        },
        { replace: 'core.phrases' }
      )
    ).toThrow(/not a registered core detector/);
  });
});

describe('running the classifiers', () => {
  it('unions what every classifier found, once each, sorted, with the group of each', async () => {
    core.adapters.mockReturnValue(coreWithClassifier(['health']));
    seam.init.mockImplementation(() => {
      registerSensitivityClassifier(
        reporting('acme.a', { health: 'personal', deal: 'commercial' }, ['health', 'deal'])
      );
      registerSensitivityClassifier(
        reporting('acme.b', { acme_secret: 'commercial' }, ['acme_secret'])
      );
    });
    const result = await runSensitivityClassifiers(input, { scopeId: 's' });
    expect(result.categories).toEqual([
      { category: 'acme_secret', group: 'commercial' },
      { category: 'deal', group: 'commercial' },
      { category: 'health', group: 'personal' },
    ]);
    expect(result.failures).toEqual([]);
  });

  it('runs them in parallel: one may wait on another without either timing out', async () => {
    const { promise: secondStarted, resolve } = Promise.withResolvers<void>();
    seam.init.mockImplementation(() => {
      registerSensitivityClassifier(
        classifier('acme.first', {
          classify: async () => {
            // Run one after another, this would wait for a classifier that
            // has not started, and time out.
            await secondStarted;
            return [{ category: 'health' }];
          },
        }),
        { timeoutMs: 200 }
      );
      registerSensitivityClassifier(
        classifier('acme.second', {
          classify: () => {
            resolve();
            return Promise.resolve([]);
          },
        })
      );
    });
    const result = await runSensitivityClassifiers(input, { scopeId: 's' });
    expect(result.failures).toEqual([]);
    expect(result.categories).toEqual([{ category: 'health', group: 'personal' }]);
  });

  it.each([
    ['a category it did not declare', () => Promise.resolve([{ category: 'deal' }])],
    ['a finding with no category', () => Promise.resolve([{ name: 'health' }] as never)],
    ['something that is not a list', () => Promise.resolve({ category: 'health' } as never)],
    ['a null finding', () => Promise.resolve([null] as never)],
  ])(
    'counts nothing from a classifier that returns %s, and reports it malformed',
    async (_name, classify: () => Promise<readonly SensitivityFinding[]>) => {
      seam.init.mockImplementation(() => {
        registerSensitivityClassifier(classifier('acme.bad', { classify }));
        registerSensitivityClassifier(reporting('acme.good', { health: 'personal' }, ['health']));
      });
      const result = await runSensitivityClassifiers(input, { scopeId: 's' });
      // The good one still counts; the bad one contributes nothing, not even
      // the categories it did declare.
      expect(result.categories).toEqual([{ category: 'health', group: 'personal' }]);
      expect(result.failures).toEqual([
        { adapterId: 'acme.bad', required: false, reason: 'malformed' },
      ]);
    }
  );

  it('reports a classifier that throws, and logs no text', async () => {
    seam.init.mockImplementation(() =>
      registerSensitivityClassifier(
        classifier('acme.bad', {
          classify: () => Promise.reject(new Error('saw: signed off with depression')),
        })
      )
    );
    const result = await runSensitivityClassifiers(input, { scopeId: 's' });
    expect(result.failures).toEqual([{ adapterId: 'acme.bad', required: false, reason: 'threw' }]);
    const logged = JSON.stringify(vi.mocked(logger.warn).mock.calls);
    expect(logged).toContain('acme.bad');
    expect(logged).not.toContain('depression');
  });

  it('reports a classifier that runs past its timeout, without waiting for it', async () => {
    seam.init.mockImplementation(() =>
      registerSensitivityClassifier(
        classifier('acme.slow', { classify: () => new Promise(() => undefined) }),
        { timeoutMs: 20 }
      )
    );
    const result = await runSensitivityClassifiers(input, { scopeId: 's' });
    expect(result.failures).toEqual([
      { adapterId: 'acme.slow', required: false, reason: 'timeout' },
    ]);
  });

  it('starts none of them for a call already abandoned, and reports each aborted', async () => {
    const classify = vi.fn(() => Promise.resolve([]));
    seam.init.mockImplementation(() =>
      registerSensitivityClassifier(classifier('acme.x', { classify }))
    );
    const result = await runSensitivityClassifiers(input, {
      scopeId: 's',
      signal: AbortSignal.abort(),
    });
    expect(classify).not.toHaveBeenCalled();
    expect(result.failures).toEqual([{ adapterId: 'acme.x', required: false, reason: 'aborted' }]);
  });

  it('hands every classifier the same frozen parts, so none can change what another reads', async () => {
    const seen: string[] = [];
    seam.init.mockImplementation(() => {
      registerSensitivityClassifier(
        classifier('acme.vandal', {
          classify: (given) => {
            (given.parts[0] as { text: string }).text = 'changed';
            return Promise.resolve([]);
          },
        })
      );
      registerSensitivityClassifier(
        classifier('acme.reader', {
          classify: (given) => {
            seen.push(given.parts[0].text);
            return Promise.resolve([]);
          },
        })
      );
    });
    const result = await runSensitivityClassifiers(input, { scopeId: 's' });
    expect(seen).toEqual(['hello']);
    expect(result.failures).toEqual([
      { adapterId: 'acme.vandal', required: false, reason: 'threw' },
    ]);
  });

  it('tells each classifier the scope, org and agent, and gives it a signal', async () => {
    const classify = vi.fn(() => Promise.resolve([]));
    seam.init.mockImplementation(() =>
      registerSensitivityClassifier(classifier('acme.x', { classify }))
    );
    await runSensitivityClassifiers(input, { scopeId: 's', orgId: 'o', agentId: 'a' });
    expect(classify).toHaveBeenCalledWith(
      input,
      expect.objectContaining({
        scopeId: 's',
        orgId: 'o',
        agentId: 'a',
        signal: expect.any(AbortSignal),
      })
    );
  });

  it('finds nothing and reports nothing when none is registered', async () => {
    expect(await runSensitivityClassifiers(input, { scopeId: 's' })).toEqual({
      categories: [],
      failures: [],
    });
  });
});

describe('running in-house only', () => {
  it('leaves out external classifiers and runs the rest', async () => {
    const cloud = vi.fn(() => Promise.resolve([{ category: 'health' }]));
    seam.init.mockImplementation(() => {
      registerSensitivityClassifier(
        classifier('acme.cloud', { egress: 'external', classify: cloud })
      );
      registerSensitivityClassifier(reporting('acme.box', { deal: 'commercial' }, ['deal']));
      registerSensitivityClassifier(
        classifier('acme.selfhosted', {
          egress: 'self_hosted',
          categories: { not_public: 'commercial' },
          classify: () => Promise.resolve([{ category: 'not_public' }]),
        })
      );
    });
    const result = await runSensitivityClassifiers(input, { scopeId: 's', inHouseOnly: true });
    expect(cloud).not.toHaveBeenCalled();
    expect(result.categories.map((c) => c.category)).toEqual(['deal', 'not_public']);
  });
});
