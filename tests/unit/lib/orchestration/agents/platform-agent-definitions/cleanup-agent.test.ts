/**
 * Tests: the clean-up assistant's starting model (§116 t-724; moved from the
 * retired `020-cleanup-agent` seed).
 *
 * Cleanup is a tool-choice-heavy task, so rather than inherit the install's
 * default chat model the agent starts on the strongest tool-using model the
 * org can actually REACH. When to consult this — only while the org has
 * chosen neither provider nor model — is the reconcile's rule and is tested
 * there.
 *
 * @see lib/orchestration/agents/platform-agent-definitions/cleanup-agent.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The org provider policy (§120 t-746) runs for real; only the tenancy mode
// and the global client it reads the policy through are stubbed. Single by
// default, so the picker's own tests below are unaffected by it.
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
    org: { findUnique: vi.fn() },
    aiProviderConfig: { findMany: vi.fn() },
  },
}));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { prisma } from '@/lib/db/client';
import type { TenancyClient } from '@/lib/db/tenancy-extension';
import {
  CLEANUP_AGENT,
  pickCleanupBinding,
} from '@/lib/orchestration/agents/platform-agent-definitions/cleanup-agent';
import { createPlatformAgentCatalogue } from '@/lib/orchestration/agents/platform-agents';
import {
  forgetOrgProviderPolicy,
  forgetProviderRow,
} from '@/lib/orchestration/llm/org-provider-policy';
import {
  registerProviderEligibility,
  resetProviderEligibility,
} from '@/lib/orchestration/llm/provider-eligibility';
import {
  registerProviderCredentialResolver,
  resetProviderCredentialResolver,
} from '@/lib/orchestration/llm/provider-credentials';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { runAsOrg } from '@/lib/tenancy/context';

function providerRow(slug: string, apiKeyEnvVar: string | null, isLocal = false) {
  return { slug, isLocal, apiKeyEnvVar };
}

function modelRow(
  providerSlug: string,
  modelId: string,
  tierRole = 'worker',
  reasoningDepth = 'high',
  {
    toolUse = 'strong',
    capabilities = ['chat'],
  }: { toolUse?: string; capabilities?: string[] } = {}
) {
  return { providerSlug, modelId, tierRole, reasoningDepth, toolUse, capabilities };
}

/** The pick with a catalogue of its own, as every caller but the job asks it. */
function pick(client: TenancyClient) {
  return pickCleanupBinding(client, createPlatformAgentCatalogue());
}

function db(providers: unknown[], models: unknown[]) {
  const modelFindMany = vi.fn().mockResolvedValue(models);
  return {
    client: {
      aiProviderConfig: { findMany: vi.fn().mockResolvedValue(providers) },
      aiProviderModel: { findMany: modelFindMany },
    } as unknown as TenancyClient,
    modelFindMany,
  };
}

describe('pickCleanupBinding', () => {
  const savedKey = process.env.OPENAI_API_KEY;
  beforeEach(() => {
    process.env.OPENAI_API_KEY = 'test-key';
  });
  afterEach(() => {
    if (savedKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = savedKey;
  });

  it('picks the strongest reachable tool-using model, with a stable tie-break', async () => {
    // Both worker-tier with strong tools; the model id decides.
    const { client } = db(
      [providerRow('openai', 'OPENAI_API_KEY')],
      [modelRow('openai', 'gpt-4o'), modelRow('openai', 'gpt-4.1')]
    );

    expect(await pick(client)).toEqual({ provider: 'openai', model: 'gpt-4.1' });
  });

  it('picks only a strong tool-using chat model of a reachable provider (t-816)', async () => {
    // The catalogue holds every active model; the pick filters it. Each of
    // these would win the ranking (worker tier, very high, first by id) if a
    // filter were missing.
    delete process.env.NOT_SET_KEY;
    const { client } = db(
      [providerRow('openai', 'OPENAI_API_KEY'), providerRow('ghost', 'NOT_SET_KEY')],
      [
        modelRow('ghost', 'a-unreachable', 'worker', 'very_high'),
        modelRow('openai', 'b-weak-tools', 'worker', 'very_high', { toolUse: 'moderate' }),
        modelRow('openai', 'c-no-chat', 'worker', 'very_high', { capabilities: ['embedding'] }),
        modelRow('openai', 'z-eligible', 'worker', 'medium'),
      ]
    );

    expect(await pick(client)).toEqual({ provider: 'openai', model: 'z-eligible' });
  });

  it('gives the same answer whatever order the database returns two providers of one model in (t-798)', async () => {
    // The job re-asks every pass: an order-dependent answer would move the
    // agent between the two providers, and version it, every 15 minutes.
    const providers = [
      providerRow('openai', 'OPENAI_API_KEY'),
      providerRow('azure', 'OPENAI_API_KEY'),
    ];
    const models = [modelRow('openai', 'gpt-4.1'), modelRow('azure', 'gpt-4.1')];

    expect(await pick(db(providers, models).client)).toEqual({
      provider: 'azure',
      model: 'gpt-4.1',
    });
    expect(await pick(db(providers, [...models].reverse()).client)).toEqual({
      provider: 'azure',
      model: 'gpt-4.1',
    });
  });

  it('orders model ids by code unit, so every instance agrees whatever its locale', async () => {
    // `localeCompare` puts 'a…' before 'B…' in most locales; code units do not.
    const { client } = db(
      [providerRow('openai', 'OPENAI_API_KEY')],
      [modelRow('openai', 'a-model'), modelRow('openai', 'B-model')]
    );
    expect(await pick(client)).toEqual({ provider: 'openai', model: 'B-model' });
  });

  it('prefers a worker-tier model over a thinking-tier one', async () => {
    // A whole-document rewrite on a thinking-tier model costs far more and is
    // no better at choosing between two regex tools.
    const { client } = db(
      [providerRow('openai', 'OPENAI_API_KEY')],
      [modelRow('openai', 'gpt-5', 'thinking', 'very_high'), modelRow('openai', 'gpt-4.1')]
    );

    expect(await pick(client)).toEqual({ provider: 'openai', model: 'gpt-4.1' });
  });

  it('ignores a provider whose api-key env var is not set', async () => {
    // Pinning an unreachable provider would break a path that works today.
    delete process.env.NOT_SET_KEY;
    const { client, modelFindMany } = db(
      [providerRow('ghost', 'NOT_SET_KEY')],
      [modelRow('ghost', 'ghost-1')]
    );

    expect(await pick(client)).toBeNull();
    expect(modelFindMany).not.toHaveBeenCalled(); // test-review:accept no_arg_called — nothing reachable, so no model read at all
  });

  it('accepts a local provider that needs no api key', async () => {
    const { client } = db([providerRow('ollama', null, true)], [modelRow('ollama', 'llama3')]);

    expect(await pick(client)).toEqual({ provider: 'ollama', model: 'llama3' });
  });

  it('breaks a tier tie by reasoning depth, and ranks an unknown tier or depth last', async () => {
    const { client } = db(
      [providerRow('openai', 'OPENAI_API_KEY')],
      [
        modelRow('openai', 'a-unknown-tier', 'mystery', 'very_high'),
        modelRow('openai', 'b-worker-unknown-depth', 'worker', 'mystery'),
        modelRow('openai', 'c-worker-medium', 'worker', 'medium'),
        modelRow('openai', 'd-control', 'control_plane', 'very_high'),
      ]
    );

    // Worker tier first; within it, a known depth beats an unknown one.
    expect(await pick(client)).toEqual({
      provider: 'openai',
      model: 'c-worker-medium',
    });
  });

  it('prefers a control-plane model to one of an unknown tier', async () => {
    const { client } = db(
      [providerRow('openai', 'OPENAI_API_KEY')],
      [modelRow('openai', 'a-unknown', 'mystery'), modelRow('openai', 'z-control', 'control_plane')]
    );

    expect(await pick(client)).toEqual({ provider: 'openai', model: 'z-control' });
  });

  it('returns null when no reachable model is tool-capable', async () => {
    const { client } = db([providerRow('openai', 'OPENAI_API_KEY')], []);

    expect(await pick(client)).toBeNull();
  });
});

describe('CLEANUP_AGENT', () => {
  it('is bound to all fourteen cleanup capabilities and consults the picker', () => {
    expect(CLEANUP_AGENT.capabilities).toEqual([
      'read_document',
      'find_in_document',
      'strip_lines_matching',
      'strip_matches',
      'strip_timestamps',
      'strip_speaker_labels',
      'collapse_whitespace',
      'join_wrapped_lines',
      'dedupe_lines',
      'normalise_punctuation',
      'preview_diff',
      'estimate_size',
      'rewrite_with_llm',
      'rewrite_section_with_llm',
    ]);
    expect(CLEANUP_AGENT.defaultBinding).toBe(pickCleanupBinding);
    // Content only the current prompt has.
    expect(CLEANUP_AGENT.agent.systemInstructions).toContain('join_wrapped_lines');
  });
});

describe('pickCleanupBinding — the org provider policy (§120 t-746)', () => {
  const ORG = 'cmorg00000000000000grant';
  const saved = { openai: process.env.OPENAI_API_KEY, anthropic: process.env.ANTHROPIC_API_KEY };

  /** Both providers reachable; openai has the stronger pick. */
  function reachableBoth() {
    return db(
      [providerRow('openai', 'OPENAI_API_KEY'), providerRow('anthropic', 'ANTHROPIC_API_KEY')],
      [modelRow('openai', 'gpt-4.1'), modelRow('anthropic', 'claude-sonnet', 'thinking')]
    );
  }

  /** The org is approved for these provider rows (by id). */
  function approve(...slugs: string[]) {
    vi.mocked(prisma.org.findUnique).mockResolvedValue({
      settings: { providers: { approved: slugs.map((slug) => `id-${slug}`) } },
    } as never);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockMode.value = 'multi';
    forgetOrgProviderPolicy();
    forgetProviderRow();
    resetProviderEligibility();
    resetProviderCredentialResolver();
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.ANTHROPIC_API_KEY = 'test-key';
    vi.mocked(prisma.aiProviderConfig.findMany).mockImplementation((async (args: {
      where: { OR: [{ slug: { in: string[] } }, unknown] };
    }) =>
      args.where.OR[0].slug.in.map((slug) => ({
        id: `id-${slug}`,
        slug,
        name: slug,
        jurisdiction: null,
      }))) as never);
  });
  afterEach(() => {
    mockMode.value = 'single';
    resetProviderEligibility();
    resetProviderCredentialResolver();
    for (const [name, value] of [
      ['OPENAI_API_KEY', saved.openai],
      ['ANTHROPIC_API_KEY', saved.anthropic],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('picks only among providers the org is approved for', async () => {
    approve('anthropic');
    const { client } = reachableBoth();

    expect(await runAsOrg(ORG, () => pick(client))).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet',
    });
  });

  it('pins nothing for an org approved for no provider, so the agent inherits', async () => {
    approve();
    const { client, modelFindMany } = reachableBoth();

    expect(await runAsOrg(ORG, () => pick(client))).toBeNull();
    expect(modelFindMany).not.toHaveBeenCalled(); // test-review:accept no_arg_called — nothing usable, so no model read at all
  });

  it('pins once the org is granted providers and its cached policy is forgotten (t-798)', async () => {
    // The provider-grant route's order: write the grant, forget the cached
    // policy, then reconcile. A new org has no grant, so its first pick is null.
    approve();
    const { client } = reachableBoth();
    expect(await runAsOrg(ORG, () => pick(client))).toBeNull();

    approve('anthropic');
    // Still the cached empty policy: reconciling before the forget pins nothing.
    expect(await runAsOrg(ORG, () => pick(client))).toBeNull();

    forgetOrgProviderPolicy(ORG);
    expect(await runAsOrg(ORG, () => pick(client))).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet',
    });
  });

  it('throws when the policy cannot be read, so the reconcile fails and is retried', async () => {
    // Answering null here would be recorded as done: the reconcile writes its
    // marker and never asks again.
    vi.mocked(prisma.org.findUnique).mockRejectedValue(new Error('connection reset'));
    const { client } = reachableBoth();

    await expect(runAsOrg(ORG, () => pick(client))).rejects.toMatchObject({
      name: 'ProviderSeamUnavailableError',
      cause: expect.objectContaining({ message: 'connection reset' }),
    });
  });

  it("throws when a fork's eligibility resolver throws, rather than pinning nothing (t-819)", async () => {
    // Null would move the agent to inherit, version the move, and move it
    // back on the next pass once the resolver's backend was up again.
    registerProviderEligibility(() => {
      throw new Error('policy service down');
    });
    const { client } = reachableBoth();

    await expect(runAsOrg(INSTALL_ORG_ID, () => pick(client))).rejects.toMatchObject({
      name: 'ProviderSeamUnavailableError',
      cause: expect.objectContaining({ message: 'policy service down' }),
    });
  });

  it("throws when a fork's credential resolver fails for the provider that would win (t-819)", async () => {
    registerProviderCredentialResolver((config) => {
      if (config.slug === 'openai') throw new Error('vault down');
      return { apiKey: 'k', identity: '' };
    });
    const { client } = reachableBoth();

    await expect(runAsOrg(INSTALL_ORG_ID, () => pick(client))).rejects.toMatchObject({
      name: 'ProviderSeamUnavailableError',
      message: expect.stringContaining('"openai"'),
      cause: expect.objectContaining({ code: 'credential_unavailable' }),
    });
  });

  it('picks as usual when the credential resolver fails only for a provider that could not win (t-819)', async () => {
    // A resolver may throw for a provider it does not serve. Here that is
    // anthropic, whose only model ranks below openai's: its key cannot change
    // the answer, so the pick need not wait for it.
    registerProviderCredentialResolver((config) => {
      if (config.slug === 'anthropic') throw new Error('not served');
      return { apiKey: 'k', identity: '' };
    });
    const { client } = reachableBoth();

    expect(await runAsOrg(INSTALL_ORG_ID, () => pick(client))).toEqual({
      provider: 'openai',
      model: 'gpt-4.1',
    });
  });

  it('picks as usual when the resolver fails for a provider with no model the agent can use (t-819)', async () => {
    // An embedding-only row, say: it would have the best rank if it qualified.
    registerProviderCredentialResolver((config) => {
      if (config.slug === 'voyage') throw new Error('not served');
      return { apiKey: 'k', identity: '' };
    });
    const { client } = db(
      [providerRow('voyage', 'OPENAI_API_KEY'), providerRow('anthropic', 'ANTHROPIC_API_KEY')],
      [
        modelRow('voyage', 'a-embed', 'worker', 'very_high', { capabilities: ['embedding'] }),
        modelRow('anthropic', 'claude-sonnet', 'thinking'),
      ]
    );

    expect(await runAsOrg(INSTALL_ORG_ID, () => pick(client))).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet',
    });
  });

  it('asks the credential resolver only about providers the org may use', async () => {
    // The resolver may call out to a vault; the eligibility rule is asked first.
    registerProviderEligibility((candidates) => candidates.filter((slug) => slug !== 'openai'));
    const asked: string[] = [];
    registerProviderCredentialResolver((config) => {
      asked.push(config.slug);
      return { apiKey: 'k', identity: '' };
    });
    const { client } = reachableBoth();

    expect(await runAsOrg(INSTALL_ORG_ID, () => pick(client))).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet',
    });
    expect(asked).toEqual(['anthropic']);
  });

  it('pins nothing, and asks no rule, when no provider is active', async () => {
    const rule = vi.fn((candidates: readonly string[]) => candidates);
    registerProviderEligibility(rule);
    const { client, modelFindMany } = db([], []);

    expect(await runAsOrg(INSTALL_ORG_ID, () => pick(client))).toBeNull();
    expect(rule).not.toHaveBeenCalled(); // test-review:accept no_arg_called — nothing to ask about
    expect(modelFindMany).not.toHaveBeenCalled(); // test-review:accept no_arg_called — nothing to ask about
  });

  it('still pins nothing when the resolvers answer, but answer "none" (t-819)', async () => {
    // The other side of the two tests above: a real "no" is still null.
    registerProviderCredentialResolver(() => ({ apiKey: undefined, identity: '' }));
    const { client } = reachableBoth();

    expect(await runAsOrg(INSTALL_ORG_ID, () => pick(client))).toBeNull();
  });

  it("does not pin a provider a fork's eligibility rule refuses to an explicit provider", async () => {
    const contexts: unknown[] = [];
    registerProviderEligibility((candidates, context) => {
      contexts.push(context);
      return candidates.filter((slug) => slug !== 'openai');
    });
    const { client } = reachableBoth();

    expect(await runAsOrg(INSTALL_ORG_ID, () => pick(client))).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet',
    });
    // Asked as the call-time gate asks it of a pinned provider.
    expect(contexts).toEqual([{ task: 'chat', source: 'explicit', primarySlug: null }]);
  });

  it('pins nothing with no org in scope', async () => {
    const { client } = reachableBoth();

    expect(await pick(client)).toBeNull();
  });

  it('is unchanged for the install org, which may use every provider', async () => {
    const { client } = reachableBoth();

    expect(await runAsOrg(INSTALL_ORG_ID, () => pick(client))).toEqual({
      provider: 'openai',
      model: 'gpt-4.1',
    });
    expect(prisma.org.findUnique).not.toHaveBeenCalled();
  });

  it('is unchanged at single, whatever the org has been granted', async () => {
    mockMode.value = 'single';
    approve();
    const { client } = reachableBoth();

    expect(await runAsOrg(ORG, () => pick(client))).toEqual({
      provider: 'openai',
      model: 'gpt-4.1',
    });
  });
});
