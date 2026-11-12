/**
 * Tests: the privacy stage on the provider-manager Proxy (§127).
 *
 * A fake provider registered with `registerProviderInstance` records exactly
 * what reaches each vendor method, so these assert on the request itself: in
 * `off` and in `detect` the vendor receives the very arguments the caller
 * passed, unchanged, and in `detect` the per-type counts land in the caller's
 * privacy scope. A refused call never reaches the vendor and is never counted
 * in flight.
 *
 * Under `pseudonymise` the vendor receives placeholders only, and what it
 * sends back — text, streamed text, tool-call arguments — reaches the caller
 * restored (t-992).
 *
 * The last case is the one #1138 is about: a provider call made from another
 * module graph (the capability dispatcher's) inside a chat turn must read the
 * turn's scope, not fall back to an ephemeral one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LlmProvider } from '@/lib/orchestration/llm/provider';
import type { LlmMessage } from '@/lib/orchestration/llm/types';

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiProviderConfig: { findFirst: vi.fn(), findMany: vi.fn() },
    // The agent's mode and the org's minimum (t-1010): neither set here.
    aiAgent: { findUnique: vi.fn(async () => null) },
    org: { findUnique: vi.fn(async () => null) },
  },
}));

const privacy = vi.hoisted((): { mode: string | null } => ({ mode: 'detect' }));
vi.mock('@/lib/orchestration/settings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/orchestration/settings')>()),
  getOrchestrationSettings: vi.fn(async () => ({
    globalMonthlyBudgetUsd: null,
    privacyMode: privacy.mode,
    privacyIgnoredEntityTypes: ['DATE', 'LOCATION'],
    privacyProtectLocalProviders: false,
  })),
}));

/** Makes masking throw: a bug inside the stage. */
const masking = vi.hoisted(() => ({ fail: false }));
vi.mock('@/lib/orchestration/privacy/call-masking', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/orchestration/privacy/call-masking')>();
  return {
    ...real,
    maskMessages: (...args: Parameters<typeof real.maskMessages>) => {
      if (masking.fail) throw new Error('masking broke');
      return real.maskMessages(...args);
    },
  };
});

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  clearCache,
  getProvider,
  registerProviderInstance,
} from '@/lib/orchestration/llm/provider-manager';
import {
  __resetInFlightCountersForTests,
  getInFlightCounts,
} from '@/lib/orchestration/llm/in-flight-counter';
import { PrivacyRefusedError } from '@/lib/orchestration/llm/privacy-stage';
import {
  createPrivacyScope,
  privacySummary,
  runInPrivacyScope,
  type PrivacyScope,
} from '@/lib/orchestration/privacy/scope';
import { __resetPrivacyAdaptersForTests } from '@/lib/privacy/adapters/registry';

const EMAIL = 'priya.sharma@example.com';

function conversation(): LlmMessage[] {
  return [
    { role: 'system', content: 'You are a support agent.' },
    { role: 'user', content: `Please write to me at ${EMAIL}.` },
  ];
}

/** A provider whose vendor methods record what they were handed, and the in-flight count. */
function fakeProvider() {
  const received: { method: string; args: unknown[]; inFlight: number }[] = [];
  const note = (method: string, args: unknown[]) =>
    received.push({
      method,
      args,
      inFlight: getInFlightCounts().find((c) => c.provider === 'probe')?.inFlight ?? 0,
    });
  const provider = {
    name: 'probe',
    isLocal: false,
    chat: vi.fn(async (...args: unknown[]) => {
      note('chat', args);
      return { content: 'ok', model: 'm', usage: { inputTokens: 1, outputTokens: 1 } };
    }),
    chatStream: async function* (...args: unknown[]) {
      note('chatStream', args);
      yield { type: 'text' as const, content: 'ok' };
    },
    embed: vi.fn(async (...args: unknown[]) => {
      note('embed', args);
      return [0];
    }),
    embedMany: vi.fn(async (...args: unknown[]) => {
      note('embedMany', args);
      return { embeddings: [[0]] };
    }),
    transcribe: vi.fn(async (...args: unknown[]) => {
      note('transcribe', args);
      return { text: EMAIL, durationMs: 0, model: 'm' };
    }),
    listModels: vi.fn(async () => []),
    testConnection: vi.fn(async () => ({ ok: true, models: [] })),
  } as unknown as LlmProvider;
  return { provider, received };
}

async function inTurn<T>(fn: () => Promise<T>): Promise<{ result: T; scope: PrivacyScope }> {
  const scope = createPrivacyScope({ scopeId: 'conversation:c1', agentId: 'agent-1' });
  const result = await runInPrivacyScope(scope, fn);
  return { result, scope };
}

async function drain(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

beforeEach(() => {
  vi.clearAllMocks();
  clearCache();
  __resetInFlightCountersForTests();
  __resetPrivacyAdaptersForTests();
  privacy.mode = 'detect';
  masking.fail = false;
});

describe.each(['off', 'detect'])('mode %s', (mode) => {
  beforeEach(() => {
    privacy.mode = mode;
  });

  it('sends chat exactly what the caller passed', async () => {
    const { provider, received } = fakeProvider();
    registerProviderInstance('probe', provider);
    const messages = conversation();
    const options = { model: 'm', temperature: 0.2 };
    const before = structuredClone({ messages, options });

    await inTurn(async () => (await getProvider('probe')).chat(messages, options));

    expect(received).toHaveLength(1);
    expect(received[0].args[0]).toBe(messages);
    expect(received[0].args[1]).toBe(options);
    expect({ messages, options }).toEqual(before);
    expect(received[0].inFlight).toBe(1);
  });

  it('sends chatStream exactly what the caller passed, and streams the reply unchanged', async () => {
    const { provider, received } = fakeProvider();
    registerProviderInstance('probe', provider);
    const messages = conversation();
    const before = structuredClone(messages);

    const { result } = await inTurn(async () =>
      drain((await getProvider('probe')).chatStream(messages, { model: 'm' }))
    );

    expect(received[0].args[0]).toBe(messages);
    expect(messages).toEqual(before);
    expect(result).toEqual([{ type: 'text', content: 'ok' }]);
  });

  it('sends embedMany exactly what the caller passed', async () => {
    const { provider, received } = fakeProvider();
    registerProviderInstance('probe', provider);
    const texts = [`Contact ${EMAIL}`];

    await inTurn(async () => (await getProvider('probe')).embedMany!(texts, { model: 'e' }));

    expect(received[0].args[0]).toBe(texts);
    expect(texts).toEqual([`Contact ${EMAIL}`]);
  });
});

describe('what detect records', () => {
  it("puts chat and embedding counts in the caller's scope, and nothing for off", async () => {
    const { provider } = fakeProvider();
    registerProviderInstance('probe', provider);

    const { scope } = await inTurn(async () => {
      const p = await getProvider('probe');
      await p.chat(conversation(), { model: 'm' });
      await drain(p.chatStream(conversation(), { model: 'm' }));
      await p.embed(`Contact ${EMAIL}`);
      await p.embedMany!([`Contact ${EMAIL}`], { model: 'e' });
    });

    expect(privacySummary(scope)).toEqual({
      mode: 'detect',
      calls: 2,
      counts: { EMAIL: 2 },
      embeddingCalls: 2,
      embeddingCounts: { EMAIL: 2 },
    });

    privacy.mode = 'off';
    const { scope: offScope } = await inTurn(async () =>
      (await getProvider('probe')).chat(conversation(), { model: 'm' })
    );
    expect(privacySummary(offScope)).toBeUndefined();
  });

  it('does not scan transcription', async () => {
    const { provider } = fakeProvider();
    registerProviderInstance('probe', provider);
    const { scope } = await inTurn(async () =>
      (await getProvider('probe')).transcribe!(new Uint8Array([1]), { model: 'w' })
    );
    expect(privacySummary(scope)).toBeUndefined();
  });
});

describe('a refused call', () => {
  beforeEach(() => {
    // A stored mode that is not a mode: the stage cannot say what the policy is.
    privacy.mode = null;
  });

  it('never reaches the vendor and is never counted in flight', async () => {
    const { provider, received } = fakeProvider();
    registerProviderInstance('probe', provider);
    const p = await getProvider('probe');

    await expect(p.chat(conversation(), { model: 'm' })).rejects.toBeInstanceOf(
      PrivacyRefusedError
    );
    await expect(drain(p.chatStream(conversation(), { model: 'm' }))).rejects.toBeInstanceOf(
      PrivacyRefusedError
    );
    await expect(p.embedMany!(['x'], { model: 'e' })).rejects.toBeInstanceOf(PrivacyRefusedError);

    expect(received).toEqual([]);
    expect(getInFlightCounts().find((c) => c.provider === 'probe')?.inFlight ?? 0).toBe(0);
  });

  it('leaves the methods the stage does not cover alone', async () => {
    const { provider, received } = fakeProvider();
    registerProviderInstance('probe', provider);
    const p = await getProvider('probe');
    await p.transcribe!(new Uint8Array([1]), { model: 'w' });
    await p.listModels();
    expect(received.map((r) => r.method)).toEqual(['transcribe']);
  });
});

describe('a call from another module graph inside a chat turn (#1138)', () => {
  // `vi.resetModules()` gives a second evaluation of the provider manager and
  // everything under it, as the capability dispatcher's graph has. The turn's
  // scope is entered through this file's evaluation of the scope module.
  const bag = globalThis as Record<string, unknown>;
  const before = bag.sunrisePrivacyScope;
  afterEach(() => {
    if (before === undefined) delete bag.sunrisePrivacyScope;
    else bag.sunrisePrivacyScope = before;
  });

  it("reads the turn's scope, not an ephemeral one", async () => {
    vi.resetModules();
    const dispatcherGraph = await import('@/lib/orchestration/llm/provider-manager');
    expect(dispatcherGraph.getProvider).not.toBe(getProvider);
    const { provider } = fakeProvider();
    dispatcherGraph.registerProviderInstance('probe', provider);

    const { scope } = await inTurn(async () =>
      (await dispatcherGraph.getProvider('probe')).chat(conversation(), { model: 'm' })
    );

    expect(privacySummary(scope)).toMatchObject({ calls: 1, counts: { EMAIL: 1 } });
  });
});

/** The placeholder a received request gave `EMAIL`. */
function emailPlaceholder(args: unknown[]): string {
  const m = /\[EMAIL_\d+\]/.exec(JSON.stringify(args));
  if (!m) throw new Error('no email placeholder in the request');
  return m[0];
}

describe('pseudonymise through the Proxy (t-992)', () => {
  /** A vendor that writes the placeholder it was sent back into its reply and a tool call. */
  function echoingProvider() {
    const received: unknown[][] = [];
    const provider = {
      name: 'probe',
      isLocal: false,
      chat: vi.fn(async (...args: unknown[]) => {
        received.push(args);
        const p = emailPlaceholder(args);
        return {
          content: `I will write to ${p}.`,
          toolCalls: [{ id: 'c1', name: 'send_email', arguments: { to: p } }],
          model: 'm',
          finishReason: 'tool_use',
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      }),
      chatStream: async function* (...args: unknown[]) {
        received.push(args);
        const p = emailPlaceholder(args);
        yield { type: 'text' as const, content: `Writing to ${p.slice(0, 3)}` };
        yield { type: 'text' as const, content: `${p.slice(3)} now.` };
        yield {
          type: 'tool_call' as const,
          toolCall: { id: 'c1', name: 'send_email', arguments: { to: p } },
        };
        yield {
          type: 'done' as const,
          usage: { inputTokens: 1, outputTokens: 1 },
          finishReason: 'tool_use' as const,
        };
      },
      embed: vi.fn(),
      embedMany: vi.fn(),
      transcribe: vi.fn(),
      listModels: vi.fn(async () => []),
      testConnection: vi.fn(async () => ({ ok: true, models: [] })),
    } as unknown as LlmProvider;
    return { provider, received };
  }

  beforeEach(() => {
    privacy.mode = 'pseudonymise';
  });

  it('sends chat placeholders only, and hands the caller the reply and tool call restored', async () => {
    const { provider, received } = echoingProvider();
    registerProviderInstance('probe', provider);
    const llm = await getProvider('probe');

    const { result } = await inTurn(() => llm.chat(conversation(), { model: 'm' }));

    expect(JSON.stringify(received)).not.toContain(EMAIL);
    expect(result.content).toBe(`I will write to ${EMAIL}.`);
    expect(result.toolCalls).toEqual([{ id: 'c1', name: 'send_email', arguments: { to: EMAIL } }]);
  });

  it('sends chatStream placeholders only, and streams the reply and tool call restored', async () => {
    const { provider, received } = echoingProvider();
    registerProviderInstance('probe', provider);
    const llm = await getProvider('probe');

    const { result: chunks } = await inTurn(() =>
      drain(llm.chatStream(conversation(), { model: 'm' }))
    );

    expect(JSON.stringify(received)).not.toContain(EMAIL);
    const text = chunks
      .flatMap((c) =>
        (c as { type: string }).type === 'text' ? [(c as { content: string }).content] : []
      )
      .join('');
    expect(text).toBe(`Writing to ${EMAIL} now.`);
    expect(chunks).toContainEqual({
      type: 'tool_call',
      toolCall: { id: 'c1', name: 'send_email', arguments: { to: EMAIL } },
    });
  });

  it('refuses on an error inside the stage, and never calls the vendor', async () => {
    masking.fail = true;
    const { provider, received } = echoingProvider();
    registerProviderInstance('probe', provider);
    const llm = await getProvider('probe');

    await expect(inTurn(() => llm.chat(conversation(), { model: 'm' }))).rejects.toBeInstanceOf(
      PrivacyRefusedError
    );
    await expect(
      inTurn(() => drain(llm.chatStream(conversation(), { model: 'm' })))
    ).rejects.toMatchObject({ reason: 'stage_error' });
    expect(received).toEqual([]);
    expect(provider.chat).not.toHaveBeenCalled();
  });
});
