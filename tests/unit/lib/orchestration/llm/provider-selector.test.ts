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
    const localModel = makeModel({
      slug: 'meta-llama',
      providerSlug: 'meta',
      modelId: 'llama-3.3-70b',
      tierRole: 'local_sovereign',
      costEfficiency: 'very_high',
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
      expect(results[0].slug).toBe('deepseek-chat');
      expect(results[0].score).toBeGreaterThan(results[1].score);
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

    it('ranks local_sovereign-tier models highest for "private" intent', async () => {
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
});
