/**
 * Tests: the privacy stage the provider-manager Proxy runs on every chat and
 * embedding call (§127): `off` and `detect` here; the masking modes, `block`
 * and the embeddings policy in `privacy-stage.masking.test.ts`.
 *
 * The registry and Sunrise's own detectors are real, so detection is the real
 * thing. The app seam is a stand-in each case fills (or makes throw), and the
 * settings read is stubbed, because the stage reads the mode from it.
 *
 * @see lib/orchestration/llm/privacy-stage.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const seam = vi.hoisted(() => ({ init: vi.fn<() => void>() }));
const core = vi.hoisted(() => ({ fail: false }));
const settings = vi.hoisted(() => ({
  read: vi.fn<() => Promise<Record<string, unknown>>>(),
}));

// The agent's mode and the org's minimum (t-1010): neither set here.
vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiAgent: { findUnique: vi.fn(async () => null) },
    org: { findUnique: vi.fn(async () => null) },
  },
}));
vi.mock('@/lib/app/privacy-adapters', () => ({
  initAppPrivacyAdapters: () => seam.init(),
}));
vi.mock('@/lib/privacy/adapters/core-defaults', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/privacy/adapters/core-defaults')>();
  return {
    ...real,
    corePrivacyAdapters: () => {
      if (core.fail) throw new Error('core install failed');
      return real.corePrivacyAdapters();
    },
  };
});
vi.mock('@/lib/orchestration/settings', () => ({
  getOrchestrationSettings: () => settings.read(),
}));
vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { logger } from '@/lib/logging';
import { applyPrivacyStage, PrivacyRefusedError } from '@/lib/orchestration/llm/privacy-stage';
import { isRequestFault, ProviderError } from '@/lib/orchestration/llm/provider';
import type { LlmMessage } from '@/lib/orchestration/llm/types';
import {
  createPrivacyScope,
  privacySummary,
  runInPrivacyScope,
  type PrivacyScope,
} from '@/lib/orchestration/privacy/scope';
import {
  __resetPrivacyAdaptersForTests,
  registerPrivacyDetector,
  registerPrivacyObserver,
  registerPrivacyPolicyResolver,
} from '@/lib/privacy/adapters/registry';
import type { PrivacyEvent, PrivacyPolicy } from '@/lib/privacy/adapters/types';

// Values a real detector finds, and that must never reach a log line.
const EMAIL = 'priya.sharma@example.com';
const NINO = 'TJ 33 15 36 A';
const PHONE = '07911 123456';
const NAME = 'Priya Sharma';

function messages(): LlmMessage[] {
  return [
    { role: 'system', content: 'You are a helpful support agent.' },
    { role: 'user', content: `Hi, I'm ${NAME}. My email is ${EMAIL} and my NI number is ${NINO}.` },
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 't1', name: 'lookup', arguments: { phone: PHONE, nested: { n: 1 } } }],
    },
    { role: 'tool', content: '{"found":true}', toolCallId: 't1' },
  ];
}

function mode(privacyMode: unknown, extra: Record<string, unknown> = {}) {
  settings.read.mockResolvedValue({
    privacyMode,
    privacyIgnoredEntityTypes: ['DATE', 'LOCATION'],
    privacyProtectLocalProviders: false,
    ...extra,
  });
}

function chatCall(args: unknown[] = [messages(), { model: 'm' }], isLocal = false) {
  return { providerSlug: 'openai', isLocal, coverage: 'full' as const, args };
}

async function inScope<T>(fn: () => Promise<T>): Promise<{ result: T; scope: PrivacyScope }> {
  const scope = createPrivacyScope({ scopeId: 'conversation:c1', agentId: 'agent-1' });
  const result = await runInPrivacyScope(scope, fn);
  return { result, scope };
}

async function refusal(promise: Promise<unknown>): Promise<PrivacyRefusedError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e
  );
  if (!(err instanceof PrivacyRefusedError))
    throw new Error(`expected a refusal, got ${String(err)}`);
  return err;
}

/** Every argument any log call was given, as one string. */
function allLogged(): string {
  return JSON.stringify(
    [logger.info, logger.warn, logger.error, logger.debug].flatMap((fn) => vi.mocked(fn).mock.calls)
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetPrivacyAdaptersForTests();
  seam.init.mockImplementation(() => undefined);
  core.fail = false;
  mode('detect');
});

describe('mode off', () => {
  it('hands back the very arguments it was given, scans nothing and tells no observer', async () => {
    mode('off');
    const observe = vi.fn();
    seam.init.mockImplementation(() => registerPrivacyObserver({ id: 'app.obs', observe }));
    const args = [messages(), { model: 'm' }];
    const before = structuredClone(args);

    const { result, scope } = await inScope(() => applyPrivacyStage(chatCall(args)));

    expect(result.args).toBe(args);
    expect(result.restorer).toBeUndefined();
    expect(args).toEqual(before);
    expect(privacySummary(scope)).toBeUndefined();
    await new Promise((r) => setTimeout(r, 0));
    expect(observe).not.toHaveBeenCalled();
  });

  it('refuses settings with no privacy mode at all, rather than guess one', async () => {
    // `hydrateSettings` gives every real row a mode; only a malformed settings
    // object lacks one, and the stage does not read that as off.
    settings.read.mockResolvedValue({ globalMonthlyBudgetUsd: null });
    expect((await refusal(applyPrivacyStage(chatCall()))).reason).toBe('settings_unreadable');
  });

  it('still lets a resolver raise the mode', async () => {
    mode('off');
    seam.init.mockImplementation(() =>
      registerPrivacyPolicyResolver({ id: 'app.raise', resolve: () => ({ mode: 'detect' }) })
    );
    const { scope } = await inScope(() => applyPrivacyStage(chatCall()));
    expect(privacySummary(scope)?.mode).toBe('detect');
  });
});

describe('mode detect', () => {
  it('sends the arguments unchanged and records per-type counts in the scope', async () => {
    const args = [messages(), { model: 'm' }];
    const before = structuredClone(args);

    const { result, scope } = await inScope(() => applyPrivacyStage(chatCall(args)));

    expect(result.args).toBe(args);
    expect(result.restorer).toBeUndefined();
    expect(args).toEqual(before);
    const summary = privacySummary(scope);
    expect(summary).toMatchObject({ mode: 'detect', calls: 1, embeddingCalls: 0 });
    // The email and NI number in the user's message, and the phone number
    // inside a tool call's arguments.
    expect(summary?.counts).toMatchObject({ EMAIL: 1, UK_NINO: 1, PHONE: 1 });
  });

  it('tells observers the counts and ids only', async () => {
    const events: PrivacyEvent[] = [];
    seam.init.mockImplementation(() =>
      registerPrivacyObserver({ id: 'app.obs', observe: (e) => void events.push(e) })
    );
    await inScope(() => applyPrivacyStage(chatCall()));
    await new Promise((r) => setTimeout(r, 0));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      scopeId: 'conversation:c1',
      agentId: 'agent-1',
      providerSlug: 'openai',
      mode: 'detect',
      outcome: 'sent',
      degraded: false,
    });
    const sent = JSON.stringify(events);
    for (const value of [EMAIL, NINO, PHONE, NAME]) expect(sent).not.toContain(value);
  });

  it('counts an embedding call apart from chat calls', async () => {
    const { scope } = await inScope(async () => {
      await applyPrivacyStage({
        providerSlug: 'voyage',
        isLocal: false,
        coverage: 'count',
        args: [[`Contact ${EMAIL}`, 'nothing here'], { model: 'e' }],
      });
      return applyPrivacyStage({
        providerSlug: 'voyage',
        isLocal: false,
        coverage: 'count',
        args: [`Call ${PHONE}`],
      });
    });
    expect(privacySummary(scope)).toMatchObject({
      calls: 0,
      embeddingCalls: 2,
      embeddingCounts: { EMAIL: 1, PHONE: 1 },
    });
  });

  it('leaves alone the types the settings ignore', async () => {
    mode('detect', { privacyIgnoredEntityTypes: ['EMAIL'] });
    const { scope } = await inScope(() => applyPrivacyStage(chatCall()));
    const counts = privacySummary(scope)?.counts ?? {};
    expect(counts.EMAIL).toBeUndefined();
    expect(counts.UK_NINO).toBe(1);
  });

  it("uses the scope's known values, loaded only once a call is scanned", async () => {
    const load = vi.fn(async () => [{ type: 'PERSON', value: 'Wojciech Brzęczyszczykiewicz' }]);
    const scope = createPrivacyScope({ scopeId: 's', loadKnownValues: load });
    mode('off');
    await runInPrivacyScope(scope, () => applyPrivacyStage(chatCall()));
    expect(load).not.toHaveBeenCalled();

    mode('detect');
    const text = 'Please pass this to Wojciech Brzęczyszczykiewicz today.';
    await runInPrivacyScope(scope, () =>
      applyPrivacyStage(chatCall([[{ role: 'user', content: text }], { model: 'm' }]))
    );
    expect(load).toHaveBeenCalledOnce();
    expect(privacySummary(scope)?.counts.PERSON).toBe(1);
  });

  it('works with no scope at all, on an ephemeral one that records nowhere', async () => {
    const args = [messages(), { model: 'm' }];
    await expect(applyPrivacyStage(chatCall(args))).resolves.toEqual({ args });
  });

  it('skips the scan when nothing would read it: no scope, no observer, no block policy', async () => {
    const detect = vi.fn(async () => []);
    const detector = {
      id: 'app.spy',
      egress: 'in_process' as const,
      entityTypes: ['PERSON'],
      detect,
    };
    seam.init.mockImplementation(() => registerPrivacyDetector(detector));
    await applyPrivacyStage(chatCall());
    expect(detect).not.toHaveBeenCalled();

    // An observer, or a scope, is something that reads it.
    __resetPrivacyAdaptersForTests();
    seam.init.mockImplementation(() => {
      registerPrivacyDetector(detector);
      registerPrivacyObserver({ id: 'app.obs', observe: () => undefined });
    });
    await applyPrivacyStage(chatCall());
    expect(detect).toHaveBeenCalledTimes(1);
    __resetPrivacyAdaptersForTests();
    seam.init.mockImplementation(() => registerPrivacyDetector(detector));
    await inScope(() => applyPrivacyStage(chatCall()));
    expect(detect).toHaveBeenCalledTimes(2);
  });

  it('stops the scan when the caller abandons the call, and throws the abort: neither counted nor refused', async () => {
    const caller = new AbortController();
    const events: PrivacyEvent[] = [];
    seam.init.mockImplementation(() => {
      registerPrivacyObserver({ id: 'app.obs', observe: (e) => void events.push(e) });
      registerPrivacyDetector(
        {
          id: 'app.slow',
          egress: 'in_process',
          entityTypes: ['PERSON'],
          detect: (_input, ctx) =>
            new Promise((_resolve, reject) => {
              ctx.signal.addEventListener('abort', () => reject(new Error('aborted')));
              caller.abort();
            }),
        },
        { required: true }
      );
      // Even a policy that refuses on a failed detector: a cancel is not one.
      registerPrivacyPolicyResolver({
        id: 'app.strict',
        resolve: () => ({ onDetectorFailure: 'block' }),
      });
    });
    const args = [messages(), { model: 'm', signal: caller.signal }];
    const started = Date.now();

    const { result, scope } = await inScope(() =>
      applyPrivacyStage(chatCall(args)).then(
        () => 'handed back',
        (e: unknown) => e
      )
    );

    expect(Date.now() - started).toBeLessThan(900);
    // A cancel: the abort every provider throws, never the unscanned
    // arguments, and never a refusal.
    expect(result).toBeInstanceOf(ProviderError);
    expect(result).toMatchObject({ code: 'aborted' });
    expect(result).not.toBeInstanceOf(PrivacyRefusedError);
    expect(privacySummary(scope)).toBeUndefined();
    await new Promise((r) => setTimeout(r, 0));
    expect(events).toEqual([]);
    expect(logger.warn).not.toHaveBeenCalledWith(
      'privacy-stage: refusing a provider call',
      expect.anything()
    );
  });
});

describe('local providers', () => {
  it('are skipped unless the policy protects them', async () => {
    const events: PrivacyEvent[] = [];
    seam.init.mockImplementation(() =>
      registerPrivacyObserver({ id: 'app.obs', observe: (e) => void events.push(e) })
    );
    const { scope } = await inScope(() => applyPrivacyStage(chatCall(undefined, true)));
    expect(privacySummary(scope)).toBeUndefined();
    await new Promise((r) => setTimeout(r, 0));
    expect(events.map((e) => e.outcome)).toEqual(['skipped']);
  });

  it('are scanned when the settings protect them', async () => {
    mode('detect', { privacyProtectLocalProviders: true });
    const { scope } = await inScope(() => applyPrivacyStage(chatCall(undefined, true)));
    expect(privacySummary(scope)?.counts.EMAIL).toBe(1);
  });
});

describe('refusals', () => {
  it('refuses every call while the app init has failed, mode off and local providers included', async () => {
    mode('off');
    seam.init.mockImplementation(() => {
      throw new Error('app init broke');
    });
    const err = await refusal(applyPrivacyStage(chatCall(undefined, true)));
    expect(err.reason).toBe('app_init_failed');
    expect(isRequestFault(err)).toBe(true);
  });

  it('refuses every call while a core adapter failed to install, mode off included', async () => {
    mode('off');
    core.fail = true;
    expect((await refusal(applyPrivacyStage(chatCall()))).reason).toBe('core_install_failed');
  });

  it('refuses when the stored mode is not a mode', async () => {
    mode(null);
    expect((await refusal(applyPrivacyStage(chatCall()))).reason).toBe('settings_unreadable');
  });

  it('refuses when the settings cannot be read at all', async () => {
    settings.read.mockRejectedValue(new Error('db down'));
    expect((await refusal(applyPrivacyStage(chatCall()))).reason).toBe('stage_error');
  });

  it('refuses when a policy resolver fails, even in mode off', async () => {
    mode('off');
    seam.init.mockImplementation(() =>
      registerPrivacyPolicyResolver({
        id: 'app.broken',
        resolve: () => {
          throw new Error('resolver broke');
        },
      })
    );
    expect((await refusal(applyPrivacyStage(chatCall()))).reason).toBe('policy_resolver_failed');
  });

  it('only ever counts an embedding call, whatever the mode', async () => {
    seam.init.mockImplementation(() =>
      registerPrivacyPolicyResolver({
        id: 'app.strict',
        resolve: (): Partial<PrivacyPolicy> => ({ mode: 'block' }),
      })
    );
    const args = [[`${NAME} ${EMAIL}`]];
    const { result, scope } = await inScope(() =>
      applyPrivacyStage({ providerSlug: 'voyage', isLocal: false, coverage: 'count', args })
    );
    expect(result.args).toBe(args);
    expect(privacySummary(scope)).toMatchObject({ mode: 'block', embeddingCalls: 1, calls: 0 });
    expect(privacySummary(scope)?.embeddingCounts.EMAIL).toBe(1);
  });

  it('goes ahead, degraded, when a detector fails and the policy falls back', async () => {
    seam.init.mockImplementation(() =>
      registerPrivacyDetector(
        {
          id: 'app.flaky',
          egress: 'in_process',
          entityTypes: ['PERSON'],
          detect: () => Promise.reject(new Error(`could not scan ${EMAIL}`)),
        },
        { required: true }
      )
    );
    const args = [messages(), { model: 'm' }];
    const { result, scope } = await inScope(() => applyPrivacyStage(chatCall(args)));
    expect(result.args).toBe(args);
    expect(result.restorer).toBeUndefined();
    expect(privacySummary(scope)).toMatchObject({ degraded: true, failedAdapters: ['app.flaky'] });
    expect(privacySummary(scope)?.counts.EMAIL).toBe(1);
  });

  it('refuses when a required detector fails and the policy says block', async () => {
    seam.init.mockImplementation(() => {
      registerPrivacyDetector(
        {
          id: 'app.flaky',
          egress: 'in_process',
          entityTypes: ['PERSON'],
          detect: () => Promise.reject(new Error('down')),
        },
        { required: true }
      );
      registerPrivacyPolicyResolver({
        id: 'app.strict',
        resolve: () => ({ onDetectorFailure: 'block' }),
      });
    });
    expect((await refusal(applyPrivacyStage(chatCall()))).reason).toBe('detector_failed');
  });

  it('tells observers about a refusal, with no counts', async () => {
    const events: PrivacyEvent[] = [];
    mode(null);
    seam.init.mockImplementation(() =>
      registerPrivacyObserver({ id: 'app.obs', observe: (e) => void events.push(e) })
    );
    await refusal(applyPrivacyStage(chatCall()));
    await new Promise((r) => setTimeout(r, 0));
    // An unreadable mode has no mode to report, so no event: the log has it.
    expect(events).toEqual([]);

    mode('detect');
    __resetPrivacyAdaptersForTests();
    seam.init.mockImplementation(() => {
      registerPrivacyObserver({ id: 'app.obs', observe: (e) => void events.push(e) });
      registerPrivacyPolicyResolver({ id: 'app.strict', resolve: () => ({ mode: 'block' }) });
    });
    await refusal(applyPrivacyStage(chatCall()));
    await new Promise((r) => setTimeout(r, 0));
    expect(events).toEqual([expect.objectContaining({ outcome: 'refused', counts: {} })]);
  });
});

describe('a cancel while the policy resolvers run', () => {
  it('throws the abort rather than hand back a call whose policy it never finished', async () => {
    const caller = new AbortController();
    const events: PrivacyEvent[] = [];
    seam.init.mockImplementation(() => {
      registerPrivacyObserver({ id: 'app.obs', observe: (e) => void events.push(e) });
      registerPrivacyPolicyResolver({
        id: 'app.slow',
        resolve: () => {
          caller.abort();
          return new Promise<undefined>(() => undefined);
        },
      });
    });
    const args = [messages(), { model: 'm', signal: caller.signal }];

    const { result, scope } = await inScope(() =>
      applyPrivacyStage(chatCall(args)).then(
        () => 'handed back',
        (e: unknown) => e
      )
    );

    // Thrown even in `detect`: the resolver that would have raised the mode
    // may be the one the cancel cut short.
    expect(result).toBeInstanceOf(ProviderError);
    expect(result).toMatchObject({ code: 'aborted' });
    expect(result).not.toBeInstanceOf(PrivacyRefusedError);
    expect(privacySummary(scope)).toBeUndefined();
    await new Promise((r) => setTimeout(r, 0));
    expect(events).toEqual([]);
  });
});

describe('what a refusal says', () => {
  it("tells the reader only that it stopped, and puts the operator's remedy in the log", async () => {
    seam.init.mockImplementation(() => {
      throw new Error('app init broke');
    });
    const err = await refusal(applyPrivacyStage(chatCall()));
    // A workflow executor copies the message to the SSE client.
    expect(err.message).not.toMatch(/initAppPrivacyAdapters|lib\/app|server log/);
    expect(logger.warn).toHaveBeenCalledWith(
      'privacy-stage: refusing a provider call',
      expect.objectContaining({
        reason: 'app_init_failed',
        remedy: expect.stringContaining('initAppPrivacyAdapters'),
      })
    );
  });
});

describe('the pass deadline', () => {
  it('starts after the known values are loaded, so a slow lookup cannot spend it', async () => {
    const order: string[] = [];
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    timeout.mockImplementation(() => {
      order.push('deadline');
      return new AbortController().signal;
    });
    const scope = createPrivacyScope({
      scopeId: 's',
      loadKnownValues: async () => {
        await new Promise((r) => setTimeout(r, 5));
        order.push('known values loaded');
        return [];
      },
    });
    try {
      await runInPrivacyScope(scope, () => applyPrivacyStage(chatCall()));
    } finally {
      timeout.mockRestore();
    }
    expect(order.indexOf('known values loaded')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('known values loaded')).toBeLessThan(order.indexOf('deadline'));
  });
});

describe('logging', () => {
  it('never writes a detected value to any log line, on any path', async () => {
    seam.init.mockImplementation(() =>
      registerPrivacyDetector({
        id: 'app.flaky',
        egress: 'in_process',
        entityTypes: ['PERSON'],
        detect: () => Promise.reject(new Error(`could not scan ${EMAIL} ${NINO}`)),
      })
    );
    await inScope(() => applyPrivacyStage(chatCall()));
    mode(null);
    await refusal(applyPrivacyStage(chatCall()));
    settings.read.mockRejectedValue(new Error(`settings for ${EMAIL} unreadable`));
    await refusal(applyPrivacyStage(chatCall()));

    // The paths above did log: a check on an empty log proves nothing.
    expect(vi.mocked(logger.warn).mock.calls.length).toBeGreaterThan(0);
    expect(vi.mocked(logger.error).mock.calls.length).toBeGreaterThan(0);
    const logged = allLogged();
    for (const value of [EMAIL, NINO, PHONE, NAME, 'Priya']) expect(logged).not.toContain(value);
  });
});
