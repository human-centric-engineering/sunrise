/**
 * Tests: the privacy stage classifying calls for confidential content (§130
 * t-1036) — which calls it classifies, what it records, and that classifying
 * never changes what is sent.
 *
 * The registry, core's detectors and core's phrase classifier are real. The
 * app seam is a stand-in each case fills, and the settings read is stubbed.
 *
 * @see lib/orchestration/llm/privacy-stage.ts
 * @see .context/privacy/llm-privacy-layer.md — *Confidential content*
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const seam = vi.hoisted(() => ({ init: vi.fn<() => void>() }));
const settings = vi.hoisted(() => ({
  read: vi.fn<() => Promise<Record<string, unknown>>>(),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiAgent: { findUnique: vi.fn(async () => null) },
    org: { findUnique: vi.fn(async () => null) },
  },
}));
vi.mock('@/lib/app/privacy-adapters', () => ({
  initAppPrivacyAdapters: () => seam.init(),
}));
vi.mock('@/lib/orchestration/settings', () => ({
  getOrchestrationSettings: () => settings.read(),
}));
vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { logger } from '@/lib/logging';
import { applyPrivacyStage } from '@/lib/orchestration/llm/privacy-stage';
import { ProviderError } from '@/lib/orchestration/llm/provider';
import type { LlmMessage } from '@/lib/orchestration/llm/types';
import {
  agentPrivacyScope,
  createPrivacyScope,
  privacySummary,
  runInPrivacyScope,
  type PrivacyScope,
} from '@/lib/orchestration/privacy/scope';
import {
  __resetPrivacyAdaptersForTests,
  registerSensitivityClassifier,
} from '@/lib/privacy/adapters/registry';
import type { SensitivityClassifier, SensitivityInput } from '@/lib/privacy/adapters/types';

const HEALTH = "I've been signed off with depression, how do I tell my manager?";
const LAUNCH = "Write teaser copy for the S27, it's unannounced until March.";

function mode(privacyMode: unknown) {
  settings.read.mockResolvedValue({
    privacyMode,
    privacyIgnoredEntityTypes: ['DATE', 'LOCATION'],
    privacyProtectLocalProviders: false,
  });
}

function chat(user: string, extra: Partial<LlmMessage>[] = []): LlmMessage[] {
  return [
    { role: 'system', content: 'You are a helpful assistant.' },
    ...extra.map((m) => ({ role: 'user' as const, content: '', ...m })),
    { role: 'user', content: user },
  ];
}

function chatCall(args: unknown[], isLocal = false) {
  return { providerSlug: 'openai', isLocal, coverage: 'full' as const, args };
}

function embeddingCall(texts: string[]) {
  return { providerSlug: 'openai', isLocal: false, coverage: 'count' as const, args: [texts] };
}

function newScope(): PrivacyScope {
  return createPrivacyScope({ scopeId: 'conversation:c1', agentId: 'agent-1' });
}

/** An app classifier that records what it was handed and finds nothing. */
function spyClassifier(): { classifier: SensitivityClassifier; seen: SensitivityInput[] } {
  const seen: SensitivityInput[] = [];
  return {
    seen,
    classifier: {
      id: 'acme.spy',
      egress: 'in_process',
      categories: { acme_secret: 'commercial' },
      classify: (input) => {
        seen.push(input);
        return Promise.resolve([]);
      },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetPrivacyAdaptersForTests();
  seam.init.mockImplementation(() => undefined);
  mode('detect');
});

describe('classifying in mode off', () => {
  it('records what it found and hands back the very arguments it was given', async () => {
    mode('off');
    const args = [chat(HEALTH), { model: 'm' }];
    const before = structuredClone(args);
    const scope = newScope();

    const result = await runInPrivacyScope(scope, () => applyPrivacyStage(chatCall(args)));

    expect(result.args).toBe(args);
    expect(args).toEqual(before);
    expect(privacySummary(scope)).toEqual({
      mode: 'off',
      calls: 0,
      counts: {},
      embeddingCalls: 0,
      embeddingCounts: {},
      sensitivity: { personal: ['health'] },
    });
  });

  it('records nothing, and so writes no summary, when the call holds nothing confidential', async () => {
    mode('off');
    const scope = newScope();
    await runInPrivacyScope(scope, () =>
      applyPrivacyStage(chatCall([chat('What time is the standup?'), { model: 'm' }]))
    );
    expect(privacySummary(scope)).toBeUndefined();
  });
});

describe('what is classified', () => {
  it('records both groups, each sorted, beside the counts in detect', async () => {
    const scope = newScope();
    await runInPrivacyScope(scope, () =>
      applyPrivacyStage(
        chatCall([
          chat(`${LAUNCH} Also my colleague has a grievance about her ADHD diagnosis.`),
          { model: 'm' },
        ])
      )
    );
    const summary = privacySummary(scope);
    expect(summary?.mode).toBe('detect');
    expect(summary?.calls).toBe(1);
    expect(summary?.sensitivity).toEqual({
      personal: ['health', 'hr_matter'],
      commercial: ['not_public'],
    });
  });

  it('classifies a call to a local provider the masking skips', async () => {
    const scope = newScope();
    const args = [chat(HEALTH), { model: 'm' }];
    const result = await runInPrivacyScope(scope, () => applyPrivacyStage(chatCall(args, true)));
    expect(result.args).toBe(args);
    expect(privacySummary(scope)?.sensitivity).toEqual({ personal: ['health'] });
    // The masking did skip it: no call was scanned for personal data.
    expect(privacySummary(scope)?.calls).toBe(0);
  });

  it("leaves out what the user did not write: the system prompt, the model's turns, tool results and arguments", async () => {
    const scope = newScope();
    const messages: LlmMessage[] = [
      { role: 'system', content: 'Help staff with any grievance or depression they mention.' },
      { role: 'user', content: 'What time is the standup?' },
      {
        role: 'assistant',
        content: 'Our acquisition of Harbourside is confidential.',
        toolCalls: [{ id: 't1', name: 'note', arguments: { text: 'signed off with depression' } }],
      },
      { role: 'tool', content: 'The merger is under NDA.', toolCallId: 't1' },
    ];
    await runInPrivacyScope(scope, () => applyPrivacyStage(chatCall([messages, { model: 'm' }])));
    expect(privacySummary(scope)?.sensitivity).toBeUndefined();
  });

  it('hands an app classifier every part with its role, tool-call arguments excepted', async () => {
    const spy = spyClassifier();
    seam.init.mockImplementation(() => registerSensitivityClassifier(spy.classifier));
    const messages: LlmMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: [{ type: 'text', text: 'part one' }] },
      {
        role: 'assistant',
        content: 'reply',
        toolCalls: [{ id: 't1', name: 'n', arguments: { secret: 'argument text' } }],
      },
      { role: 'tool', content: 'result', toolCallId: 't1' },
    ];
    await runInPrivacyScope(newScope(), () =>
      applyPrivacyStage(chatCall([messages, { model: 'm' }]))
    );
    expect(spy.seen).toEqual([
      {
        parts: [
          { role: 'system', text: 'sys' },
          { role: 'user', text: 'part one' },
          { role: 'assistant', text: 'reply' },
          { role: 'tool', text: 'result' },
        ],
      },
    ]);
  });

  it('classifies an embedding call, its inputs as embedding parts', async () => {
    const spy = spyClassifier();
    seam.init.mockImplementation(() => registerSensitivityClassifier(spy.classifier));
    const scope = newScope();
    await runInPrivacyScope(scope, () =>
      applyPrivacyStage(embeddingCall(['signed off with depression', '']))
    );
    expect(spy.seen).toEqual([
      { parts: [{ role: 'embedding', text: 'signed off with depression' }] },
    ]);
    expect(privacySummary(scope)?.sensitivity).toEqual({ personal: ['health'] });
  });
});

describe('which calls are classified', () => {
  it('not a call outside any scope: nothing would read the result', async () => {
    const spy = spyClassifier();
    seam.init.mockImplementation(() => registerSensitivityClassifier(spy.classifier));
    await applyPrivacyStage(chatCall([chat(HEALTH), { model: 'm' }]));
    expect(spy.seen).toEqual([]);
  });

  it('not a call in a scope that records nowhere', async () => {
    const spy = spyClassifier();
    seam.init.mockImplementation(() => registerSensitivityClassifier(spy.classifier));
    const scope = createPrivacyScope({ scopeId: 'embed', agentId: 'a', recordsNowhere: true });
    await runInPrivacyScope(scope, () =>
      applyPrivacyStage(chatCall([chat(HEALTH), { model: 'm' }]))
    );
    expect(spy.seen).toEqual([]);
  });

  it('a call in an agent scope, recorded there and in the scope it sits inside', async () => {
    const parent = newScope();
    const child = agentPrivacyScope('agent-2', parent);
    await runInPrivacyScope(child, () =>
      applyPrivacyStage(chatCall([chat(LAUNCH), { model: 'm' }]))
    );
    expect(privacySummary(child)?.sensitivity).toEqual({ commercial: ['not_public'] });
    expect(privacySummary(parent)?.sensitivity).toEqual({ commercial: ['not_public'] });
  });

  it('not a call the stage refuses before it has a policy', async () => {
    const spy = spyClassifier();
    seam.init.mockImplementation(() => registerSensitivityClassifier(spy.classifier));
    mode('nonsense');
    await expect(
      runInPrivacyScope(newScope(), () =>
        applyPrivacyStage(chatCall([chat(HEALTH), { model: 'm' }]))
      )
    ).rejects.toMatchObject({ reason: 'settings_unreadable' });
    expect(spy.seen).toEqual([]);
  });
});

describe('a classification never acts on the call', () => {
  it('does not refuse under block when there is confidential content but no personal data', async () => {
    mode('block');
    const scope = newScope();
    const args = [chat('We are being sued by a supplier; the IPO is unannounced.'), { model: 'm' }];
    const result = await runInPrivacyScope(scope, () => applyPrivacyStage(chatCall(args)));
    expect(result.args[0]).toEqual(args[0]);
    expect(privacySummary(scope)?.sensitivity).toEqual({
      commercial: ['deal', 'litigation', 'not_public'],
    });
  });

  it('marks the call degraded when a classifier fails, and sends it anyway', async () => {
    mode('off');
    seam.init.mockImplementation(() =>
      registerSensitivityClassifier({
        id: 'acme.broken',
        egress: 'in_process',
        categories: { acme_secret: 'commercial' },
        classify: () => Promise.reject(new Error('down')),
      })
    );
    const scope = newScope();
    const args = [chat('What time is the standup?'), { model: 'm' }];
    const result = await runInPrivacyScope(scope, () => applyPrivacyStage(chatCall(args)));
    expect(result.args).toBe(args);
    expect(privacySummary(scope)).toMatchObject({
      mode: 'off',
      degraded: true,
      failedAdapters: ['acme.broken'],
    });
  });

  it('records no text and logs none', async () => {
    seam.init.mockImplementation(() =>
      registerSensitivityClassifier({
        id: 'acme.broken',
        egress: 'in_process',
        categories: { acme_secret: 'commercial' },
        classify: (input) => Promise.reject(new Error(input.parts.map((p) => p.text).join())),
      })
    );
    const scope = newScope();
    await runInPrivacyScope(scope, () =>
      applyPrivacyStage(chatCall([chat(HEALTH), { model: 'm' }]))
    );
    const recorded = JSON.stringify(privacySummary(scope));
    expect(recorded).toContain('health');
    expect(recorded).not.toMatch(/depression|signed off/);
    const logged = JSON.stringify(
      [logger.info, logger.warn, logger.error, logger.debug].flatMap(
        (fn) => vi.mocked(fn).mock.calls
      )
    );
    expect(logged).not.toMatch(/depression|signed off/);
  });
});

describe('a call abandoned while it is classified', () => {
  it('is neither sent nor recorded: it throws the abort every provider throws', async () => {
    mode('off');
    const controller = new AbortController();
    seam.init.mockImplementation(() =>
      registerSensitivityClassifier({
        id: 'acme.slow',
        egress: 'in_process',
        categories: { health: 'personal' },
        classify: () => {
          controller.abort();
          return Promise.resolve([{ category: 'health' }]);
        },
      })
    );
    const scope = newScope();
    const err = await runInPrivacyScope(scope, () =>
      applyPrivacyStage(chatCall([chat(HEALTH), { model: 'm', signal: controller.signal }]))
    ).then(
      () => undefined,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ code: 'aborted' });
    expect(privacySummary(scope)).toBeUndefined();
  });
});

describe('an external classifier', () => {
  function external(seen: string[]): SensitivityClassifier {
    return {
      id: 'acme.cloud',
      egress: 'external',
      categories: { health: 'personal' },
      classify: (input) => {
        seen.push(...input.parts.map((p) => p.text));
        return Promise.resolve([{ category: 'health' }]);
      },
    };
  }

  it('is not sent a call the layer forwards untouched: mode off, or a skipped local provider', async () => {
    const seen: string[] = [];
    seam.init.mockImplementation(() => registerSensitivityClassifier(external(seen)));
    mode('off');
    const offScope = newScope();
    await runInPrivacyScope(offScope, () =>
      applyPrivacyStage(chatCall([chat(HEALTH), { model: 'm' }]))
    );
    mode('detect');
    const localScope = newScope();
    await runInPrivacyScope(localScope, () =>
      applyPrivacyStage(chatCall([chat(HEALTH), { model: 'm' }], true))
    );
    expect(seen).toEqual([]);
    // Core's in-process classifier still ran on both.
    expect(privacySummary(offScope)?.sensitivity).toEqual({ personal: ['health'] });
    expect(privacySummary(localScope)?.sensitivity).toEqual({ personal: ['health'] });
  });

  it('is sent a call the layer scans: a cloud provider under detect', async () => {
    const seen: string[] = [];
    seam.init.mockImplementation(() => registerSensitivityClassifier(external(seen)));
    await runInPrivacyScope(newScope(), () =>
      applyPrivacyStage(chatCall([chat(HEALTH), { model: 'm' }]))
    );
    expect(seen).toContain(HEALTH);
  });
});

describe('a fault in classifying', () => {
  it('never stops a call that would go out: it is recorded as degraded instead', async () => {
    mode('off');
    // A text part with no text: the stage's own classification step throws.
    const messages = [{ role: 'user', content: [{ type: 'text' }] }] as unknown as LlmMessage[];
    const args = [messages, { model: 'm' }];
    const scope = newScope();
    const result = await runInPrivacyScope(scope, () => applyPrivacyStage(chatCall(args)));
    expect(result.args).toBe(args);
    expect(privacySummary(scope)).toMatchObject({
      mode: 'off',
      degraded: true,
      failedAdapters: ['privacy-stage.sensitivity'],
    });
    expect(logger.error).toHaveBeenCalledWith(
      'privacy-stage: sensitivity classification failed',
      undefined,
      expect.objectContaining({ errorName: 'TypeError' })
    );
  });
});

describe('an embedding refused under local_only', () => {
  it('is refused before it is classified, so its text reaches no external classifier', async () => {
    settings.read.mockResolvedValue({
      privacyMode: 'pseudonymise',
      privacyIgnoredEntityTypes: [],
      privacyProtectLocalProviders: false,
      privacyEmbeddingsPolicy: 'local_only',
    });
    const seen: string[] = [];
    seam.init.mockImplementation(() =>
      registerSensitivityClassifier({
        id: 'acme.cloud',
        egress: 'external',
        categories: { health: 'personal' },
        classify: (input) => {
          seen.push(...input.parts.map((p) => p.text));
          return Promise.resolve([]);
        },
      })
    );
    await expect(
      runInPrivacyScope(newScope(), () =>
        applyPrivacyStage(embeddingCall(['signed off with depression']))
      )
    ).rejects.toMatchObject({ reason: 'embeddings_local_only' });
    expect(seen).toEqual([]);
  });
});

describe('the mode a classification records', () => {
  it('is off for a call the masking skips, so it never claims a stricter mode than any scanned call ran under', async () => {
    mode('redact');
    const parent = newScope();
    // A scanned call under detect, then an unscanned local call under redact.
    mode('detect');
    await runInPrivacyScope(parent, () =>
      applyPrivacyStage(chatCall([chat(`Email priya.sharma@example.com please`), { model: 'm' }]))
    );
    mode('redact');
    await runInPrivacyScope(agentPrivacyScope('agent-2', parent), () =>
      applyPrivacyStage(chatCall([chat(HEALTH), { model: 'm' }], true))
    );
    const summary = privacySummary(parent);
    expect(summary?.mode).toBe('detect');
    expect(summary?.sensitivity).toEqual({ personal: ['health'] });
  });
});
