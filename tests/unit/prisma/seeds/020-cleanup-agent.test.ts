import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import cleanupAgentSeed from '@/prisma/seeds/020-cleanup-agent';
import { serviceAccountWhere } from '@/lib/auth/account';
import type { SeedContext } from '@/prisma/runner';

/**
 * Tests for the `020-cleanup-agent` seed.
 *
 * The contract this seed must hold:
 *  - it throws when no config owner exists, rather than seeding an agent with
 *    a dangling `createdBy`, and it resolves that owner via
 *    `serviceAccountWhere` — the non-login SERVICE principal 001-system-owner
 *    creates — never a raw `role: 'ADMIN'` literal and never a *human* admin.
 *    A human admin exists only under the dev-only 001-test-users profile, so
 *    requiring one aborted the profile-gated seed run CI and `docker-compose
 *    up` use on a fresh database;
 *  - the agent upsert only sets `isSystem: true` on update, so an admin's
 *    edits to the prompt, model, or temperature survive re-seeding;
 *  - it binds every slug in its capability list, skipping (not throwing on)
 *    a capability that hasn't been seeded yet;
 *  - it pins the strongest REACHABLE tool-using model (an active provider
 *    whose api-key env var is set), and never overwrites a binding or a
 *    prompt a human has already changed.
 */

const CAPABILITY_SLUGS = [
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
];

/** Provider rows the pin helper reads. `key` is the env var it checks. */
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

function makeCtx({
  ownerFound = true,
  missingSlugs = new Set<string>(),
  providers = [providerRow('openai', 'OPENAI_API_KEY')],
  models = [modelRow('openai', 'gpt-4.1')],
  untouchedAgent = null as { id: string; systemInstructions: string } | null,
} = {}) {
  const userFindFirst = vi.fn().mockResolvedValue(ownerFound ? { id: 'system-owner-1' } : null);
  const agentUpsert = vi.fn().mockResolvedValue({ id: 'agent-cleanup-1' });
  const agentUpdateMany = vi.fn().mockResolvedValue({ count: 0 });
  const agentFindFirst = vi.fn().mockResolvedValue(untouchedAgent);
  const agentUpdate = vi.fn().mockResolvedValue({});
  const providerFindMany = vi.fn().mockResolvedValue(providers);
  const modelFindMany = vi.fn().mockResolvedValue(models);
  const capabilityFindUnique = vi
    .fn()
    .mockImplementation(({ where: { slug } }) =>
      Promise.resolve(missingSlugs.has(slug) ? null : { id: `cap-${slug}` })
    );
  const agentCapabilityUpsert = vi.fn().mockResolvedValue({});
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

  const ctx = {
    prisma: {
      user: { findFirst: userFindFirst },
      aiAgent: {
        upsert: agentUpsert,
        updateMany: agentUpdateMany,
        findFirst: agentFindFirst,
        update: agentUpdate,
      },
      aiProviderConfig: { findMany: providerFindMany },
      aiProviderModel: { findMany: modelFindMany },
      aiCapability: { findUnique: capabilityFindUnique },
      aiAgentCapability: { upsert: agentCapabilityUpsert },
    },
    logger,
  } as unknown as SeedContext;

  return {
    ctx,
    userFindFirst,
    agentUpsert,
    agentUpdateMany,
    agentFindFirst,
    agentUpdate,
    providerFindMany,
    modelFindMany,
    capabilityFindUnique,
    agentCapabilityUpsert,
    logger,
  };
}

describe('020-cleanup-agent seed', () => {
  // The pin helper only accepts a provider whose api-key env var is actually
  // set, so the default fixture's provider needs one present.
  const savedKey = process.env.OPENAI_API_KEY;
  beforeEach(() => {
    process.env.OPENAI_API_KEY = 'test-key';
  });
  afterEach(() => {
    if (savedKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = savedKey;
  });

  it('throws when no config owner exists', async () => {
    const { ctx } = makeCtx({ ownerFound: false });

    await expect(cleanupAgentSeed.run(ctx)).rejects.toThrow(/no config owner found/i);
  });

  it('looks up the owner via serviceAccountWhere, not a human admin or a raw role literal', async () => {
    const { ctx, userFindFirst } = makeCtx();

    await cleanupAgentSeed.run(ctx);

    expect(userFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: serviceAccountWhere })
    );
  });

  it('upserts the agent with isSystem-only on update, attributed to the config owner on create', async () => {
    const { ctx, agentUpsert } = makeCtx();

    await cleanupAgentSeed.run(ctx);

    expect(agentUpsert).toHaveBeenCalledTimes(1);
    const arg = agentUpsert.mock.calls[0][0];
    // Keyed per org (§107 t-708): the seed runs for the install org.
    expect(arg.where).toEqual({ orgId_slug: { orgId: 'install', slug: 'cleanup-agent' } });
    expect(arg.update).toEqual({ isSystem: true });
    expect(arg.create).toMatchObject({
      slug: 'cleanup-agent',
      isSystem: true,
      isActive: true,
      visibility: 'internal',
      knowledgeAccessMode: 'restricted',
      temperature: 0.2,
      createdBy: 'system-owner-1',
    });
  });

  describe('model pin', () => {
    it('pins the strongest reachable tool-using model on create', async () => {
      // gpt-4o and gpt-4.1 are both worker-tier with strong tools; the
      // tie-break is the model id, so the pin must be deterministic.
      const { ctx, agentUpsert } = makeCtx({
        models: [modelRow('openai', 'gpt-4o'), modelRow('openai', 'gpt-4.1')],
      });

      await cleanupAgentSeed.run(ctx);

      expect(agentUpsert.mock.calls[0][0].create).toMatchObject({
        provider: 'openai',
        model: 'gpt-4.1',
      });
    });

    it('prefers a worker-tier model over a thinking-tier one', async () => {
      // A whole-document rewrite on a thinking-tier model costs far more and
      // is no better at choosing between two regex tools.
      const { ctx, agentUpsert } = makeCtx({
        models: [
          modelRow('openai', 'gpt-5', 'thinking', 'very_high'),
          modelRow('openai', 'gpt-4.1', 'worker', 'high'),
        ],
      });

      await cleanupAgentSeed.run(ctx);

      expect(agentUpsert.mock.calls[0][0].create).toMatchObject({ model: 'gpt-4.1' });
    });

    it('ignores a provider whose api-key env var is not set', async () => {
      // Pinning an unreachable provider would be worse than inheriting: it
      // breaks a path that currently works.
      delete process.env.NOT_SET_KEY;
      const { ctx, agentUpsert } = makeCtx({
        providers: [providerRow('ghost', 'NOT_SET_KEY')],
        models: [modelRow('ghost', 'ghost-1')],
      });

      await cleanupAgentSeed.run(ctx);

      // Empty strings are the inherit-at-runtime contract.
      expect(agentUpsert.mock.calls[0][0].create).toMatchObject({ provider: '', model: '' });
    });

    it('accepts a local provider that needs no api key', async () => {
      const { ctx, agentUpsert } = makeCtx({
        providers: [providerRow('ollama', null, true)],
        models: [modelRow('ollama', 'llama3')],
      });

      await cleanupAgentSeed.run(ctx);

      expect(agentUpsert.mock.calls[0][0].create).toMatchObject({
        provider: 'ollama',
        model: 'llama3',
      });
    });

    it('fills an existing agent binding only while both fields are still empty', async () => {
      const { ctx, agentUpdateMany } = makeCtx();

      await cleanupAgentSeed.run(ctx);

      expect(agentUpdateMany).toHaveBeenCalledWith({
        // The empty-string predicate is what protects an admin's own choice.
        where: { slug: 'cleanup-agent', provider: '', model: '' },
        data: { provider: 'openai', model: 'gpt-4.1' },
      });
    });

    it('does not touch an existing binding when nothing is reachable', async () => {
      const { ctx, agentUpdateMany } = makeCtx({ providers: [], models: [] });

      await cleanupAgentSeed.run(ctx);

      expect(agentUpdateMany).not.toHaveBeenCalled(); // test-review:accept no_arg_called — the guard is that no write happens at all
    });
  });

  describe('prompt refresh', () => {
    it('refreshes the prompt of an agent no admin has ever edited', async () => {
      const { ctx, agentUpdate } = makeCtx({
        untouchedAgent: { id: 'agent-cleanup-1', systemInstructions: 'an older seeded prompt' },
      });

      await cleanupAgentSeed.run(ctx);

      expect(agentUpdate).toHaveBeenCalledTimes(1);
      const arg = agentUpdate.mock.calls[0][0];
      expect(arg.where).toEqual({ id: 'agent-cleanup-1' });
      // The new prompt must be the one this seed defines — assert on content
      // that only the current version has.
      expect(arg.data.systemInstructions).toContain('join_wrapped_lines');
      expect(arg.data.systemInstructions).toContain('read_document');
    });

    it('queries only agents with an empty instructions history, so an admin edit is never clobbered', async () => {
      const { ctx, agentFindFirst } = makeCtx({ untouchedAgent: null });

      await cleanupAgentSeed.run(ctx);

      expect(agentFindFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ systemInstructionsHistory: { equals: [] } }),
        })
      );
    });

    it('does not rewrite a prompt that already matches the seed', async () => {
      // Re-seeding is idempotent: only a genuinely different prompt is written.
      const { ctx, agentFindFirst, agentUpdate } = makeCtx();
      const current = (await import('@/prisma/seeds/020-cleanup-agent')).default;
      // Run once to discover the prompt the seed writes, then feed it back.
      await current.run(ctx);
      const written = ctx.prisma.aiAgent.upsert as unknown as {
        mock: { calls: { 0: { create: { systemInstructions: string } } }[] };
      };
      const seeded = written.mock.calls[0][0].create.systemInstructions;

      agentFindFirst.mockResolvedValue({ id: 'agent-cleanup-1', systemInstructions: seeded });
      agentUpdate.mockClear();
      await current.run(ctx);

      expect(agentUpdate).not.toHaveBeenCalled(); // test-review:accept no_arg_called — idempotence guard: no write at all
    });
  });

  it('binds every capability slug in the list', async () => {
    const { ctx, agentCapabilityUpsert } = makeCtx();

    await cleanupAgentSeed.run(ctx);

    expect(agentCapabilityUpsert).toHaveBeenCalledTimes(CAPABILITY_SLUGS.length);
    for (const call of agentCapabilityUpsert.mock.calls) {
      expect(call[0].create).toMatchObject({
        agentId: 'agent-cleanup-1',
        isEnabled: true,
      });
    }
  });

  it('skips (does not throw on) a capability that has not been seeded yet', async () => {
    const { ctx, agentCapabilityUpsert, logger } = makeCtx({
      missingSlugs: new Set(['rewrite_with_llm']),
    });

    await expect(cleanupAgentSeed.run(ctx)).resolves.toBeUndefined();

    expect(agentCapabilityUpsert).toHaveBeenCalledTimes(CAPABILITY_SLUGS.length - 1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/rewrite_with_llm/));
  });

  it('declares the expected seed unit name', () => {
    expect(cleanupAgentSeed.name).toBe('020-cleanup-agent');
  });
});
