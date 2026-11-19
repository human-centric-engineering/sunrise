/**
 * Spend on an organisation's own AI key (§137 t-1046), end to end.
 *
 * The vendor bills a call on an org's own key to the org, so its cost row is
 * marked and the org's and the global caps neither count it nor refuse it;
 * the agent's cap still does. The provider manager knows which key a call
 * used (`usesOrgOwnKey`), and each caller that writes the call's cost row
 * passes it. So these tests run real callers — a chat turn (the `chat_turn`
 * step), a workflow `llm_call` step and an embedding — through the real
 * manager, credential seam, org-key store, sealing, cost tracker and spend
 * caps, with only the database, the vendors' SDKs, the switch and the provider
 * policy scripted. A caller that asked another provider than the one it
 * called would show up here as a wrongly marked row; one that forgot to ask is
 * caught by `cost-log-own-key.test.ts`.
 *
 * @see lib/orchestration/llm/provider-manager.ts — usesOrgOwnKey
 * @see lib/orchestration/llm/spend-caps.ts
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const envOverrides = vi.hoisted((): Record<string, string | undefined> => ({}));
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: new Proxy(actual.env, {
      get: (target, key) =>
        typeof key === 'string' && key in envOverrides
          ? envOverrides[key]
          : (Reflect.get(target, key) as unknown),
    }),
  };
});

/** A cost row as the in-memory table keeps it. */
interface CostRow {
  orgId: string | null;
  totalCostUsd: number;
  ownKey: boolean;
  model: string;
  operation: string;
  createdAt: Date;
}

interface AggregateArgs {
  where: { orgId?: string; ownKey?: boolean; createdAt?: { gte?: Date } };
}

/**
 * The cost log, in memory. `create` stamps the org in context, as the tenancy
 * extension does, and `aggregate` sums what its `where` selects, so a total
 * that forgot to leave own-key rows out would count them here too.
 */
const costLog = vi.hoisted(() => ({ rows: [] as CostRow[] }));

vi.mock('@/lib/db/client', async () => {
  const { getTenantContext } = await import('@/lib/tenancy/context');
  return {
    prisma: {
      aiProviderConfig: { findFirst: vi.fn(), findMany: vi.fn() },
      aiOrgProviderKey: (await import('@/tests/helpers/org-provider-key-table')).orgKeyTable
        .delegate,
      aiCostLog: {
        create: vi.fn(async ({ data }: { data: Omit<CostRow, 'orgId' | 'createdAt'> }) => {
          const row: CostRow & { id: string } = {
            id: `cost-${costLog.rows.length + 1}`,
            ...data,
            ownKey: data.ownKey === true,
            orgId: getTenantContext()?.orgId ?? null,
            createdAt: new Date(),
          };
          costLog.rows.push(row);
          return row;
        }),
        aggregate: vi.fn(async ({ where }: AggregateArgs) => ({
          _sum: {
            totalCostUsd: costLog.rows
              .filter(
                (r) =>
                  (where.orgId === undefined || r.orgId === where.orgId) &&
                  (where.ownKey === undefined || r.ownKey === where.ownKey) &&
                  (where.createdAt?.gte === undefined || r.createdAt >= where.createdAt.gte)
              )
              .reduce((sum, r) => sum + r.totalCostUsd, 0),
          },
        })),
      },
      org: { findUnique: vi.fn() },
      aiOrchestrationSettings: { findFirst: vi.fn(async () => null) },
      aiConversation: { findUnique: vi.fn() },
      aiAgent: { findFirst: vi.fn(), update: vi.fn(async () => ({})) },
    },
  };
});

vi.mock('@/lib/orchestration/privacy/scope-settings', async (importOriginal) =>
  (await import('@/tests/helpers/privacy-settings')).scopeSettingsReadingNothing(
    await importOriginal()
  )
);

/** The install's switch and its global cap. */
const settings = vi.hoisted(() => ({ switchOn: true, globalCap: null as number | null }));
vi.mock('@/lib/orchestration/settings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/orchestration/settings')>()),
  getOrchestrationSettings: vi.fn(async () => ({
    ...(await import('@/tests/helpers/privacy-settings')).privacyOffSettings(),
    orgProviderKeysEnabled: settings.switchOn,
    globalMonthlyBudgetUsd: settings.globalCap,
  })),
}));

const approvals = vi.hoisted(() => ({ byOrg: new Map<string, Set<string>>() }));
vi.mock('@/lib/orchestration/llm/org-provider-policy', async (importOriginal) => {
  const { getTenantContext } = await import('@/lib/tenancy/context');
  return {
    ...(await importOriginal<typeof import('@/lib/orchestration/llm/org-provider-policy')>()),
    applyOrgProviderPolicy: vi.fn(async (candidates: readonly string[]) => {
      const orgId = getTenantContext()?.orgId ?? null;
      const approved = orgId ? approvals.byOrg.get(orgId) : undefined;
      return candidates.filter((slug) => approved?.has(slug) === true);
    }),
  };
});

// The model registry's own list is enough; there is no matrix to hydrate.
vi.mock('@/lib/orchestration/llm/model-registry-db-hydrate', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/orchestration/llm/model-registry-db-hydrate')>()),
  hydrateFromDb: vi.fn(async () => undefined),
}));
vi.mock('@/lib/orchestration/llm/settings-resolver', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/orchestration/llm/settings-resolver')>()),
  getDefaultModelForTask: vi.fn(async (task: string) =>
    task === 'embeddings' ? 'text-embedding-3-small' : 'claude-haiku-4-5'
  ),
}));

// The chat turn's agent: its binding is the resolver's job, proved elsewhere.
const binding = vi.hoisted(() => ({ providerSlug: 'anthropic' }));
vi.mock('@/lib/orchestration/llm/agent-resolver', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/orchestration/llm/agent-resolver')>()),
  resolveAgentProviderAndModel: vi.fn(async () => ({
    providerSlug: binding.providerSlug,
    model: 'claude-haiku-4-5',
    fallbacks: [],
    provenance: { source: 'explicit' },
  })),
}));
vi.mock('@/lib/orchestration/agents/agent-versioning', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/orchestration/agents/agent-versioning')>()),
  readAgentConsistently: vi.fn((db: unknown, read: (tx: unknown) => unknown) => read(db)),
}));

vi.mock('@/lib/logging', () => {
  const log = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { logger: { ...log, withContext: vi.fn(() => log) } };
});

/** Every Anthropic client built, with the key it was built with. */
const anthropicClients = vi.hoisted(() => [] as { apiKey: unknown }[]);
vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    public messages = {
      create: vi.fn(async () => ({
        content: [{ type: 'text', text: 'ok' }],
        // A million in and out: priced well past any cap these tests set.
        usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
        model: 'claude-haiku-4-5',
        stop_reason: 'end_turn',
      })),
    };
    constructor(opts: { apiKey?: unknown }) {
      anthropicClients.push({ apiKey: opts.apiKey });
    }
  }
  return { default: MockAnthropic };
});

/** Every OpenAI client built, with the key it was built with. */
const openaiClients = vi.hoisted(() => [] as { apiKey: unknown }[]);
vi.mock('openai', async (importOriginal) => {
  class MockOpenAI {
    public embeddings = {
      create: vi.fn(async ({ input }: { input: string[] }) => ({
        data: input.map((_, index) => ({ index, embedding: new Array(1536).fill(0.01) })),
        usage: { prompt_tokens: 1_000_000, total_tokens: 1_000_000 },
      })),
    };
    constructor(opts: { apiKey?: unknown }) {
      openaiClients.push({ apiKey: opts.apiKey });
    }
  }
  return {
    ...(await importOriginal<typeof import('openai')>()),
    default: MockOpenAI,
  };
});

import { prisma } from '@/lib/db/client';
import { executeChatTurn } from '@/lib/orchestration/engine/executors/chat-turn';
import { runLlmCall } from '@/lib/orchestration/engine/llm-runner';
import type { ExecutionContext } from '@/lib/orchestration/engine/context';
import { embedText } from '@/lib/orchestration/knowledge/embedder';
import { resetAllBreakers } from '@/lib/orchestration/llm/circuit-breaker';
import { __resetInFlightCountersForTests } from '@/lib/orchestration/llm/in-flight-counter';
import {
  forgetOrgProviderKey,
  saveOrgProviderKey,
} from '@/lib/orchestration/llm/org-provider-keys';
import { resetProviderCredentialResolver } from '@/lib/orchestration/llm/provider-credentials';
import { resetProviderEligibility } from '@/lib/orchestration/llm/provider-eligibility';
import {
  clearCache,
  getProvider,
  getProviderWithFallbacks,
  providerUsesOrgOwnKey,
  usesOrgOwnKey,
} from '@/lib/orchestration/llm/provider-manager';
import {
  SpendCapExceededError,
  forgetSpendCaps,
  withPaidCallHold,
  type PaidCallHold,
} from '@/lib/orchestration/llm/spend-caps';
import { runAsOrg } from '@/lib/tenancy/context';
import { orgKeyTable } from '@/tests/helpers/org-provider-key-table';
import type { WorkflowStep } from '@/types/orchestration';

/** Holds its own Anthropic and OpenAI keys. */
const OWN = 'cmorg000000000000000000own';
/** Holds none: every call goes out on the platform's keys. */
const SHARED = 'cmorg000000000000000shared';

function providerRow(slug: string, providerType: string, baseUrl: string | null) {
  return {
    id: `cmprov00000000000000${slug.padStart(6, '0')}`,
    slug,
    name: slug,
    providerType,
    baseUrl,
    apiKeyEnvVar: 'OWN_KEY_SPEND_SHARED_KEY',
    isLocal: false,
    isActive: true,
    timeoutMs: null,
    maxRetries: 0,
    metadata: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
  };
}

/** The OWN org holds a key for this row. */
const ANTHROPIC = providerRow('anthropic', 'anthropic', null);
/** A second Anthropic row the OWN org holds no key for: its calls are the platform's. */
const ANTHROPIC_EU = providerRow('anthropic-eu', 'anthropic', null);
const OPENAI = providerRow('openai', 'openai-compatible', 'https://api.openai.com/v1');
const ROWS = [ANTHROPIC, ANTHROPIC_EU, OPENAI];

/** Each org's monthly cap (`settings.quotas.monthlyBudgetUsd`). */
let orgCaps: Record<string, number | null>;

function saveKey(row: { id: string }, apiKey: string) {
  return runAsOrg(OWN, () =>
    saveOrgProviderKey({ providerConfigId: row.id, apiKey, savedById: null })
  );
}

/** Platform spend already on the books for `orgId` this month. */
function spent(orgId: string, totalCostUsd: number) {
  costLog.rows.push({
    orgId,
    totalCostUsd,
    ownKey: false,
    model: 'claude-haiku-4-5',
    operation: 'chat',
    createdAt: new Date(),
  });
}

function chatOn(orgId: string, slug: string) {
  return runAsOrg(orgId, async () => {
    const provider = await getProvider(slug);
    return provider.chat([{ role: 'user', content: 'hi' }], { model: 'claude-haiku-4-5' });
  });
}

function makeCtx(): ExecutionContext {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return {
    executionId: 'exec_1',
    workflowId: 'wf_1',
    userId: 'user_1',
    inputData: { query: 'hello' },
    stepOutputs: {},
    variables: {},
    totalTokensUsed: 0,
    totalCostUsd: 0,
    defaultErrorStrategy: 'fail',
    logger: { ...log, withContext: vi.fn(() => log) } as unknown as ExecutionContext['logger'],
  };
}

const CHAT_TURN_STEP: WorkflowStep = {
  id: 'step_turn',
  name: 'Chat turn',
  type: 'chat_turn',
  config: {
    agentSlug: 'helper',
    conversationId: 'conv_1',
    message: 'hello',
    persistMessages: false,
    modelOverride: 'claude-haiku-4-5',
  },
  nextSteps: [],
};

/** `logCost` is fire-and-forget: wait for every row a call started. */
async function settled(): Promise<CostRow[]> {
  await vi.waitFor(async () => {
    await Promise.all(vi.mocked(prisma.aiCostLog.create).mock.results.map((r) => r.value));
  });
  return Promise.all(
    vi.mocked(prisma.aiCostLog.create).mock.results.map((r) => r.value as Promise<CostRow>)
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  costLog.rows = [];
  anthropicClients.length = 0;
  openaiClients.length = 0;
  clearCache();
  resetAllBreakers();
  __resetInFlightCountersForTests();
  resetProviderCredentialResolver();
  resetProviderEligibility();
  orgKeyTable.clear();
  forgetOrgProviderKey();
  forgetSpendCaps();
  envOverrides.TENANCY_MODE = 'multi';
  envOverrides.SEALED_SECRET_KEYS = `one:${'m'.repeat(40)}`;
  envOverrides.SEALED_SECRET_ACTIVE_KEY = 'one';
  settings.switchOn = true;
  settings.globalCap = null;
  orgCaps = {};
  binding.providerSlug = 'anthropic';
  const every = new Set(ROWS.map((r) => r.slug));
  approvals.byOrg = new Map([
    [OWN, every],
    [SHARED, every],
  ]);
  process.env.OWN_KEY_SPEND_SHARED_KEY = 'platform-key';
  vi.mocked(prisma.aiProviderConfig.findFirst).mockImplementation(
    (async (args: { where: { slug?: string; name?: string } }) =>
      ROWS.find((r) => r.slug === args.where.slug || r.name === args.where.name) ?? null) as never
  );
  vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([OPENAI] as never);
  vi.mocked(prisma.org.findUnique).mockImplementation((async (args: { where: { id: string } }) => {
    const cap = orgCaps[args.where.id];
    return { settings: cap === undefined ? null : { quotas: { monthlyBudgetUsd: cap } } };
  }) as never);
  vi.mocked(prisma.aiConversation.findUnique).mockResolvedValue({
    id: 'conv_1',
    agentId: 'agent_1',
    metadata: null,
    messages: [],
  } as never);
  vi.mocked(prisma.aiAgent.findFirst).mockResolvedValue({
    id: 'agent_1',
    slug: 'helper',
    systemInstructions: 'Be helpful.',
    persona: null,
    brandVoiceInstructions: null,
    guardrails: null,
    personaMode: 'override',
    voiceMode: 'override',
    guardrailsMode: 'override',
    profile: null,
    versions: [],
    temperature: null,
    maxTokens: null,
    reasoningEffort: null,
    metadata: null,
  } as never);
});

afterEach(() => {
  delete process.env.OWN_KEY_SPEND_SHARED_KEY;
});

describe('the cost row of a call on an org’s own key is marked, and one on the platform’s is not', () => {
  beforeEach(async () => {
    await saveKey(ANTHROPIC, 'sk-ant-own-0000000000000000000000000000wxyz');
    await saveKey(OPENAI, 'sk-own-openai-11111111111111111111111abcd');
  });

  it('for a chat turn', async () => {
    await runAsOrg(OWN, () => executeChatTurn(CHAT_TURN_STEP, makeCtx()));
    await runAsOrg(SHARED, () => executeChatTurn(CHAT_TURN_STEP, makeCtx()));

    const rows = await settled();
    expect(rows.map((r) => [r.orgId, r.operation, r.ownKey])).toEqual([
      [OWN, 'chat', true],
      [SHARED, 'chat', false],
    ]);
    expect(anthropicClients.map((c) => c.apiKey)).toEqual([
      'sk-ant-own-0000000000000000000000000000wxyz',
      'platform-key',
    ]);
  });

  it('for a workflow step', async () => {
    const step = { stepId: 'step_llm', prompt: 'hello', modelOverride: 'claude-haiku-4-5' };
    await runAsOrg(OWN, () => runLlmCall(makeCtx(), step));
    await runAsOrg(SHARED, () => runLlmCall(makeCtx(), step));

    const rows = await settled();
    expect(rows.map((r) => [r.orgId, r.ownKey])).toEqual([
      [OWN, true],
      [SHARED, false],
    ]);
  });

  it('for an embedding', async () => {
    await runAsOrg(OWN, () => embedText('a document'));
    await runAsOrg(SHARED, () => embedText('a document'));

    const rows = await settled();
    expect(rows.map((r) => [r.orgId, r.operation, r.ownKey])).toEqual([
      [OWN, 'embedding', true],
      [SHARED, 'embedding', false],
    ]);
    expect(openaiClients.map((c) => c.apiKey)).toEqual([
      'sk-own-openai-11111111111111111111111abcd',
      'platform-key',
    ]);
  });

  it('not for the same org’s call on a provider it holds no key for', async () => {
    binding.providerSlug = 'anthropic-eu';
    await runAsOrg(OWN, () => executeChatTurn(CHAT_TURN_STEP, makeCtx()));

    const rows = await settled();
    expect(rows.map((r) => r.ownKey)).toEqual([false]);
  });

  it('by the provider each call was made on, with the same model on both kinds of key', async () => {
    // Two rows serving one model, the org holding its own key for one of them.
    for (const slug of ['anthropic', 'anthropic-eu', 'anthropic', 'anthropic-eu']) {
      binding.providerSlug = slug;
      await runAsOrg(OWN, () => executeChatTurn(CHAT_TURN_STEP, makeCtx()));
    }

    const rows = await settled();
    expect(rows.map((r) => r.ownKey)).toEqual([true, false, true, false]);
  });

  it('for every batch of an embedding run, in its one row', async () => {
    const { embedBatch } = await import('@/lib/orchestration/knowledge/embedder');
    await runAsOrg(OWN, () => embedBatch(['a', 'b', 'c'], 1, 'document'));

    const rows = await settled();
    expect(rows.map((r) => [r.operation, r.ownKey])).toEqual([['embedding', true]]);
  });
});

describe('whether a provider’s calls go out on the org’s own key', () => {
  beforeEach(async () => {
    await saveKey(ANTHROPIC, 'sk-ant-own-0000000000000000000000000000wxyz');
  });

  it('is answered per org and per provider row, before any call is made', async () => {
    await expect(runAsOrg(OWN, () => providerUsesOrgOwnKey('anthropic'))).resolves.toBe(true);
    await expect(runAsOrg(OWN, () => providerUsesOrgOwnKey('anthropic-eu'))).resolves.toBe(false);
    await expect(runAsOrg(SHARED, () => providerUsesOrgOwnKey('anthropic'))).resolves.toBe(false);
    expect(anthropicClients).toHaveLength(3); // built, never called
  });

  it('is no for a provider that cannot be fetched, and for an object the manager did not hand out', async () => {
    await expect(runAsOrg(OWN, () => providerUsesOrgOwnKey('nowhere'))).resolves.toBe(false);
    const own = await runAsOrg(OWN, () => getProvider('anthropic'));
    expect(usesOrgOwnKey(own)).toBe(true);
    expect(usesOrgOwnKey({ ...own })).toBe(false);
  });
});

describe('with the org’s cap and the global cap reached', () => {
  beforeEach(async () => {
    await saveKey(ANTHROPIC, 'sk-ant-own-0000000000000000000000000000wxyz');
    orgCaps = { [OWN]: 10, [SHARED]: 10 };
    settings.globalCap = 15;
    spent(OWN, 10);
    spent(SHARED, 5);
  });

  it('a call on the org’s own key still goes out, and one on the platform’s for the same org is refused', async () => {
    await expect(chatOn(OWN, 'anthropic')).resolves.toMatchObject({ content: 'ok' });
    await expect(chatOn(OWN, 'anthropic-eu')).rejects.toMatchObject({ cap: 'global' });
    await expect(chatOn(SHARED, 'anthropic')).rejects.toBeInstanceOf(SpendCapExceededError);
  });

  it('with only the org’s cap reached, the platform-key call is refused for that cap', async () => {
    settings.globalCap = null;

    await expect(chatOn(OWN, 'anthropic')).resolves.toMatchObject({ content: 'ok' });
    await expect(chatOn(OWN, 'anthropic-eu')).rejects.toMatchObject({ cap: 'org' });
  });

  it('provider selection keeps an own-key primary rather than passing over it', async () => {
    const picked = await runAsOrg(OWN, () => getProviderWithFallbacks('anthropic', []));
    expect(picked.usedSlug).toBe('anthropic');

    await expect(
      runAsOrg(OWN, () => getProviderWithFallbacks('anthropic-eu', []))
    ).rejects.toMatchObject({ cap: 'global' });
  });
});

describe('own-key spend is left out of the org’s total', () => {
  beforeEach(async () => {
    await saveKey(ANTHROPIC, 'sk-ant-own-0000000000000000000000000000wxyz');
    orgCaps = { [OWN]: 10 };
    spent(OWN, 3);
  });

  it('in this process’s running total and in the month’s sum', async () => {
    /** One chat turn, on the org's own key or on the platform's: $6 either way. */
    async function turn(slug: string) {
      binding.providerSlug = slug;
      await runAsOrg(OWN, () => executeChatTurn(CHAT_TURN_STEP, makeCtx()));
      return (await settled()).at(-1);
    }

    // 3 + 6 = 9 of the platform's spend.
    expect(await turn('anthropic-eu')).toMatchObject({ ownKey: false, totalCostUsd: 6 });
    expect(await turn('anthropic')).toMatchObject({ ownKey: true, totalCostUsd: 6 });

    // Still 9, under the cap of 10: the own-key turn's $6 was not added. This
    // one takes the platform's spend to 15.
    expect(await turn('anthropic-eu')).toMatchObject({ ownKey: false });
    await expect(turn('anthropic-eu')).rejects.toMatchObject({ cap: 'org' });

    // Read again from the cost log: 3 + 6 + 6, the own-key row not summed.
    forgetSpendCaps();
    await expect(chatOn(OWN, 'anthropic-eu')).rejects.toMatchObject({ cap: 'org' });
    expect(vi.mocked(prisma.aiCostLog.aggregate)).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ orgId: OWN, ownKey: false }) })
    );
    // And the org's own key goes on answering.
    expect(await turn('anthropic')).toMatchObject({ ownKey: true });
  });

  it('in the global total, for every org', async () => {
    settings.globalCap = 10;
    spent(SHARED, 5); // the platform's spend is 3 + 5 = 8

    // $12 on the OWN org's key, well past the global cap.
    for (let i = 0; i < 2; i++) {
      await runAsOrg(OWN, () => executeChatTurn(CHAT_TURN_STEP, makeCtx()));
    }
    expect((await settled()).map((r) => r.ownKey)).toEqual([true, true]);

    await expect(chatOn(SHARED, 'anthropic')).resolves.toMatchObject({ content: 'ok' });
    forgetSpendCaps();
    await expect(chatOn(SHARED, 'anthropic')).resolves.toMatchObject({ content: 'ok' });
  });
});

describe('with the agent’s cap reached', () => {
  beforeEach(async () => {
    await saveKey(ANTHROPIC, 'sk-ant-own-0000000000000000000000000000wxyz');
  });

  /** Run `fn` in a chat turn holding paid calls, as the chat handler does. */
  async function inTurn<T>(hold: PaidCallHold, fn: () => Promise<T>): Promise<T> {
    async function* turn() {
      yield await fn();
    }
    for await (const value of withPaidCallHold(hold, turn())) return value;
    throw new Error('the turn yielded nothing');
  }

  it('both an own-key and a platform-key call are refused', async () => {
    const hold: PaidCallHold = { cap: 'agent', agentCapReached: true };

    await expect(inTurn(hold, () => chatOn(OWN, 'anthropic'))).rejects.toMatchObject({
      cap: 'agent',
    });
    await expect(inTurn(hold, () => chatOn(OWN, 'anthropic-eu'))).rejects.toMatchObject({
      cap: 'agent',
    });
  });

  it('an own-key call is refused when the turn is held for the global cap with the agent’s also reached', async () => {
    const hold: PaidCallHold = { cap: 'global', agentCapReached: true };

    await expect(inTurn(hold, () => chatOn(OWN, 'anthropic'))).rejects.toMatchObject({
      cap: 'agent',
    });
  });

  it('but a turn held for the global cap alone lets an own-key call through', async () => {
    const hold: PaidCallHold = { cap: 'global' };

    await expect(inTurn(hold, () => chatOn(OWN, 'anthropic'))).resolves.toMatchObject({
      content: 'ok',
    });
    await expect(inTurn(hold, () => chatOn(OWN, 'anthropic-eu'))).rejects.toMatchObject({
      cap: 'global',
    });
  });
});
