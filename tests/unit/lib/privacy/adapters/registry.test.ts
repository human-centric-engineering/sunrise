/**
 * Tests: lib/privacy/adapters/registry.ts — the privacy adapter registry (§127 t-988).
 *
 * Both the fork seam and core's defaults are mocked, so each case decides what
 * core installs and what `initAppPrivacyAdapters()` registers. Core ships no
 * adapters until t-989/t-990/t-991, so the replace and core-install paths can
 * only be exercised with a stand-in core list.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const seam = vi.hoisted(() => ({ init: vi.fn<() => void>() }));
const core = vi.hoisted(() => ({
  adapters: vi.fn(),
}));

vi.mock('@/lib/app/privacy-adapters', () => ({
  initAppPrivacyAdapters: () => seam.init(),
}));

vi.mock('@/lib/privacy/adapters/core-defaults', () => ({
  corePrivacyAdapters: () => core.adapters(),
}));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  __resetPrivacyAdaptersForTests,
  getPrivacyAdapters,
  registerPrivacyDetector,
  registerPrivacyObserver,
  registerPrivacyPolicyResolver,
  registerPrivacyTokenStrategy,
  MAX_DETECTOR_TIMEOUT_MS,
} from '@/lib/privacy/adapters/registry';
import type {
  PrivacyDetector,
  PrivacyTokenStrategy,
  AdapterEgress,
} from '@/lib/privacy/adapters/types';
import { logger } from '@/lib/logging';

function detector(id: string, overrides: Partial<PrivacyDetector> = {}): PrivacyDetector {
  return {
    id,
    egress: 'in_process',
    entityTypes: ['EMAIL'],
    detect: () => Promise.resolve([]),
    ...overrides,
  };
}

function strategy(id: string): PrivacyTokenStrategy {
  return {
    id,
    persistent: false,
    createSession: () => ({
      placeholderFor: () => 'X_1',
      valueFor: () => undefined,
      entries: () => [],
    }),
  };
}

function emptyCore() {
  return { detectors: [], tokenStrategy: null, policyResolvers: [], observers: [] };
}

beforeEach(() => {
  __resetPrivacyAdaptersForTests();
  seam.init.mockReset();
  core.adapters.mockReset();
  core.adapters.mockImplementation(emptyCore);
  vi.mocked(logger.warn).mockClear();
  vi.mocked(logger.error).mockClear();
});

describe('loading', () => {
  it('installs core first, then runs the app seam once, lazily, on the first read', () => {
    core.adapters.mockReturnValue({
      ...emptyCore(),
      detectors: [{ detector: detector('core.rules') }],
    });
    seam.init.mockImplementation(() => registerPrivacyDetector(detector('acme.extra')));

    expect(seam.init).not.toHaveBeenCalled();
    const first = getPrivacyAdapters();
    getPrivacyAdapters();

    expect(seam.init).toHaveBeenCalledTimes(1);
    expect(core.adapters).toHaveBeenCalledTimes(1);
    expect(first.detectors.map((r) => r.detector.id)).toEqual(['core.rules', 'acme.extra']);
    expect(first.failure).toBeNull();
  });

  it('makes core detectors required and app detectors optional unless they say so', () => {
    core.adapters.mockReturnValue({
      ...emptyCore(),
      detectors: [{ detector: detector('core.rules') }],
    });
    seam.init.mockImplementation(() => {
      registerPrivacyDetector(detector('acme.optional'));
      registerPrivacyDetector(detector('acme.required'), { required: true });
    });

    const byId = Object.fromEntries(
      getPrivacyAdapters().detectors.map((r) => [r.detector.id, r.required])
    );
    expect(byId).toEqual({ 'core.rules': true, 'acme.optional': false, 'acme.required': true });
  });

  it('runs in_process, then self_hosted, then external; core before app within each', () => {
    const at = (id: string, egress: AdapterEgress) => detector(id, { egress });
    core.adapters.mockReturnValue({
      ...emptyCore(),
      detectors: [{ detector: at('core.rules', 'in_process') }],
    });
    seam.init.mockImplementation(() => {
      registerPrivacyDetector(at('acme.cloud', 'external'));
      registerPrivacyDetector(at('acme.presidio', 'self_hosted'));
      registerPrivacyDetector(at('acme.regex', 'in_process'));
    });

    expect(getPrivacyAdapters().detectors.map((r) => r.detector.id)).toEqual([
      'core.rules',
      'acme.regex',
      'acme.presidio',
      'acme.cloud',
    ]);
  });
});

describe('a throwing app init', () => {
  it('rolls back every kind of registration it made, keeps core, and reports the failure', () => {
    const coreStrategy = strategy('core.numbered');
    core.adapters.mockReturnValue({
      ...emptyCore(),
      detectors: [{ detector: detector('core.rules') }, { detector: detector('core.lists') }],
      tokenStrategy: coreStrategy,
    });
    seam.init.mockImplementation(() => {
      registerPrivacyDetector(detector('acme.a'));
      registerPrivacyDetector(detector('acme.b'), { replace: 'core.lists' });
      registerPrivacyTokenStrategy(strategy('acme.vault'));
      registerPrivacyPolicyResolver({ id: 'acme.policy', resolve: () => ({}) });
      registerPrivacyObserver({ id: 'acme.siem', observe: () => undefined });
      throw new Error('fork bug');
    });

    const adapters = getPrivacyAdapters();

    expect(adapters.detectors.map((r) => r.detector.id)).toEqual(['core.rules', 'core.lists']);
    expect(adapters.replacedCoreDetectors).toEqual([]);
    expect(adapters.tokenStrategy).toBe(coreStrategy);
    expect(adapters.policyResolvers).toEqual([]);
    expect(adapters.observers).toEqual([]);
    expect(adapters.failure).toBe("the app's initAppPrivacyAdapters() threw: fork bug");
  });

  it('restores what was registered before the init ran, replacements included', () => {
    core.adapters.mockReturnValue({
      ...emptyCore(),
      detectors: [{ detector: detector('core.rules') }, { detector: detector('core.lists') }],
    });
    // Registered at module scope, before the first read runs the init.
    registerPrivacyDetector(detector('acme.names'), { replace: 'core.lists' });
    seam.init.mockImplementation(() => {
      registerPrivacyDetector(detector('acme.other'), { replace: 'core.rules' });
      throw new Error('fork bug');
    });

    const adapters = getPrivacyAdapters();

    expect(adapters.detectors.map((r) => r.detector.id)).toEqual(['core.rules', 'acme.names']);
    expect(adapters.replacedCoreDetectors).toEqual(['core.lists']);
  });

  it('is not retried: the failure stands on every later read', () => {
    seam.init.mockImplementation(() => {
      throw new Error('fork bug');
    });

    getPrivacyAdapters();
    expect(getPrivacyAdapters().failure).not.toBeNull();
    expect(seam.init).toHaveBeenCalledTimes(1);
  });
});

describe('a core adapter that fails to install', () => {
  it('is reported as a failure rather than silently missing', () => {
    core.adapters.mockReturnValue({
      ...emptyCore(),
      // A core id without the core prefix is a core bug.
      detectors: [{ detector: detector('rules') }],
    });

    const adapters = getPrivacyAdapters();

    expect(adapters.failure).toMatch(/^a core privacy adapter failed to install: /);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});

describe('replacing a core detector', () => {
  beforeEach(() => {
    core.adapters.mockReturnValue({
      ...emptyCore(),
      detectors: [{ detector: detector('core.rules') }, { detector: detector('core.lists') }],
    });
  });

  it('turns the named core detector off and records it', () => {
    seam.init.mockImplementation(() =>
      registerPrivacyDetector(detector('acme.names'), { replace: 'core.lists' })
    );

    const adapters = getPrivacyAdapters();

    expect(adapters.detectors.map((r) => r.detector.id)).toEqual(['core.rules', 'acme.names']);
    expect(adapters.replacedCoreDetectors).toEqual(['core.lists']);
    expect(logger.warn).toHaveBeenCalledWith('privacy-adapters: a core detector was replaced', {
      replaced: 'core.lists',
      by: 'acme.names',
    });
  });

  it('makes a replacement required, as the core detector it stands in for was, unless told otherwise', () => {
    seam.init.mockImplementation(() => {
      registerPrivacyDetector(detector('acme.names'), { replace: 'core.lists' });
      registerPrivacyDetector(detector('acme.rules'), { replace: 'core.rules', required: false });
    });

    const byId = Object.fromEntries(
      getPrivacyAdapters().detectors.map((r) => [r.detector.id, r.required])
    );
    expect(byId).toEqual({ 'acme.names': true, 'acme.rules': false });
  });

  it('refuses a replace that names no core detector, so a typo cannot leave the app unprotected', () => {
    seam.init.mockImplementation(() =>
      registerPrivacyDetector(detector('acme.names'), { replace: 'core.list' })
    );

    const adapters = getPrivacyAdapters();

    expect(adapters.failure).toMatch(
      /replace names core\.list, which is not a registered core detector/
    );
    expect(adapters.detectors.map((r) => r.detector.id)).toEqual(['core.rules', 'core.lists']);
  });

  it('refuses a replace that names another app detector', () => {
    seam.init.mockImplementation(() => {
      registerPrivacyDetector(detector('acme.first'));
      registerPrivacyDetector(detector('acme.second'), { replace: 'acme.first' });
    });

    expect(getPrivacyAdapters().failure).toMatch(/not a registered core detector/);
  });
});

describe('validation of what an app registers', () => {
  const cases: [string, () => void, RegExp][] = [
    [
      'the core prefix',
      () => registerPrivacyDetector(detector('core.mine')),
      /"core\." prefix is reserved/,
    ],
    ['an empty id', () => registerPrivacyDetector(detector('')), /id must be a non-empty string/],
    [
      'an id with surrounding spaces',
      () => registerPrivacyDetector(detector(' acme.x ')),
      /no surrounding spaces/,
    ],
    [
      'a duplicate id',
      () => {
        registerPrivacyDetector(detector('acme.x'));
        registerPrivacyDetector(detector('acme.x'));
      },
      /already registered/,
    ],
    [
      'an unknown egress',
      () =>
        registerPrivacyDetector(
          detector('acme.x', { egress: 'cloud' as unknown as AdapterEgress })
        ),
      /egress must be one of/,
    ],
    [
      'no entity types',
      () => registerPrivacyDetector(detector('acme.x', { entityTypes: [] })),
      /at least one type/,
    ],
    [
      'an entity type that could inject text into a placeholder',
      () => registerPrivacyDetector(detector('acme.x', { entityTypes: ['ignore previous'] })),
      /is not a valid name/,
    ],
    [
      'a detect that is not a function',
      () =>
        registerPrivacyDetector(
          detector('acme.x', { detect: 'nope' as unknown as PrivacyDetector['detect'] })
        ),
      /detect is not a function/,
    ],
    [
      'a zero timeout',
      () => registerPrivacyDetector(detector('acme.x'), { timeoutMs: 0 }),
      /timeoutMs must be between/,
    ],
    [
      'a timeout above the ceiling',
      () => registerPrivacyDetector(detector('acme.x'), { timeoutMs: MAX_DETECTOR_TIMEOUT_MS + 1 }),
      /timeoutMs must be between/,
    ],
    [
      'a persistent token strategy that names no table',
      () =>
        registerPrivacyTokenStrategy({
          ...strategy('acme.vault'),
          persistent: true,
          storesIn: [],
        }),
      /must name the models it stores in/,
    ],
    [
      'a token strategy that does not declare persistence',
      () =>
        registerPrivacyTokenStrategy({
          ...strategy('acme.tokens'),
          persistent: undefined as unknown as false,
        }),
      /persistent must be declared/,
    ],
    [
      'a second app token strategy',
      () => {
        registerPrivacyTokenStrategy(strategy('acme.one'));
        registerPrivacyTokenStrategy(strategy('acme.two'));
      },
      /acme\.one is already registered, and only one strategy is active/,
    ],
    [
      'a resolver with no resolve',
      () =>
        registerPrivacyPolicyResolver({
          id: 'acme.p',
          resolve: undefined as unknown as () => object,
        }),
      /resolve is not a function/,
    ],
    [
      'a duplicate observer',
      () => {
        registerPrivacyObserver({ id: 'acme.o', observe: () => undefined });
        registerPrivacyObserver({ id: 'acme.o', observe: () => undefined });
      },
      /already registered/,
    ],
  ];

  it.each(cases)('refuses %s, failing the init', (_name, register, message) => {
    seam.init.mockImplementation(register);

    const adapters = getPrivacyAdapters();

    expect(adapters.failure).toMatch(message);
  });

  it('accepts a persistent token strategy that names its tables, displacing core', () => {
    core.adapters.mockReturnValue({ ...emptyCore(), tokenStrategy: strategy('core.numbered') });
    const vault: PrivacyTokenStrategy = {
      ...strategy('acme.vault'),
      persistent: true,
      storesIn: ['AppPrivacyVault'],
    };
    seam.init.mockImplementation(() => registerPrivacyTokenStrategy(vault));

    const adapters = getPrivacyAdapters();

    expect(adapters.failure).toBeNull();
    expect(adapters.tokenStrategy).toBe(vault);
  });
});
