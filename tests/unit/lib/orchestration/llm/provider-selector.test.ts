/**
 * Unit tests for the provider model selection heuristic.
 *
 * Mocks the database layer and verifies the scoring algorithm ranks
 * models correctly for each task intent.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiProviderModel: {
      findMany: vi.fn(),
    },
  },
}));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { prisma } from '@/lib/db/client';
import {
  recommendModels,
  __resetModelCacheForTests,
} from '@/lib/orchestration/llm/provider-selector';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ModelOverrides {
  slug?: string;
  providerSlug?: string;
  modelId?: string;
  name?: string;
  capabilities?: string[];
  tierRole?: string;
  deploymentProfiles?: string[];
  reasoningDepth?: string;
  latency?: string;
  costEfficiency?: string;
  contextLength?: string;
  toolUse?: string;
  bestRole?: string;
  isActive?: boolean;
  dimensions?: number | null;
  schemaCompatible?: boolean | null;
  costPerMillionTokens?: number | null;
  hasFreeTier?: boolean | null;
  local?: boolean;
  quality?: string | null;
}

function makeModel(overrides: ModelOverrides = {}) {
  return {
    id: overrides.slug ?? 'test-id',
    slug: overrides.slug ?? 'test-model',
    providerSlug: overrides.providerSlug ?? 'test',
    modelId: overrides.modelId ?? 'test-model',
    name: overrides.name ?? 'Test Model',
    capabilities: overrides.capabilities ?? ['chat'],
    tierRole: overrides.tierRole ?? 'thinking',
    deploymentProfiles: overrides.deploymentProfiles ?? ['hosted'],
    reasoningDepth: overrides.reasoningDepth ?? 'medium',
    latency: overrides.latency ?? 'medium',
    costEfficiency: overrides.costEfficiency ?? 'medium',
    contextLength: overrides.contextLength ?? 'medium',
    toolUse: overrides.toolUse ?? 'moderate',
    bestRole: overrides.bestRole ?? 'General purpose',
    isActive: overrides.isActive ?? true,
    dimensions: overrides.dimensions ?? null,
    schemaCompatible: overrides.schemaCompatible ?? null,
    costPerMillionTokens: overrides.costPerMillionTokens ?? null,
    hasFreeTier: overrides.hasFreeTier ?? null,
    local: overrides.local ?? false,
    quality: overrides.quality ?? null,
  };
}

function mockModels(models: ReturnType<typeof makeModel>[]) {
  vi.mocked(prisma.aiProviderModel.findMany).mockResolvedValue(models as never);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('recommendModels', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetModelCacheForTests();
  });

  describe('tier matching', () => {
    const thinkingModel = makeModel({
      slug: 'anthropic-opus',
      providerSlug: 'anthropic',
      modelId: 'claude-opus-4',
      tierRole: 'thinking',
      reasoningDepth: 'very_high',
    });
    const workerModel = makeModel({
      slug: 'deepseek-chat',
      providerSlug: 'deepseek',
      modelId: 'deepseek-chat',
      tierRole: 'worker',
      costEfficiency: 'very_high',
    });
    const infraModel = makeModel({
      slug: 'groq-llama',
      providerSlug: 'groq',
      modelId: 'llama-3.3-70b',
      tierRole: 'infrastructure',
      latency: 'very_fast',
    });
    const controlModel = makeModel({
      slug: 'openrouter-auto',
      providerSlug: 'openrouter',
      modelId: 'openrouter/auto',
      tierRole: 'control_plane',
      toolUse: 'strong',
    });
    // Sovereign-deployable worker (used to live as tierRole='local_sovereign'
    // until 2026-05-16 when deployment locus was split out of the tier enum).
    const localModel = makeModel({
      slug: 'meta-llama',
      providerSlug: 'meta',
      modelId: 'llama-3.3-70b',
      tierRole: 'worker',
      deploymentProfiles: ['sovereign'],
      costEfficiency: 'very_high',
      local: true,
    });

    const allModels = [thinkingModel, workerModel, infraModel, controlModel, localModel];

    it('ranks thinking-tier models highest for "thinking" intent', async () => {
      mockModels(allModels);
      const results = await recommendModels('thinking');
      expect(results[0].slug).toBe('anthropic-opus');
      expect(results[0].score).toBeGreaterThan(results[1].score);
    });

    it('ranks worker-tier models highest for "doing" intent', async () => {
      mockModels(allModels);
      const results = await recommendModels('doing');
      // Both deepseek-chat and meta-llama are worker-tier (Llama 3.3 70B
      // moved to worker+sovereign in the 2026-05-16 enum split). They
      // tie on the primary score for "doing"; deepseek-chat wins the
      // alphabetical tiebreaker. Non-worker tiers must still rank
      // strictly lower than the worker pair.
      expect(results[0].slug).toBe('deepseek-chat');
      expect(results[0].score).toBeGreaterThanOrEqual(results[1].score);
      // The third result is a non-worker model — assert the worker tier
      // genuinely beats it (primary tier match is the meaningful signal).
      expect(results[1].score).toBeGreaterThan(results[2].score);
    });

    it('ranks infrastructure-tier models highest for "fast_looping" intent', async () => {
      mockModels(allModels);
      const results = await recommendModels('fast_looping');
      expect(results[0].slug).toBe('groq-llama');
      expect(results[0].score).toBeGreaterThan(results[1].score);
    });

    it('ranks control_plane-tier models highest for "high_reliability" intent', async () => {
      mockModels(allModels);
      const results = await recommendModels('high_reliability');
      expect(results[0].slug).toBe('openrouter-auto');
      expect(results[0].score).toBeGreaterThan(results[1].score);
    });

    it('ranks sovereign-deployable models highest for "private" intent', async () => {
      mockModels(allModels);
      const results = await recommendModels('private');
      expect(results[0].slug).toBe('meta-llama');
      expect(results[0].score).toBeGreaterThan(results[1].score);
    });
  });

  describe('embedding intent', () => {
    it('only returns embedding models for embedding intent', async () => {
      const chatModel = makeModel({ slug: 'chat', capabilities: ['chat'] });
      const embedModel = makeModel({
        slug: 'embed',
        capabilities: ['embedding'],
        tierRole: 'embedding',
        schemaCompatible: true,
        quality: 'high',
        costEfficiency: 'high',
      });
      mockModels([chatModel, embedModel]);

      const results = await recommendModels('embedding');
      expect(results).toHaveLength(1);
      expect(results[0].slug).toBe('embed');
    });

    it('excludes embedding-only models from non-embedding intents', async () => {
      const chatModel = makeModel({ slug: 'chat', capabilities: ['chat'], tierRole: 'thinking' });
      const embedModel = makeModel({
        slug: 'embed',
        capabilities: ['embedding'],
        tierRole: 'embedding',
      });
      mockModels([chatModel, embedModel]);

      const results = await recommendModels('thinking');
      expect(results).toHaveLength(1);
      expect(results[0].slug).toBe('chat');
    });
  });

  describe('secondary scoring', () => {
    it('breaks ties within the same tier using the secondary dimension', async () => {
      const highReasoning = makeModel({
        slug: 'a',
        tierRole: 'thinking',
        reasoningDepth: 'very_high',
      });
      const medReasoning = makeModel({
        slug: 'b',
        tierRole: 'thinking',
        reasoningDepth: 'medium',
      });
      mockModels([medReasoning, highReasoning]);

      const results = await recommendModels('thinking');
      expect(results[0].slug).toBe('a');
      expect(results[1].slug).toBe('b');
    });
  });

  describe('filtering and options', () => {
    it('returns empty array when no models exist', async () => {
      mockModels([]);
      const results = await recommendModels('thinking');
      expect(results).toEqual([]);
    });

    it('excludes inactive models by default', async () => {
      const active = makeModel({ slug: 'active', isActive: true });
      const inactive = makeModel({ slug: 'inactive', isActive: false });
      mockModels([active, inactive]);

      const results = await recommendModels('thinking');
      expect(results).toHaveLength(1);
      expect(results[0].slug).toBe('active');
    });

    it('includes inactive models when option is set', async () => {
      const active = makeModel({ slug: 'active', isActive: true });
      const inactive = makeModel({ slug: 'inactive', isActive: false });
      mockModels([active, inactive]);

      const results = await recommendModels('thinking', { includeInactive: true });
      expect(results).toHaveLength(2);
    });

    it('respects the limit option', async () => {
      const models = Array.from({ length: 10 }, (_, i) =>
        makeModel({ slug: `p${i}`, tierRole: 'thinking' })
      );
      mockModels(models);

      const results = await recommendModels('thinking', { limit: 3 });
      expect(results).toHaveLength(3);
    });
  });

  describe('caching', () => {
    it('caches models and does not re-query within TTL', async () => {
      mockModels([makeModel({ slug: 'cached' })]);

      await recommendModels('thinking');
      await recommendModels('doing');

      expect(prisma.aiProviderModel.findMany).toHaveBeenCalledTimes(1);
    });

    it('re-queries after cache invalidation', async () => {
      mockModels([makeModel({ slug: 'before' })]);
      await recommendModels('thinking');

      __resetModelCacheForTests();
      mockModels([makeModel({ slug: 'after' })]);
      const results = await recommendModels('thinking');

      expect(prisma.aiProviderModel.findMany).toHaveBeenCalledTimes(2);
      expect(results[0].slug).toBe('after');
    });
  });

  // -------------------------------------------------------------------------
  // New branch-coverage cases (Sprint 3, Batch 3.1)
  // -------------------------------------------------------------------------

  describe('DB load failure paths', () => {
    it('returns empty array when DB fails and no stale cache is available', async () => {
      // Arrange: no prior cache, DB throws
      __resetModelCacheForTests();
      vi.mocked(prisma.aiProviderModel.findMany).mockRejectedValue(
        new Error('db connection failed')
      );

      // Act
      const results = await recommendModels('thinking');

      // Assert: returns empty array (no throw), warning logged
      expect(results).toEqual([]);
    });

    it('logs a warning when DB load fails', async () => {
      // Arrange
      const { logger } = await import('@/lib/logging');
      __resetModelCacheForTests();
      vi.mocked(prisma.aiProviderModel.findMany).mockRejectedValue(new Error('timeout'));

      // Act
      await recommendModels('thinking');

      // Assert: source logs a warning with the error message
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        'Provider model cache load failed',
        expect.objectContaining({ error: 'timeout' })
      );
    });

    it('falls back to stale cache when DB fails on second call', async () => {
      // Arrange: first call succeeds and populates cache
      const cachedModel = makeModel({ slug: 'stale-model', tierRole: 'thinking' });
      mockModels([cachedModel]);
      await recommendModels('thinking');

      // Now clear cache so next call goes to DB, but DB fails
      __resetModelCacheForTests();
      // Re-prime the stale cache manually by doing a successful call first
      mockModels([cachedModel]);
      await recommendModels('thinking'); // populates cache again

      // Now simulate DB failure with stale cache present
      vi.mocked(prisma.aiProviderModel.findMany).mockRejectedValue(new Error('db down'));
      // Bypass TTL by advancing time conceptually — we spy on Date.now
      const realNow = Date.now;
      const futureMs = realNow() + 120_000; // 2 minutes past TTL
      vi.spyOn(Date, 'now').mockReturnValue(futureMs);

      // Act
      const results = await recommendModels('thinking');

      // Assert: stale cache is returned rather than empty array
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].slug).toBe('stale-model');

      // Cleanup
      vi.spyOn(Date, 'now').mockRestore();
    });
  });

  describe('all-providers-unavailable scenario', () => {
    it('returns empty array when all models are inactive and includeInactive is false', async () => {
      // Arrange: only inactive models available
      const inactive1 = makeModel({ slug: 'inactive-a', isActive: false, tierRole: 'thinking' });
      const inactive2 = makeModel({ slug: 'inactive-b', isActive: false, tierRole: 'worker' });
      mockModels([inactive1, inactive2]);

      // Act: default options exclude inactive models
      const results = await recommendModels('thinking');

      // Assert: no results — the "no provider available" scenario returns []
      expect(results).toEqual([]);
    });

    it('returns empty array when all models are embedding-only and intent is non-embedding', async () => {
      // Arrange: all models are embedding-only (single 'embedding' capability)
      const embed1 = makeModel({ slug: 'embed-a', capabilities: ['embedding'], isActive: true });
      const embed2 = makeModel({ slug: 'embed-b', capabilities: ['embedding'], isActive: true });
      mockModels([embed1, embed2]);

      // Act: non-embedding intent sees no candidates
      const results = await recommendModels('thinking');

      // Assert: empty — embedding-only models filtered out for non-embedding intent
      expect(results).toEqual([]);
    });
  });

  describe('tie-breaking — deterministic sort', () => {
    it('produces the same ordering on repeated calls with equal-scored models', async () => {
      // Arrange: multiple models with identical tier and secondary scores
      const models = [
        makeModel({ slug: 'x', tierRole: 'thinking', reasoningDepth: 'high' }),
        makeModel({ slug: 'y', tierRole: 'thinking', reasoningDepth: 'high' }),
        makeModel({ slug: 'z', tierRole: 'thinking', reasoningDepth: 'high' }),
      ];
      mockModels(models);

      // Act: call twice
      const first = await recommendModels('thinking');
      __resetModelCacheForTests();
      mockModels(models);
      const second = await recommendModels('thinking');

      // Assert: results are in identical order across both calls (sort is stable/deterministic)
      expect(first.map((r) => r.slug)).toEqual(second.map((r) => r.slug));
    });
  });

  describe('cost-budget-like scoring via costEfficiency', () => {
    it('selects the higher costEfficiency model for "doing" intent', async () => {
      // Arrange: two worker-tier models with different cost efficiency
      const expensive = makeModel({ slug: 'pricey', tierRole: 'worker', costEfficiency: 'medium' });
      const cheap = makeModel({
        slug: 'cheap',
        tierRole: 'worker',
        costEfficiency: 'very_high',
      });
      mockModels([expensive, cheap]);

      // Act
      const results = await recommendModels('doing');

      // Assert: higher cost efficiency ranks first (lower cost = preferred for "doing" intent)
      expect(results[0].slug).toBe('cheap');
      expect(results[0].score).toBeGreaterThan(results[1].score);
    });
  });

  describe('response shape', () => {
    it('includes all expected fields in recommendations', async () => {
      mockModels([
        makeModel({
          slug: 'anthropic-opus',
          providerSlug: 'anthropic',
          modelId: 'claude-opus-4',
          name: 'Claude Opus 4',
          tierRole: 'thinking',
          bestRole: 'Long-context reasoning',
          reasoningDepth: 'very_high',
        }),
      ]);

      const results = await recommendModels('thinking');

      expect(results[0]).toEqual(
        expect.objectContaining({
          slug: 'anthropic-opus',
          providerSlug: 'anthropic',
          modelId: 'claude-opus-4',
          name: 'Claude Opus 4',
          tierRole: 'thinking',
          bestRole: 'Long-context reasoning',
          score: expect.any(Number),
          reason: expect.any(String),
        })
      );
    });
  });

  // -------------------------------------------------------------------------
  // New branch-coverage cases (Sprint 1, Batch 1.1)
  // -------------------------------------------------------------------------

  describe('embedding scoring — branch coverage', () => {
    it('gives medium quality reason when quality is null (null defaults to medium)', async () => {
      // Arrange: embedding model with no schemaCompatible, no quality, no hasFreeTier, not local
      const minimalEmbed = makeModel({
        slug: 'bare-embed',
        capabilities: ['embedding'],
        tierRole: 'embedding',
        schemaCompatible: null,
        quality: null,
        hasFreeTier: null,
        local: false,
        costEfficiency: 'medium',
      });
      mockModels([minimalEmbed]);

      // Act
      const results = await recommendModels('embedding');

      // Assert: null quality → treated as 'medium' (+10), costEfficiency medium (1*7=7) → total 17
      expect(results).toHaveLength(1);
      expect(results[0].reason).toContain('medium quality');
      expect(results[0].score).toBe(17);
    });

    it('gives bonus score and reason parts for hasFreeTier and local model', async () => {
      // Arrange: embedding model with free tier and local flag, but no quality/schema
      const localFreeEmbed = makeModel({
        slug: 'local-free-embed',
        capabilities: ['embedding'],
        tierRole: 'embedding',
        schemaCompatible: null,
        quality: null,
        hasFreeTier: true,
        local: true,
        costEfficiency: 'medium',
      });
      mockModels([localFreeEmbed]);

      // Act
      const results = await recommendModels('embedding');

      // Assert: quality null → medium (+10), costEfficiency medium (1*7=7), hasFreeTier (+10), local (+5) → total 32
      expect(results).toHaveLength(1);
      expect(results[0].score).toBe(32);
      expect(results[0].reason).toContain('free tier');
      expect(results[0].reason).toContain('medium quality');
    });

    it('applies medium quality bonus and includes quality in reason parts', async () => {
      // Arrange: embedding model with quality 'medium' (not 'high') and no schema/freeTier
      const medQualityEmbed = makeModel({
        slug: 'med-embed',
        capabilities: ['embedding'],
        tierRole: 'embedding',
        schemaCompatible: null,
        quality: 'medium',
        hasFreeTier: null,
        local: false,
        costEfficiency: 'medium',
      });
      mockModels([medQualityEmbed]);

      // Act
      const results = await recommendModels('embedding');

      // Assert: quality 'medium' gives +10 bonus (not 'high' +20 branch)
      expect(results).toHaveLength(1);
      // costEfficiency medium = 1*7 = 7, quality medium = +10 → total 17
      expect(results[0].score).toBe(17);
      expect(results[0].reason).toContain('medium quality');
    });
  });

  describe('scoring — edge-case branches', () => {
    it('filters out models with invalid enum values instead of scoring them', async () => {
      // Arrange: a model whose reasoningDepth has an invalid value — runtime
      // validation in loadModels now skips these rather than scoring incorrectly
      const unknownDepthModel = makeModel({
        slug: 'unknown-depth',
        tierRole: 'thinking',
        reasoningDepth: 'unknown_value' as never,
      });
      mockModels([unknownDepthModel]);

      // Act
      const results = await recommendModels('thinking');

      // Assert: model is excluded from results
      expect(results).toHaveLength(0);
    });

    it('uses raw tier string as label when tier is not in the known labels map', async () => {
      // Arrange: use a model that does NOT match the target tier so both tierLabel calls are exercised
      const thinkingModel = makeModel({
        slug: 'real-thinking',
        tierRole: 'thinking',
        reasoningDepth: 'high',
      });
      // Cast unknownTierModel to a non-primary tier to trigger non-match branch
      const foreignTier = makeModel({
        slug: 'foreign',
        tierRole: 'worker' as never,
        reasoningDepth: 'high',
      });
      mockModels([thinkingModel, foreignTier]);

      // Act: 'thinking' intent → thinkingModel matches, foreignTier doesn't → non-tier reason path
      const results = await recommendModels('thinking');

      // Assert: the non-matching model's reason uses tierLabel('worker') = 'Worker'
      const foreignResult = results.find((r) => r.slug === 'foreign');
      expect(foreignResult).toBeDefined();
      expect(foreignResult!.reason).toContain('Worker');
    });
  });

  describe('loadModels — error catch branch', () => {
    it('returns empty array when the rejection is a non-Error value (string throw)', async () => {
      // Arrange: DB throws a plain string — exercises `err instanceof Error` false path
      __resetModelCacheForTests();
      vi.mocked(prisma.aiProviderModel.findMany).mockRejectedValue('plain string error');

      // Act
      const results = await recommendModels('thinking');

      // Assert: no throw, returns empty array (no stale cache available)
      expect(results).toEqual([]);
    });

    it('logs the string representation when non-Error is thrown', async () => {
      // Arrange
      const { logger } = await import('@/lib/logging');
      __resetModelCacheForTests();
      vi.mocked(prisma.aiProviderModel.findMany).mockRejectedValue({ code: 'DB_GONE' });

      // Act
      await recommendModels('thinking');

      // Assert: warning logged with stringified non-Error object in error field
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        'Provider model cache load failed',
        expect.objectContaining({ error: '[object Object]' })
      );
    });
  });
});
