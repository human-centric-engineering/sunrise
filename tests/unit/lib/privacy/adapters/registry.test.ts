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
    // Writes placeholders in the form restore reads, as the registry checks.
    createSession: () => {
      const values = new Map<string, string>();
      return {
        placeholderFor: (type: string, value: string) => {
          const placeholder = `[${type}_1]`;
          values.set(placeholder, value);
          return placeholder;
        },
        valueFor: (placeholder: string) => values.get(placeholder),
        entries: () => [],
      };
    },
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
    expect(first.appInitFailure).toBeNull();
    expect(first.coreFailure).toBeNull();
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
    expect(adapters.appInitFailure).toBe("the app's initAppPrivacyAdapters() threw: fork bug");
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
    expect(getPrivacyAdapters().appInitFailure).not.toBeNull();
    expect(seam.init).toHaveBeenCalledTimes(1);
  });
});

describe('replacement logs', () => {
  beforeEach(() => {
    core.adapters.mockReturnValue({
      ...emptyCore(),
      detectors: [{ detector: detector('core.lists') }],
      tokenStrategy: strategy('core.numbered'),
    });
  });

  it('says nothing was replaced when the init that replaced it was rolled back', () => {
    seam.init.mockImplementation(() => {
      registerPrivacyDetector(detector('acme.names'), { replace: 'core.lists' });
      registerPrivacyTokenStrategy(strategy('acme.tokens'));
      throw new Error('fork bug');
    });

    getPrivacyAdapters();

    expect(logger.warn).not.toHaveBeenCalledWith(
      'privacy-adapters: a core detector was replaced',
      expect.anything()
    );
    expect(logger.info).not.toHaveBeenCalledWith(
      'privacy-adapters: token strategy replaced',
      expect.anything()
    );
  });

  it('reports each replacement once the init has succeeded', () => {
    seam.init.mockImplementation(() => {
      registerPrivacyDetector(detector('acme.names'), { replace: 'core.lists' });
      registerPrivacyTokenStrategy(strategy('acme.tokens'));
    });

    getPrivacyAdapters();

    expect(logger.warn).toHaveBeenCalledWith('privacy-adapters: a core detector was replaced', {
      replaced: 'core.lists',
      by: 'acme.names',
    });
    expect(logger.info).toHaveBeenCalledWith('privacy-adapters: token strategy replaced', {
      replaced: 'core.numbered',
      by: 'acme.tokens',
    });
  });
});

describe('what readers are given', () => {
  it('cannot be changed: registrations are frozen, so a reader cannot make a required detector optional', () => {
    core.adapters.mockReturnValue({
      ...emptyCore(),
      detectors: [{ detector: detector('core.rules') }],
    });
    seam.init.mockImplementation(() =>
      registerPrivacyPolicyResolver({ id: 'acme.p', resolve: () => ({}) }, { timeoutMs: 250 })
    );

    const [registration] = getPrivacyAdapters().detectors;
    const [resolver] = getPrivacyAdapters().policyResolvers;

    expect(() => {
      (registration as { required: boolean }).required = false;
    }).toThrow(TypeError);
    expect(() => {
      (registration.entityTypes as string[]).push('IBAN');
    }).toThrow(TypeError);
    expect(getPrivacyAdapters().detectors[0].required).toBe(true);
    expect(resolver.timeoutMs).toBe(250);
    expect(Object.isFrozen(resolver)).toBe(true);
  });
});

describe('what is checked is what is kept', () => {
  it('reads the validated id, egress and types, not the detector object it was handed', () => {
    const live = {
      id: 'acme.x',
      egress: 'in_process' as AdapterEgress,
      entityTypes: ['EMAIL'],
      detect: () => Promise.resolve([]),
    };
    seam.init.mockImplementation(() => {
      registerPrivacyDetector(live);
      registerPrivacyDetector(detector('acme.local'));
    });
    getPrivacyAdapters();

    // Changed after validation: none of it may reach the registry's view.
    live.id = 'core.rules';
    live.egress = 'external';
    live.entityTypes.push('IBAN');
    const [first] = getPrivacyAdapters().detectors;

    expect(first.id).toBe('acme.x');
    expect(first.egress).toBe('in_process');
    expect(first.entityTypes).toEqual(['EMAIL']);
    expect(getPrivacyAdapters().detectors.map((r) => r.id)).toEqual(['acme.x', 'acme.local']);
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

    expect(adapters.coreFailure).toMatch(/^a core privacy adapter failed to install: /);
    expect(adapters.appInitFailure).toBeNull();
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it('is not hidden when the app init then fails too', () => {
    core.adapters.mockReturnValue({
      ...emptyCore(),
      detectors: [{ detector: detector('rules') }],
    });
    // Typically because its replace names the core detector that never installed.
    seam.init.mockImplementation(() =>
      registerPrivacyDetector(detector('acme.names'), { replace: 'core.rules' })
    );

    const adapters = getPrivacyAdapters();

    expect(adapters.coreFailure).toMatch(/^a core privacy adapter failed to install: /);
    expect(adapters.appInitFailure).toMatch(/not a registered core detector/);
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

    expect(adapters.appInitFailure).toMatch(
      /replace names core\.list, which is not a registered core detector/
    );
    expect(adapters.detectors.map((r) => r.detector.id)).toEqual(['core.rules', 'core.lists']);
  });

  it('puts the replacement in the replaced detector\u2019s place, so it runs and ranks where that one did', () => {
    core.adapters.mockReturnValue({
      ...emptyCore(),
      detectors: [
        { detector: detector('core.a') },
        { detector: detector('core.b') },
        { detector: detector('core.c') },
      ],
    });
    seam.init.mockImplementation(() => {
      registerPrivacyDetector(detector('acme.extra'));
      registerPrivacyDetector(detector('acme.a'), { replace: 'core.a' });
    });

    expect(getPrivacyAdapters().detectors.map((r) => r.id)).toEqual([
      'acme.a',
      'core.b',
      'core.c',
      'acme.extra',
    ]);
  });

  it('refuses a replace that names another app detector', () => {
    seam.init.mockImplementation(() => {
      registerPrivacyDetector(detector('acme.first'));
      registerPrivacyDetector(detector('acme.second'), { replace: 'acme.first' });
    });

    expect(getPrivacyAdapters().appInitFailure).toMatch(/not a registered core detector/);
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
      'the reserved LITERAL type',
      () => registerPrivacyDetector(detector('acme.x', { entityTypes: ['LITERAL'] })),
      /LITERAL is reserved/,
    ],
    [
      'a token strategy that does not write [TYPE_n]',
      () =>
        registerPrivacyTokenStrategy({
          id: 'acme.odd',
          persistent: false,
          createSession: () => ({
            placeholderFor: () => '<<PERSON_1>>',
            valueFor: () => 'check',
            entries: () => [],
          }),
        }),
      /must be written as \[PERSON_1\]/,
    ],
    [
      'a token strategy that writes only some types as [TYPE_n]',
      () =>
        registerPrivacyTokenStrategy({
          id: 'acme.partial',
          persistent: false,
          createSession: () => ({
            placeholderFor: (type: string) => (type === 'PERSON' ? '[PERSON_1]' : `{${type}}`),
            valueFor: () => 'check',
            entries: () => [],
          }),
        }),
      /must be written as \[PERSON_1\]/,
    ],
    [
      'a token strategy whose placeholders do not map back',
      () =>
        registerPrivacyTokenStrategy({
          id: 'acme.forgetful',
          persistent: false,
          createSession: () => ({
            placeholderFor: () => '[PERSON_1]',
            valueFor: () => undefined,
            entries: () => [],
          }),
        }),
      /map back to their value/,
    ],
    [
      'a token strategy whose session cannot be created',
      () =>
        registerPrivacyTokenStrategy({
          id: 'acme.broken',
          persistent: false,
          createSession: () => {
            throw new Error('nope');
          },
        }),
      /creating a session failed/,
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
      'a required flag that is not a boolean',
      () =>
        registerPrivacyDetector(detector('acme.x'), { required: 'false' as unknown as boolean }),
      /required must be true or false/,
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
      'a persistent strategy whose flag answers differently on a second read',
      () => {
        let reads = 0;
        const shifty = {
          ...strategy('acme.shifty'),
          get persistent() {
            return reads++ === 0;
          },
        } as unknown as PrivacyTokenStrategy;
        registerPrivacyTokenStrategy(shifty);
      },
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
      'a resolver timeout of zero',
      () => registerPrivacyPolicyResolver({ id: 'acme.p', resolve: () => ({}) }, { timeoutMs: 0 }),
      /timeoutMs must be between/,
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

    expect(adapters.appInitFailure).toMatch(message);
  });

  it('does not try a persistent token strategy, whose sessions may write', () => {
    const createSession = vi.fn();
    registerPrivacyTokenStrategy({
      id: 'acme.vault',
      persistent: true,
      storesIn: ['AppVault'],
      createSession,
    });
    expect(createSession).not.toHaveBeenCalled();
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

    expect(adapters.appInitFailure).toBeNull();
    expect(adapters.tokenStrategy).toBe(vault);
  });
});
