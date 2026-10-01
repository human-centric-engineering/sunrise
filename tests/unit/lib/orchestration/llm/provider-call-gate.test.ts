/**
 * The call-time provider gate (§120 t-741).
 *
 * Every vendor-reaching call on a manager-built provider asks the eligibility
 * rule first, inside the Proxy, whatever site chose the provider. These tests
 * drive the provider manager directly — `registerProviderInstance` and
 * `getProvider` / `getProviderWithFallbacks` — and never the agent resolver,
 * so a refusal here is the gate's alone: no selection site had a chance to
 * filter the provider out first.
 *
 * @see lib/orchestration/llm/provider-eligibility.ts — assertProviderCallPermitted
 * @see lib/orchestration/llm/provider-manager.ts — withInFlightTracking
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Only TENANCY_MODE is swapped; everything else reads the real env.
const mockMode = vi.hoisted(() => ({ value: 'single' }));
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: new Proxy(actual.env, {
      get: (target, key) =>
        key === 'TENANCY_MODE' ? mockMode.value : (Reflect.get(target, key) as unknown),
    }),
  };
});

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiProviderConfig: { findFirst: vi.fn(), findMany: vi.fn() },
  },
}));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    public messages = { create: vi.fn() };
    constructor(_opts: unknown) {}
  }
  return { default: MockAnthropic };
});

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import {
  clearCache,
  getProvider,
  getProviderWithFallbacks,
  registerProviderInstance,
} from '@/lib/orchestration/llm/provider-manager';
import {
  ProviderCallRefusedError,
  registerProviderEligibility,
  resetProviderEligibility,
  type ProviderEligibilityContext,
} from '@/lib/orchestration/llm/provider-eligibility';
import { isRequestFault, type LlmProvider } from '@/lib/orchestration/llm/provider';
import { resetAllBreakers } from '@/lib/orchestration/llm/circuit-breaker';
import {
  __resetInFlightCountersForTests,
  getInFlightCounts,
} from '@/lib/orchestration/llm/in-flight-counter';
import { runAsOrg, runAsSystem } from '@/lib/tenancy/context';

const ORG_A = 'cmorg00000000000000000orga';

/** A provider whose every vendor method is a spy. */
function fakeProvider(name: string) {
  const chat = vi
    .fn()
    .mockResolvedValue({ content: 'ok', usage: { inputTokens: 1, outputTokens: 1 } });
  const streamOpened = vi.fn();
  const embedMany = vi.fn().mockResolvedValue({ embeddings: [[0.1]] });
  const transcribe = vi.fn().mockResolvedValue({ text: '' });
  const listModels = vi.fn().mockResolvedValue([]);
  const testConnection = vi.fn().mockResolvedValue({ ok: true, models: [] });
  const provider: LlmProvider = {
    name,
    isLocal: false,
    chat,
    chatStream: (): AsyncIterable<never> => {
      streamOpened();
      return (async function* () {
        yield* [];
      })();
    },
    embed: vi.fn().mockResolvedValue([0.1]),
    embedMany,
    transcribe,
    listModels,
    testConnection,
  };
  return { provider, chat, streamOpened, embedMany, transcribe, listModels, testConnection };
}

/** A rule that refuses `barred` for every source, and records what it was asked. */
function refuseRule(barred: string) {
  const seen: { candidates: readonly string[]; context: ProviderEligibilityContext }[] = [];
  const rule = (candidates: readonly string[], context: ProviderEligibilityContext) => {
    seen.push({ candidates, context });
    return candidates.filter((slug) => slug !== barred);
  };
  return { rule, seen };
}

const PRIMARY: ProviderEligibilityContext = { task: 'chat', source: 'primary', primarySlug: null };
const EXPLICIT: ProviderEligibilityContext = {
  task: 'chat',
  source: 'explicit',
  primarySlug: null,
};

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _chunk of stream) {
    // nothing
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  clearCache();
  resetProviderEligibility();
  resetAllBreakers();
  __resetInFlightCountersForTests();
  mockMode.value = 'single';
});

afterEach(() => {
  resetProviderEligibility();
});

describe('the call-time gate refuses what the rule refuses, wherever the call came from', () => {
  it('refuses an auto-picked, an explicit and an unrecorded chat call to a barred provider', async () => {
    const x = fakeProvider('x');
    registerProviderInstance('x', x.provider);
    registerProviderEligibility(refuseRule('x').rule);

    for (const context of [PRIMARY, EXPLICIT, undefined]) {
      const provider = await getProvider('x', context);
      await expect(provider.chat([], { model: 'm' })).rejects.toBeInstanceOf(
        ProviderCallRefusedError
      );
    }
    // The vendor was never reached.
    expect(x.chat).not.toHaveBeenCalled();
  });

  it('refuses an explicit agent.provider rather than rerouting it — the refusal is the answer', async () => {
    const x = fakeProvider('x');
    registerProviderInstance('x', x.provider);
    registerProviderEligibility(refuseRule('x').rule);

    const { provider, usedSlug } = await getProviderWithFallbacks('x', [], {
      task: 'chat',
      primary: 'explicit',
      fallbacks: 'explicit',
    });

    // Acquisition still hands back x: the gate does not pick another provider.
    expect(usedSlug).toBe('x');
    await expect(provider.chat([], { model: 'm' })).rejects.toMatchObject({
      code: 'provider_not_permitted',
      providerSlug: 'x',
    });
    expect(x.chat).not.toHaveBeenCalled();
  });

  it('refuses a system-fill fallback into a barred provider, which the auto-fallback used to allow', async () => {
    const x = fakeProvider('x');
    registerProviderInstance('x', x.provider);
    // The primary has no row and no registration, so acquisition falls back.
    vi.mocked(prisma.aiProviderConfig.findFirst).mockResolvedValue(null);
    registerProviderEligibility(refuseRule('x').rule);

    const { provider, usedSlug } = await getProviderWithFallbacks('gone', ['x'], {
      task: 'chat',
      primary: 'primary',
      fallbacks: 'system',
    });

    expect(usedSlug).toBe('x');
    await expect(provider.chat([], { model: 'm' })).rejects.toBeInstanceOf(
      ProviderCallRefusedError
    );
    expect(x.chat).not.toHaveBeenCalled();
  });

  it('refuses an embedding call', async () => {
    const x = fakeProvider('x');
    registerProviderInstance('x', x.provider);
    registerProviderEligibility(refuseRule('x').rule);

    const provider = await getProvider('x', {
      task: 'embeddings',
      source: 'primary',
      primarySlug: null,
    });

    await expect(provider.embedMany!(['text'], { model: 'e' })).rejects.toBeInstanceOf(
      ProviderCallRefusedError
    );
    expect(x.embedMany).not.toHaveBeenCalled();
  });

  it('refuses a stream before the vendor stream is opened, and counts nothing in flight', async () => {
    const x = fakeProvider('x');
    registerProviderInstance('x', x.provider);
    registerProviderEligibility(refuseRule('x').rule);

    const provider = await getProvider('x', PRIMARY);
    const stream = provider.chatStream([], { model: 'm' });

    await expect(drain(stream)).rejects.toBeInstanceOf(ProviderCallRefusedError);
    expect(x.streamOpened).not.toHaveBeenCalled();
    expect(getInFlightCounts().find((c) => c.provider === 'x')?.inFlight ?? 0).toBe(0);
  });

  it('leaves a permitted provider alone', async () => {
    const y = fakeProvider('y');
    registerProviderInstance('y', y.provider);
    registerProviderEligibility(refuseRule('x').rule);

    const provider = await getProvider('y', PRIMARY);
    await provider.chat([], { model: 'm' });
    await drain(provider.chatStream([], { model: 'm' }));

    expect(y.chat).toHaveBeenCalledTimes(1);
    expect(y.streamOpened).toHaveBeenCalledTimes(1);
  });

  it('does not gate listModels and testConnection: they send no content, and admins test before granting', async () => {
    const x = fakeProvider('x');
    registerProviderInstance('x', x.provider);
    registerProviderEligibility(refuseRule('x').rule);

    const provider = await getProvider('x', PRIMARY);
    await provider.listModels();
    await provider.testConnection();

    expect(x.listModels).toHaveBeenCalledTimes(1);
    expect(x.testConnection).toHaveBeenCalledTimes(1);
  });
});

describe('what the rule is told', () => {
  it('passes the auto-picked primary as source "primary" and an explicit one as "explicit"', async () => {
    registerProviderInstance('a', fakeProvider('a').provider);
    const { rule, seen } = refuseRule('nothing');
    registerProviderEligibility(rule);

    const auto = await getProviderWithFallbacks('a', [], {
      task: 'chat',
      primary: 'primary',
      fallbacks: 'system',
    });
    await auto.provider.chat([], { model: 'm' });
    const chosen = await getProviderWithFallbacks('a', [], {
      task: 'chat',
      primary: 'explicit',
      fallbacks: 'explicit',
    });
    await chosen.provider.chat([], { model: 'm' });

    expect(seen.map((s) => s.context)).toEqual([
      { task: 'chat', source: 'primary', primarySlug: null },
      { task: 'chat', source: 'explicit', primarySlug: null },
    ]);
  });

  it('passes a fallback with its binding source and the primary it stands in for', async () => {
    registerProviderInstance('b', fakeProvider('b').provider);
    vi.mocked(prisma.aiProviderConfig.findFirst).mockResolvedValue(null);
    const { rule, seen } = refuseRule('nothing');
    registerProviderEligibility(rule);

    const { provider } = await getProviderWithFallbacks('gone', ['b'], {
      task: 'routing',
      primary: 'explicit',
      fallbacks: 'system',
    });
    await provider.chat([], { model: 'm' });

    expect(seen).toEqual([
      { candidates: ['b'], context: { task: 'routing', source: 'system', primarySlug: 'gone' } },
    ]);
  });

  it('a call with no recorded provenance must pass under EVERY source, so it is never the lenient answer', async () => {
    registerProviderInstance('x', fakeProvider('x').provider);
    // A rule that only minds the silent fill: permitted for 'primary' and
    // 'explicit', refused for 'system'.
    const rule = vi.fn((candidates: readonly string[], context: ProviderEligibilityContext) =>
      context.source === 'system' ? [] : candidates
    );
    registerProviderEligibility(rule);

    const unrecorded = await getProvider('x');
    await expect(unrecorded.chat([], { model: 'm' })).rejects.toBeInstanceOf(
      ProviderCallRefusedError
    );
    // With provenance recorded, the same rule permits the call.
    const recorded = await getProvider('x', PRIMARY);
    await expect(recorded.chat([], { model: 'm' })).resolves.toMatchObject({ content: 'ok' });
  });

  it('an unrecorded call takes its task from the method', async () => {
    registerProviderInstance('x', fakeProvider('x').provider);
    const { rule, seen } = refuseRule('nothing');
    registerProviderEligibility(rule);

    const provider = await getProvider('x');
    await provider.embedMany!(['t'], { model: 'e' });
    await provider.transcribe!(Buffer.from(''), { model: 'w', mimeType: 'audio/wav' });

    expect(new Set(seen.map((s) => s.context.task))).toEqual(new Set(['embeddings', 'audio']));
    expect(seen.every((s) => s.context.primarySlug === null)).toBe(true);
  });

  it('asks the rule on every call, not once per cached instance', async () => {
    const x = fakeProvider('x');
    registerProviderInstance('x', x.provider);
    const barred = new Set<string>();
    registerProviderEligibility((candidates) => candidates.filter((s) => !barred.has(s)));

    const first = await getProvider('x', PRIMARY);
    await first.chat([], { model: 'm' });

    barred.add('x');
    const second = await getProvider('x', PRIMARY);
    // Same cached object — the change is seen without a new instance.
    expect(second).toBe(first);
    await expect(second.chat([], { model: 'm' })).rejects.toBeInstanceOf(ProviderCallRefusedError);
    expect(x.chat).toHaveBeenCalledTimes(1);
  });

  it('a rule that throws refuses the call', async () => {
    registerProviderInstance('x', fakeProvider('x').provider);
    registerProviderEligibility(() => {
      throw new Error('policy store down');
    });

    const provider = await getProvider('x', PRIMARY);
    await expect(provider.chat([], { model: 'm' })).rejects.toBeInstanceOf(
      ProviderCallRefusedError
    );
  });
});

describe('the row the gate evaluates', () => {
  function row(slug: string, name: string) {
    return {
      id: `id-${slug}`,
      slug,
      name,
      providerType: 'anthropic',
      baseUrl: null,
      apiKeyEnvVar: 'GATE_TEST_KEY',
      isLocal: false,
      isActive: true,
      timeoutMs: null,
      maxRetries: null,
      metadata: null,
      createdAt: new Date(),
    };
  }

  beforeEach(() => {
    process.env.GATE_TEST_KEY = 'k';
  });

  it("evaluates the BUILT row's slug, not the string the caller asked for", async () => {
    // No row has slug 'approved'; row 'barred' is NAMED 'approved'. A caller
    // that checked 'approved' and asked for it gets 'barred' — refused as such.
    vi.mocked(prisma.aiProviderConfig.findFirst).mockImplementation((async (args: {
      where: { slug?: string; name?: string };
    }) => (args.where.name === 'approved' ? row('barred', 'approved') : null)) as never);
    const { rule, seen } = refuseRule('barred');
    registerProviderEligibility(rule);

    const provider = await getProvider('approved', PRIMARY);
    await expect(provider.chat([], { model: 'm' })).rejects.toBeInstanceOf(
      ProviderCallRefusedError
    );
    expect(seen.map((s) => s.candidates)).toEqual([['barred']]);
  });

  it('prefers a slug match over a name match', async () => {
    vi.mocked(prisma.aiProviderConfig.findFirst).mockImplementation((async (args: {
      where: { slug?: string; name?: string };
    }) => {
      if (args.where.slug === 'shared') return row('shared', 'Shared');
      if (args.where.name === 'shared') return row('other', 'shared');
      return null;
    }) as never);

    const provider = await getProvider('shared');

    expect(provider.name).toBe('Shared');
    expect(prisma.aiProviderConfig.findFirst).toHaveBeenCalledTimes(1);
    expect(prisma.aiProviderConfig.findFirst).toHaveBeenCalledWith({ where: { slug: 'shared' } });
  });
});

describe('the org a call answers for', () => {
  it('at single, a call with no tenant context is the install org and goes ahead', async () => {
    const x = fakeProvider('x');
    registerProviderInstance('x', x.provider);

    const provider = await getProvider('x', PRIMARY);
    await provider.chat([], { model: 'm' });

    expect(x.chat).toHaveBeenCalledTimes(1);
  });

  it('at multi, a call outside any org scope is refused before the rule is asked', async () => {
    mockMode.value = 'multi';
    const x = fakeProvider('x');
    registerProviderInstance('x', x.provider);
    const rule = vi.fn((candidates: readonly string[]) => candidates);
    registerProviderEligibility(rule);

    const provider = await getProvider('x', PRIMARY);
    await expect(provider.chat([], { model: 'm' })).rejects.toBeInstanceOf(
      ProviderCallRefusedError
    );
    expect(rule).not.toHaveBeenCalled();
    expect(x.chat).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      'Refusing a provider call made outside any org scope',
      expect.objectContaining({ providerSlug: 'x' })
    );
  });

  it('at multi, a runAsSystem scope names no org and is refused too', async () => {
    mockMode.value = 'multi';
    const x = fakeProvider('x');
    registerProviderInstance('x', x.provider);

    const provider = await getProvider('x', PRIMARY);
    await expect(
      runAsSystem('gate test', () => provider.chat([], { model: 'm' }))
    ).rejects.toBeInstanceOf(ProviderCallRefusedError);
    expect(x.chat).not.toHaveBeenCalled();
  });

  it("at multi, a call inside an org's scope goes to the rule, which runs in that scope", async () => {
    mockMode.value = 'multi';
    const x = fakeProvider('x');
    registerProviderInstance('x', x.provider);
    const { getTenantContext } = await import('@/lib/tenancy/context');
    const orgsSeen: (string | null)[] = [];
    registerProviderEligibility((candidates) => {
      orgsSeen.push(getTenantContext()?.orgId ?? null);
      return candidates;
    });

    const provider = await getProvider('x', PRIMARY);
    await runAsOrg(ORG_A, () => provider.chat([], { model: 'm' }));

    expect(x.chat).toHaveBeenCalledTimes(1);
    expect(orgsSeen).toEqual([ORG_A]);
  });
});

describe('a refusal is not a provider failure', () => {
  it('is a request fault, so nothing fails over from it or retries it', () => {
    expect(isRequestFault(new ProviderCallRefusedError('x'))).toBe(true);
  });

  it('names no provider in its message — executors forward ProviderError messages to clients', () => {
    const err = new ProviderCallRefusedError('secret-internal-slug');
    expect(err.message).not.toContain('secret-internal-slug');
    expect(err.providerSlug).toBe('secret-internal-slug');
    expect(err.retriable).toBe(false);
  });
});
