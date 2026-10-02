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
import { logger } from '@/lib/logging';
import {
  CLEANUP_AGENT,
  pickCleanupBinding,
} from '@/lib/orchestration/agents/platform-agent-definitions/cleanup-agent';
import {
  forgetOrgProviderPolicy,
  forgetProviderRow,
} from '@/lib/orchestration/llm/org-provider-policy';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { runAsOrg } from '@/lib/tenancy/context';

function providerRow(slug: string, apiKeyEnvVar: string | null, isLocal = false) {
  return { slug, isLocal, apiKeyEnvVar };
}

function modelRow(
  providerSlug: string,
  modelId: string,
  tierRole = 'worker',
  reasoningDepth = 'high'
) {
  return { providerSlug, modelId, tierRole, reasoningDepth };
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
    const { client, modelFindMany } = db(
      [providerRow('openai', 'OPENAI_API_KEY')],
      [modelRow('openai', 'gpt-4o'), modelRow('openai', 'gpt-4.1')]
    );

    expect(await pickCleanupBinding(client)).toEqual({ provider: 'openai', model: 'gpt-4.1' });
    expect(modelFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          providerSlug: { in: ['openai'] },
          toolUse: 'strong',
          capabilities: { has: 'chat' },
        }),
      })
    );
  });

  it('prefers a worker-tier model over a thinking-tier one', async () => {
    // A whole-document rewrite on a thinking-tier model costs far more and is
    // no better at choosing between two regex tools.
    const { client } = db(
      [providerRow('openai', 'OPENAI_API_KEY')],
      [modelRow('openai', 'gpt-5', 'thinking', 'very_high'), modelRow('openai', 'gpt-4.1')]
    );

    expect(await pickCleanupBinding(client)).toEqual({ provider: 'openai', model: 'gpt-4.1' });
  });

  it('ignores a provider whose api-key env var is not set', async () => {
    // Pinning an unreachable provider would break a path that works today.
    delete process.env.NOT_SET_KEY;
    const { client, modelFindMany } = db(
      [providerRow('ghost', 'NOT_SET_KEY')],
      [modelRow('ghost', 'ghost-1')]
    );

    expect(await pickCleanupBinding(client)).toBeNull();
    expect(modelFindMany).not.toHaveBeenCalled(); // test-review:accept no_arg_called — nothing reachable, so no model read at all
  });

  it('accepts a local provider that needs no api key', async () => {
    const { client } = db([providerRow('ollama', null, true)], [modelRow('ollama', 'llama3')]);

    expect(await pickCleanupBinding(client)).toEqual({ provider: 'ollama', model: 'llama3' });
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
    expect(await pickCleanupBinding(client)).toEqual({
      provider: 'openai',
      model: 'c-worker-medium',
    });
  });

  it('prefers a control-plane model to one of an unknown tier', async () => {
    const { client } = db(
      [providerRow('openai', 'OPENAI_API_KEY')],
      [modelRow('openai', 'a-unknown', 'mystery'), modelRow('openai', 'z-control', 'control_plane')]
    );

    expect(await pickCleanupBinding(client)).toEqual({ provider: 'openai', model: 'z-control' });
  });

  it('returns null when no reachable model is tool-capable', async () => {
    const { client } = db([providerRow('openai', 'OPENAI_API_KEY')], []);

    expect(await pickCleanupBinding(client)).toBeNull();
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

  /**
   * Both providers reachable; openai has the stronger pick. The model query
   * honours its `providerSlug` filter, as the real one does.
   */
  function reachableBoth() {
    const models = [
      modelRow('openai', 'gpt-4.1'),
      modelRow('anthropic', 'claude-sonnet', 'thinking'),
    ];
    const handle = db(
      [providerRow('openai', 'OPENAI_API_KEY'), providerRow('anthropic', 'ANTHROPIC_API_KEY')],
      models
    );
    handle.modelFindMany.mockImplementation(
      async (args: { where: { providerSlug: { in: string[] } } }) =>
        models.filter((m) => args.where.providerSlug.in.includes(m.providerSlug))
    );
    return handle;
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

    expect(await runAsOrg(ORG, () => pickCleanupBinding(client))).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet',
    });
  });

  it('pins nothing for an org approved for no provider, so the agent inherits', async () => {
    approve();
    const { client, modelFindMany } = reachableBoth();

    expect(await runAsOrg(ORG, () => pickCleanupBinding(client))).toBeNull();
    expect(modelFindMany).not.toHaveBeenCalled(); // test-review:accept no_arg_called — nothing usable, so no model read at all
  });

  it('pins nothing, and says why, when the policy cannot be read', async () => {
    vi.mocked(prisma.org.findUnique).mockRejectedValue(new Error('connection reset'));
    const { client } = reachableBoth();

    expect(await runAsOrg(ORG, () => pickCleanupBinding(client))).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      'Cleanup agent left unpinned: the org provider policy could not be read',
      { error: 'connection reset' }
    );
  });

  it('pins nothing with no org in scope', async () => {
    const { client } = reachableBoth();

    expect(await pickCleanupBinding(client)).toBeNull();
  });

  it('is unchanged for the install org, which may use every provider', async () => {
    const { client } = reachableBoth();

    expect(await runAsOrg(INSTALL_ORG_ID, () => pickCleanupBinding(client))).toEqual({
      provider: 'openai',
      model: 'gpt-4.1',
    });
    expect(prisma.org.findUnique).not.toHaveBeenCalled();
  });

  it('is unchanged at single, whatever the org has been granted', async () => {
    mockMode.value = 'single';
    approve();
    const { client } = reachableBoth();

    expect(await runAsOrg(ORG, () => pickCleanupBinding(client))).toEqual({
      provider: 'openai',
      model: 'gpt-4.1',
    });
  });
});
