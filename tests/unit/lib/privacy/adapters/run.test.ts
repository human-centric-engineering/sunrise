/**
 * Tests: lib/privacy/adapters/run.ts — running the adapters for one call
 * (§127 t-988).
 *
 * The real registry, with the fork seam mocked so each case registers the
 * adapters it needs. Core ships none yet, so every detector here is the
 * case's own.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const seam = vi.hoisted(() => ({ init: vi.fn<() => void>() }));

vi.mock('@/lib/app/privacy-adapters', () => ({
  initAppPrivacyAdapters: () => seam.init(),
}));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  __resetPrivacyAdaptersForTests,
  registerPrivacyDetector,
  registerPrivacyObserver,
  registerPrivacyPolicyResolver,
} from '@/lib/privacy/adapters/registry';
import {
  notifyPrivacyObservers,
  resolvePrivacyPolicy,
  runPrivacyDetectors,
} from '@/lib/privacy/adapters/run';
import type {
  DetectContext,
  DetectedSpan,
  PrivacyDetector,
  PrivacyEvent,
  PrivacyPolicy,
} from '@/lib/privacy/adapters/types';
import { logger } from '@/lib/logging';

const TEXT = 'Hi, I am Priya Shah, email priya@example.com.';
const EMAIL = { type: 'EMAIL', start: 27, end: 44, confidence: 1 };
const PERSON = { type: 'PERSON', start: 9, end: 19, confidence: 0.6 };
const CTX = { scopeId: 'conv-1', knownValues: [] };

function detector(
  id: string,
  detect: PrivacyDetector['detect'],
  entityTypes: string[] = ['EMAIL', 'PERSON']
): PrivacyDetector {
  return { id, egress: 'in_process', entityTypes, detect };
}

function returning(spans: DetectedSpan[]): PrivacyDetector['detect'] {
  return () => Promise.resolve(spans);
}

/** Every argument every logger method was called with, as one string. */
function everythingLogged(): string {
  const calls = [
    ...vi.mocked(logger.info).mock.calls,
    ...vi.mocked(logger.warn).mock.calls,
    ...vi.mocked(logger.error).mock.calls,
  ];
  return JSON.stringify(calls);
}

beforeEach(() => {
  __resetPrivacyAdaptersForTests();
  seam.init.mockReset();
  vi.mocked(logger.info).mockClear();
  vi.mocked(logger.warn).mockClear();
  vi.mocked(logger.error).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('runPrivacyDetectors', () => {
  it('merges what every detector found, validated and attributed', async () => {
    expect(TEXT.slice(EMAIL.start, EMAIL.end)).toBe('priya@example.com');
    expect(TEXT.slice(PERSON.start, PERSON.end)).toBe('Priya Shah');
    seam.init.mockImplementation(() => {
      registerPrivacyDetector(detector('acme.emails', returning([EMAIL])));
      registerPrivacyDetector(detector('acme.names', returning([PERSON])));
    });

    const result = await runPrivacyDetectors(TEXT, CTX);

    expect(result.failures).toEqual([]);
    expect(result.spans).toEqual([
      { ...PERSON, source: 'acme.names' },
      { ...EMAIL, source: 'acme.emails' },
    ]);
  });

  it('hands each detector what earlier ones found, frozen', async () => {
    let seen: DetectContext['priorSpans'] = [];
    seam.init.mockImplementation(() => {
      registerPrivacyDetector(detector('acme.first', returning([EMAIL])));
      registerPrivacyDetector(
        detector('acme.second', (_input, ctx) => {
          seen = ctx.priorSpans;
          return Promise.resolve([]);
        })
      );
    });

    await runPrivacyDetectors(TEXT, CTX);

    expect(seen).toEqual([{ ...EMAIL, source: 'acme.first' }]);
    expect(Object.isFrozen(seen)).toBe(true);
    expect(Object.isFrozen(seen[0])).toBe(true);
  });

  it('stops a detector from changing the known values the next one reads', async () => {
    const knownValues = [{ type: 'PERSON', value: 'Priya Shah' }];
    let secondSaw = '';
    seam.init.mockImplementation(() => {
      registerPrivacyDetector(
        detector('acme.vandal', (_input, ctx) => {
          (ctx.knownValues[0] as { value: string }).value = 'nobody';
          return Promise.resolve([]);
        })
      );
      registerPrivacyDetector(
        detector('acme.reader', (_input, ctx) => {
          secondSaw = ctx.knownValues[0].value;
          return Promise.resolve([]);
        })
      );
    });

    const result = await runPrivacyDetectors(TEXT, { ...CTX, knownValues });

    expect(result.failures).toEqual([
      { adapterId: 'acme.vandal', required: false, reason: 'threw' },
    ]);
    expect(secondSaw).toBe('Priya Shah');
    expect(knownValues[0].value).toBe('Priya Shah');
  });

  it('uses nothing from a malformed result and reports it, with its required flag', async () => {
    seam.init.mockImplementation(() => {
      registerPrivacyDetector(detector('acme.bad', returning([EMAIL, { ...PERSON, end: 999 }])), {
        required: true,
      });
    });

    const result = await runPrivacyDetectors(TEXT, CTX);

    expect(result.spans).toEqual([]);
    expect(result.failures).toEqual([
      { adapterId: 'acme.bad', required: true, reason: 'malformed' },
    ]);
  });

  it('reports a detector that throws, synchronously or not, and runs the rest', async () => {
    seam.init.mockImplementation(() => {
      registerPrivacyDetector(
        detector('acme.sync', () => {
          throw new Error('boom');
        })
      );
      registerPrivacyDetector(detector('acme.async', () => Promise.reject(new Error('boom'))));
      registerPrivacyDetector(detector('acme.ok', returning([EMAIL])));
    });

    const result = await runPrivacyDetectors(TEXT, CTX);

    expect(result.failures.map((f) => [f.adapterId, f.reason])).toEqual([
      ['acme.sync', 'threw'],
      ['acme.async', 'threw'],
    ]);
    expect(result.spans.map((s) => s.source)).toEqual(['acme.ok']);
  });

  it('times a detector out through its signal, and settles even when the detector ignores it', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    seam.init.mockImplementation(() => {
      registerPrivacyDetector(
        detector('acme.slow', (_input, ctx) => {
          signal = ctx.signal;
          return new Promise(() => undefined); // never settles, never listens
        }),
        { timeoutMs: 400 }
      );
      registerPrivacyDetector(detector('acme.ok', returning([EMAIL])));
    });

    const pending = runPrivacyDetectors(TEXT, CTX);
    await vi.advanceTimersByTimeAsync(399);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;

    expect(signal?.aborted).toBe(true);
    expect(result.failures).toEqual([
      { adapterId: 'acme.slow', required: false, reason: 'timeout' },
    ]);
    expect(result.spans.map((s) => s.source)).toEqual(['acme.ok']);
  });

  it('ignores a result that arrives after the timeout', async () => {
    vi.useFakeTimers();
    seam.init.mockImplementation(() => {
      registerPrivacyDetector(
        detector(
          'acme.late',
          () => new Promise((resolve) => setTimeout(() => resolve([EMAIL]), 600))
        ),
        { timeoutMs: 400 }
      );
    });

    const pending = runPrivacyDetectors(TEXT, CTX);
    await vi.advanceTimersByTimeAsync(1000);
    const result = await pending;

    expect(result.spans).toEqual([]);
    expect(result.failures[0].reason).toBe('timeout');
  });

  it('reports the rest as aborted, without running them, once the call is abandoned', async () => {
    const controller = new AbortController();
    const second = vi.fn(returning([EMAIL]));
    seam.init.mockImplementation(() => {
      registerPrivacyDetector(
        detector('acme.first', () => {
          controller.abort();
          return Promise.resolve([]);
        })
      );
      registerPrivacyDetector(detector('acme.second', second));
    });

    const result = await runPrivacyDetectors(TEXT, { ...CTX, signal: controller.signal });

    expect(second).not.toHaveBeenCalled();
    expect(result.failures).toEqual([
      { adapterId: 'acme.first', required: false, reason: 'aborted' },
      { adapterId: 'acme.second', required: false, reason: 'aborted' },
    ]);
  });

  it('never logs the text, a value found, or an adapter error message', async () => {
    seam.init.mockImplementation(() => {
      registerPrivacyDetector(
        detector('acme.leaky', () => Promise.reject(new Error(`could not parse ${TEXT}`)))
      );
      registerPrivacyDetector(detector('acme.bad', returning([{ ...EMAIL, type: 'PHONE' }])));
    });

    const result = await runPrivacyDetectors(TEXT, CTX);

    expect(result.failures).toHaveLength(2);
    expect(logger.warn).toHaveBeenCalledTimes(2);
    const logged = everythingLogged();
    expect(logged).not.toContain('Priya');
    expect(logged).not.toContain('priya@example.com');
    expect(logged).toContain('acme.leaky');
  });
});

const POLICY: PrivacyPolicy = {
  mode: 'detect',
  ignoredEntityTypes: ['DATE'],
  protectLocalProviders: false,
  onDetectorFailure: 'fallback',
};
const INPUT = { providerSlug: 'anthropic', isLocalProvider: false, agentId: 'hr-bot' };

describe('resolvePrivacyPolicy', () => {
  it('lets each resolver tighten the policy, and ignores any loosening', async () => {
    seam.init.mockImplementation(() => {
      registerPrivacyPolicyResolver({ id: 'acme.hr', resolve: () => ({ mode: 'redact' }) });
      registerPrivacyPolicyResolver({
        id: 'acme.loosener',
        resolve: () => ({ mode: 'off', ignoredEntityTypes: ['DATE', 'PERSON'] }),
      });
    });

    const result = await resolvePrivacyPolicy(POLICY, INPUT);

    expect(result.failures).toEqual([]);
    expect(result.policy).toEqual({ ...POLICY, mode: 'redact' });
  });

  it('gives each resolver the policy so far, frozen, so it cannot loosen it by mutation', async () => {
    seam.init.mockImplementation(() => {
      registerPrivacyPolicyResolver({
        id: 'acme.mutator',
        resolve: (_input, current) => {
          (current as { mode: string }).mode = 'off';
          return {};
        },
      });
    });

    const result = await resolvePrivacyPolicy(POLICY, INPUT);

    expect(result.policy.mode).toBe('detect');
    expect(result.failures).toEqual([
      { adapterId: 'acme.mutator', required: true, reason: 'threw' },
    ]);
  });

  it('reports a resolver that returns something that is not a policy', async () => {
    seam.init.mockImplementation(() => {
      registerPrivacyPolicyResolver({
        id: 'acme.typo',
        resolve: () => ({ modes: 'block' }) as unknown as Partial<PrivacyPolicy>,
      });
    });

    const result = await resolvePrivacyPolicy(POLICY, INPUT);

    expect(result.policy).toEqual(POLICY);
    expect(result.failures).toEqual([
      { adapterId: 'acme.typo', required: true, reason: 'malformed' },
    ]);
  });

  it('reports a resolver that throws or hangs', async () => {
    vi.useFakeTimers();
    seam.init.mockImplementation(() => {
      registerPrivacyPolicyResolver({
        id: 'acme.throws',
        resolve: () => {
          throw new Error('no');
        },
      });
      registerPrivacyPolicyResolver({
        id: 'acme.hangs',
        resolve: () => new Promise(() => undefined),
      });
    });

    const pending = resolvePrivacyPolicy(POLICY, INPUT);
    await vi.advanceTimersByTimeAsync(1000);
    const result = await pending;

    expect(result.failures.map((f) => [f.adapterId, f.reason])).toEqual([
      ['acme.throws', 'threw'],
      ['acme.hangs', 'timeout'],
    ]);
  });
});

const EVENT: PrivacyEvent = {
  scopeId: 'conv-1',
  providerSlug: 'anthropic',
  mode: 'pseudonymise',
  counts: { EMAIL: 1 },
  degraded: false,
  failedAdapters: [],
  outcome: 'sent',
};

describe('notifyPrivacyObservers', () => {
  it('returns at once, even when an observer never finishes', () => {
    const observe = vi.fn(() => new Promise<void>(() => undefined));
    seam.init.mockImplementation(() => registerPrivacyObserver({ id: 'acme.slow', observe }));

    expect(notifyPrivacyObservers(EVENT)).toBeUndefined();
  });

  it('gives every observer its own frozen copy and contains a failing one', async () => {
    const received: PrivacyEvent[] = [];
    seam.init.mockImplementation(() => {
      registerPrivacyObserver({
        id: 'acme.vandal',
        observe: (event) => {
          (event.counts as Record<string, number>).EMAIL = 0;
        },
      });
      registerPrivacyObserver({
        id: 'acme.throws',
        observe: () => {
          throw new Error('siem down');
        },
      });
      registerPrivacyObserver({ id: 'acme.reader', observe: (event) => void received.push(event) });
    });

    notifyPrivacyObservers(EVENT);
    await vi.waitFor(() => expect(received).toHaveLength(1));
    await vi.waitFor(() => expect(logger.warn).toHaveBeenCalledTimes(2));

    expect(received[0].counts).toEqual({ EMAIL: 1 });
    expect(EVENT.counts).toEqual({ EMAIL: 1 });
    expect(vi.mocked(logger.warn).mock.calls.map(([, ctx]) => ctx)).toEqual([
      { adapterId: 'acme.vandal', errorName: 'TypeError' },
      { adapterId: 'acme.throws', errorName: 'Error' },
    ]);
  });
});
