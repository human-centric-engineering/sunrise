/**
 * Embedding Model Registry Tests
 *
 * Tests for the static embedding model catalogue and filter helper.
 *
 * Test Coverage:
 * - EMBEDDING_MODELS array: expected entries, required fields, structural integrity
 * - filterEmbeddingModels(): no filters, schemaCompatibleOnly, hasFreeTier, local true/false
 * - Combined filter scenarios
 * - getEmbeddingModels(): DB-driven path, empty-DB fallback, DB-error fallback, sorting
 * - getEmbeddingModelsFromDb() field mapping (provider display names, nullable defaults)
 *
 * @see lib/orchestration/llm/embedding-models.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  EMBEDDING_MODELS,
  filterEmbeddingModels,
  getEmbeddingModels,
  type EmbeddingModelInfo,
} from '@/lib/orchestration/llm/embedding-models';

// ---------------------------------------------------------------------------
// Module-level mocks required for getEmbeddingModels / getEmbeddingModelsFromDb
// ---------------------------------------------------------------------------

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiProviderModel: {
      findMany: vi.fn(),
    },
  },
}));

vi.mock('@/lib/logging', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Imports that depend on the mocks above (must come after vi.mock calls)
// ---------------------------------------------------------------------------

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';

// ---------------------------------------------------------------------------
// EMBEDDING_MODELS catalogue
// ---------------------------------------------------------------------------

describe('EMBEDDING_MODELS', () => {
  it('should contain exactly 9 models', () => {
    expect(EMBEDDING_MODELS).toHaveLength(9);
  });

  it('should include the Voyage voyage-3 model', () => {
    // Arrange
    const expectedId = 'voyage/voyage-3';

    // Act
    const model = EMBEDDING_MODELS.find((m) => m.id === expectedId);

    // Assert
    expect(model).toBeDefined();
    expect(model?.provider).toBe('Voyage AI');
    expect(model?.model).toBe('voyage-3');
  });

  it('should include OpenAI text-embedding-3-small', () => {
    const model = EMBEDDING_MODELS.find((m) => m.id === 'openai/text-embedding-3-small');
    expect(model).toBeDefined();
    expect(model?.provider).toBe('OpenAI');
  });

  it('should include OpenAI text-embedding-3-large', () => {
    const model = EMBEDDING_MODELS.find((m) => m.id === 'openai/text-embedding-3-large');
    expect(model).toBeDefined();
    expect(model?.provider).toBe('OpenAI');
  });

  it('should include Cohere embed-english-v3.0', () => {
    const model = EMBEDDING_MODELS.find((m) => m.id === 'cohere/embed-english-v3.0');
    expect(model).toBeDefined();
    expect(model?.provider).toBe('Cohere');
  });

  it('should include Cohere embed-multilingual-v3.0', () => {
    const model = EMBEDDING_MODELS.find((m) => m.id === 'cohere/embed-multilingual-v3.0');
    expect(model).toBeDefined();
    expect(model?.provider).toBe('Cohere');
  });

  it('should include Google text-embedding-004', () => {
    const model = EMBEDDING_MODELS.find((m) => m.id === 'google/text-embedding-004');
    expect(model).toBeDefined();
    expect(model?.provider).toBe('Google');
  });

  it('should include Mistral mistral-embed', () => {
    const model = EMBEDDING_MODELS.find((m) => m.id === 'mistral/mistral-embed');
    expect(model).toBeDefined();
    expect(model?.provider).toBe('Mistral');
  });

  it('should include Ollama nomic-embed-text', () => {
    const model = EMBEDDING_MODELS.find((m) => m.id === 'ollama/nomic-embed-text');
    expect(model).toBeDefined();
    expect(model?.provider).toBe('Ollama');
    expect(model?.local).toBe(true);
  });

  it('should include Ollama mxbai-embed-large', () => {
    const model = EMBEDDING_MODELS.find((m) => m.id === 'ollama/mxbai-embed-large');
    expect(model).toBeDefined();
    expect(model?.provider).toBe('Ollama');
    expect(model?.local).toBe(true);
  });

  describe('required fields on every entry', () => {
    const requiredStringFields: Array<keyof EmbeddingModelInfo> = [
      'id',
      'name',
      'provider',
      'model',
      'strengths',
      'setup',
    ];

    it.each(requiredStringFields)('every model has a non-empty string field: %s', (field) => {
      for (const model of EMBEDDING_MODELS) {
        expect(typeof model[field]).toBe('string');
        expect((model[field] as string).length).toBeGreaterThan(0);
      }
    });

    it('every model has a numeric dimensions > 0', () => {
      for (const model of EMBEDDING_MODELS) {
        expect(typeof model.dimensions).toBe('number');
        expect(model.dimensions).toBeGreaterThan(0);
      }
    });

    it('every model has a boolean schemaCompatible field', () => {
      for (const model of EMBEDDING_MODELS) {
        expect(typeof model.schemaCompatible).toBe('boolean');
      }
    });

    it('every model has a boolean hasFreeTier field', () => {
      for (const model of EMBEDDING_MODELS) {
        expect(typeof model.hasFreeTier).toBe('boolean');
      }
    });

    it('every model has a boolean local field', () => {
      for (const model of EMBEDDING_MODELS) {
        expect(typeof model.local).toBe('boolean');
      }
    });

    it('every model has a numeric costPerMillionTokens >= 0', () => {
      for (const model of EMBEDDING_MODELS) {
        expect(typeof model.costPerMillionTokens).toBe('number');
        expect(model.costPerMillionTokens).toBeGreaterThanOrEqual(0);
      }
    });

    it('every model quality is one of: high, medium, budget', () => {
      const allowed = new Set(['high', 'medium', 'budget']);
      for (const model of EMBEDDING_MODELS) {
        expect(allowed.has(model.quality)).toBe(true);
      }
    });

    it('every model id follows the provider/model format', () => {
      for (const model of EMBEDDING_MODELS) {
        expect(model.id).toMatch(/^[a-z0-9-]+\//);
      }
    });
  });

  describe('schema-compatible models', () => {
    it('voyage-3 is marked schemaCompatible (output_dimension: 1536 supported)', () => {
      const model = EMBEDDING_MODELS.find((m) => m.id === 'voyage/voyage-3');
      expect(model?.schemaCompatible).toBe(true);
    });

    it('text-embedding-3-small is marked schemaCompatible (native 1536-dim)', () => {
      const model = EMBEDDING_MODELS.find((m) => m.id === 'openai/text-embedding-3-small');
      expect(model?.schemaCompatible).toBe(true);
    });

    it('text-embedding-3-large is marked schemaCompatible (dimensions param supported)', () => {
      const model = EMBEDDING_MODELS.find((m) => m.id === 'openai/text-embedding-3-large');
      expect(model?.schemaCompatible).toBe(true);
    });

    it('Cohere models are NOT schema-compatible (1024-dim only)', () => {
      const cohereModels = EMBEDDING_MODELS.filter((m) => m.provider === 'Cohere');
      expect(cohereModels.length).toBeGreaterThan(0);
      for (const model of cohereModels) {
        expect(model.schemaCompatible).toBe(false);
      }
    });

    it('Ollama models are NOT schema-compatible', () => {
      const ollamaModels = EMBEDDING_MODELS.filter((m) => m.provider === 'Ollama');
      expect(ollamaModels.length).toBeGreaterThan(0);
      for (const model of ollamaModels) {
        expect(model.schemaCompatible).toBe(false);
      }
    });
  });

  describe('local model properties', () => {
    it('local models have costPerMillionTokens of 0', () => {
      const localModels = EMBEDDING_MODELS.filter((m) => m.local);
      expect(localModels.length).toBeGreaterThan(0);
      for (const model of localModels) {
        expect(model.costPerMillionTokens).toBe(0);
      }
    });

    it('local models have hasFreeTier: true', () => {
      const localModels = EMBEDDING_MODELS.filter((m) => m.local);
      for (const model of localModels) {
        expect(model.hasFreeTier).toBe(true);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// filterEmbeddingModels
// ---------------------------------------------------------------------------

describe('filterEmbeddingModels', () => {
  describe('no filters', () => {
    it('should return all models when called with no arguments', () => {
      // Act
      const result = filterEmbeddingModels();

      // Assert
      expect(result).toHaveLength(EMBEDDING_MODELS.length);
    });

    it('should return all models when called with an empty filter object', () => {
      // Act
      const result = filterEmbeddingModels({});

      // Assert
      expect(result).toHaveLength(EMBEDDING_MODELS.length);
    });

    it('should return a mutable array (not the readonly original)', () => {
      // Act
      const result = filterEmbeddingModels();

      // Assert: should be a separate array instance
      expect(result).not.toBe(EMBEDDING_MODELS);
    });
  });

  describe('schemaCompatibleOnly filter', () => {
    it('should return only schema-compatible models when schemaCompatibleOnly is true', () => {
      // Act
      const result = filterEmbeddingModels({ schemaCompatibleOnly: true });

      // Assert
      expect(result.length).toBeGreaterThan(0);
      for (const model of result) {
        expect(model.schemaCompatible).toBe(true);
      }
    });

    it('should not apply the schema filter when schemaCompatibleOnly is false', () => {
      // Act: false should not filter — same as no filter applied
      const result = filterEmbeddingModels({ schemaCompatibleOnly: false });

      // Assert: all models returned (no filtering when false)
      expect(result).toHaveLength(EMBEDDING_MODELS.length);
    });

    it('should include voyage-3, text-embedding-3-small, and text-embedding-3-large', () => {
      // Act
      const result = filterEmbeddingModels({ schemaCompatibleOnly: true });
      const ids = result.map((m) => m.id);

      // Assert: the three known compatible models must appear
      expect(ids).toContain('voyage/voyage-3');
      expect(ids).toContain('openai/text-embedding-3-small');
      expect(ids).toContain('openai/text-embedding-3-large');
    });

    it('should exclude Cohere and Ollama models (not schema-compatible)', () => {
      // Act
      const result = filterEmbeddingModels({ schemaCompatibleOnly: true });
      const providers = result.map((m) => m.provider);

      // Assert
      expect(providers).not.toContain('Cohere');
      expect(providers).not.toContain('Ollama');
    });
  });

  describe('hasFreeTier filter', () => {
    it('should return only models with a free tier when hasFreeTier is true', () => {
      // Act
      const result = filterEmbeddingModels({ hasFreeTier: true });

      // Assert
      expect(result.length).toBeGreaterThan(0);
      for (const model of result) {
        expect(model.hasFreeTier).toBe(true);
      }
    });

    it('should not apply the free-tier filter when hasFreeTier is false', () => {
      // Act
      const result = filterEmbeddingModels({ hasFreeTier: false });

      // Assert: all models returned (false does not filter)
      expect(result).toHaveLength(EMBEDDING_MODELS.length);
    });

    it('should include Voyage (free 200M tokens/month) and Cohere (trial tier)', () => {
      // Act
      const result = filterEmbeddingModels({ hasFreeTier: true });
      const ids = result.map((m) => m.id);

      // Assert
      expect(ids).toContain('voyage/voyage-3');
      expect(ids).toContain('cohere/embed-english-v3.0');
    });

    it('should exclude OpenAI paid-only models', () => {
      // Act
      const result = filterEmbeddingModels({ hasFreeTier: true });

      // OpenAI models without free tier should not appear
      const openAiPaid = result.filter((m) => m.provider === 'OpenAI' && !m.hasFreeTier);
      expect(openAiPaid).toHaveLength(0);
    });
  });

  describe('local filter', () => {
    it('should return only local models when local is true', () => {
      // Act
      const result = filterEmbeddingModels({ local: true });

      // Assert
      expect(result.length).toBeGreaterThan(0);
      for (const model of result) {
        expect(model.local).toBe(true);
      }
    });

    it('should return only cloud models when local is false', () => {
      // Act
      const result = filterEmbeddingModels({ local: false });

      // Assert
      expect(result.length).toBeGreaterThan(0);
      for (const model of result) {
        expect(model.local).toBe(false);
      }
    });

    it('should return all models when local is undefined (not set)', () => {
      // Act: local not provided
      const result = filterEmbeddingModels({ local: undefined });

      // Assert: no local filter applied
      expect(result).toHaveLength(EMBEDDING_MODELS.length);
    });

    it('should return Ollama models when local is true', () => {
      // Act
      const result = filterEmbeddingModels({ local: true });
      const ids = result.map((m) => m.id);

      // Assert
      expect(ids).toContain('ollama/nomic-embed-text');
      expect(ids).toContain('ollama/mxbai-embed-large');
    });

    it('should exclude Ollama models when local is false', () => {
      // Act
      const result = filterEmbeddingModels({ local: false });
      const providers = result.map((m) => m.provider);

      // Assert
      expect(providers).not.toContain('Ollama');
    });

    it('local: true count plus local: false count equals total model count', () => {
      // Arrange
      const totalCount = EMBEDDING_MODELS.length;

      // Act
      const localCount = filterEmbeddingModels({ local: true }).length;
      const cloudCount = filterEmbeddingModels({ local: false }).length;

      // Assert: mutually exclusive and exhaustive
      expect(localCount + cloudCount).toBe(totalCount);
    });
  });

  describe('combined filters', () => {
    it('should apply schemaCompatibleOnly and hasFreeTier together', () => {
      // Act
      const result = filterEmbeddingModels({ schemaCompatibleOnly: true, hasFreeTier: true });

      // Assert: every result must satisfy both constraints
      expect(result.length).toBeGreaterThan(0);
      for (const model of result) {
        expect(model.schemaCompatible).toBe(true);
        expect(model.hasFreeTier).toBe(true);
      }

      // voyage-3 satisfies both: schemaCompatible AND hasFreeTier
      const ids = result.map((m) => m.id);
      expect(ids).toContain('voyage/voyage-3');
    });

    it('should return no results for schemaCompatibleOnly + local: true (no compatible local models)', () => {
      // Act: no local model is schema-compatible in the current catalogue
      const result = filterEmbeddingModels({ schemaCompatibleOnly: true, local: true });

      // Assert
      expect(result).toHaveLength(0);
    });

    it('should apply all three filters simultaneously', () => {
      // Act
      const result = filterEmbeddingModels({
        schemaCompatibleOnly: true,
        hasFreeTier: true,
        local: false,
      });

      // Assert: every result must satisfy all three constraints
      for (const model of result) {
        expect(model.schemaCompatible).toBe(true);
        expect(model.hasFreeTier).toBe(true);
        expect(model.local).toBe(false);
      }

      // voyage-3 is the primary candidate: schema-compatible, free tier, cloud
      const ids = result.map((m) => m.id);
      expect(ids).toContain('voyage/voyage-3');
    });

    it('should return a subset of unfiltered results when multiple filters applied', () => {
      // Act
      const all = filterEmbeddingModels();
      const filtered = filterEmbeddingModels({ hasFreeTier: true, local: false });

      // Assert: filtered is always a subset
      expect(filtered.length).toBeLessThanOrEqual(all.length);
      for (const model of filtered) {
        expect(all.some((m) => m.id === model.id)).toBe(true);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// getEmbeddingModels — DB-driven path
// ---------------------------------------------------------------------------

/** Build a minimal DB row compatible with the Prisma aiProviderModel shape. */
function makeDbRow(overrides: {
  providerSlug?: string;
  modelId?: string;
  name?: string;
  dimensions?: number | null;
  schemaCompatible?: boolean | null;
  costPerMillionTokens?: number | null;
  hasFreeTier?: boolean | null;
  local?: boolean;
  quality?: string | null;
  strengths?: string | null;
  description?: string;
  setup?: string | null;
  capabilities?: string[];
  isActive?: boolean;
}) {
  return {
    id: 'row-id',
    providerSlug: overrides.providerSlug ?? 'openai',
    modelId: overrides.modelId ?? 'text-embedding-3-small',
    name: overrides.name ?? 'text-embedding-3-small',
    dimensions: overrides.dimensions !== undefined ? overrides.dimensions : 1536,
    schemaCompatible: overrides.schemaCompatible !== undefined ? overrides.schemaCompatible : true,
    costPerMillionTokens:
      overrides.costPerMillionTokens !== undefined ? overrides.costPerMillionTokens : 0.02,
    hasFreeTier: overrides.hasFreeTier !== undefined ? overrides.hasFreeTier : false,
    local: overrides.local ?? false,
    quality: overrides.quality !== undefined ? overrides.quality : 'medium',
    strengths: overrides.strengths !== undefined ? overrides.strengths : 'Good model',
    description: overrides.description ?? 'A description',
    setup: overrides.setup !== undefined ? overrides.setup : 'Add API key',
    capabilities: overrides.capabilities ?? ['embedding'],
    isActive: overrides.isActive ?? true,
  };
}

describe('getEmbeddingModels', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('DB returns models', () => {
    it('should return DB models when DB has results', async () => {
      // Arrange
      const dbRow = makeDbRow({ providerSlug: 'openai', modelId: 'text-embedding-3-small' });
      vi.mocked(prisma.aiProviderModel.findMany).mockResolvedValue([dbRow] as never);

      // Act
      const result = await getEmbeddingModels();

      // Assert: result comes from DB (not static fallback which has 9 entries)
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('openai/text-embedding-3-small');
    });

    it('should map providerSlug to display name using PROVIDER_DISPLAY_NAMES for known slugs', async () => {
      // Arrange
      const rows = [
        makeDbRow({ providerSlug: 'openai', modelId: 'emb-1', name: 'Emb 1' }),
        makeDbRow({ providerSlug: 'voyage', modelId: 'emb-2', name: 'Emb 2' }),
        makeDbRow({ providerSlug: 'cohere', modelId: 'emb-3', name: 'Emb 3' }),
        makeDbRow({ providerSlug: 'google', modelId: 'emb-4', name: 'Emb 4' }),
        makeDbRow({ providerSlug: 'mistral', modelId: 'emb-5', name: 'Emb 5' }),
        makeDbRow({ providerSlug: 'ollama', modelId: 'emb-6', name: 'Emb 6' }),
        makeDbRow({ providerSlug: 'anthropic', modelId: 'emb-7', name: 'Emb 7' }),
        makeDbRow({ providerSlug: 'meta', modelId: 'emb-8', name: 'Emb 8' }),
      ];
      vi.mocked(prisma.aiProviderModel.findMany).mockResolvedValue(rows as never);

      // Act
      const result = await getEmbeddingModels();

      // Assert: known slugs map to their display names
      const byId = Object.fromEntries(result.map((m) => [m.id, m]));
      expect(byId['openai/emb-1'].provider).toBe('OpenAI');
      expect(byId['voyage/emb-2'].provider).toBe('Voyage AI');
      expect(byId['cohere/emb-3'].provider).toBe('Cohere');
      expect(byId['google/emb-4'].provider).toBe('Google');
      expect(byId['mistral/emb-5'].provider).toBe('Mistral');
      expect(byId['ollama/emb-6'].provider).toBe('Ollama');
      expect(byId['anthropic/emb-7'].provider).toBe('Anthropic');
      expect(byId['meta/emb-8'].provider).toBe('Meta');
    });

    it('should fall through to raw providerSlug for unknown provider slugs', async () => {
      // Arrange: "acme-ai" is not in PROVIDER_DISPLAY_NAMES
      const dbRow = makeDbRow({ providerSlug: 'acme-ai', modelId: 'custom-emb' });
      vi.mocked(prisma.aiProviderModel.findMany).mockResolvedValue([dbRow] as never);

      // Act
      const result = await getEmbeddingModels();

      // Assert: raw slug used as display name
      expect(result[0].provider).toBe('acme-ai');
    });

    it('should filter out rows where dimensions is null', async () => {
      // Arrange: first row has null dimensions, second has valid dimensions
      const rowWithNull = makeDbRow({ modelId: 'no-dims', dimensions: null });
      const rowWithDims = makeDbRow({ modelId: 'with-dims', dimensions: 768 });
      vi.mocked(prisma.aiProviderModel.findMany).mockResolvedValue([
        rowWithNull,
        rowWithDims,
      ] as never);

      // Act
      const result = await getEmbeddingModels();

      // Assert: only the row with dimensions is included
      expect(result).toHaveLength(1);
      expect(result[0].id).toContain('with-dims');
    });

    it('should default schemaCompatible to false when DB value is null', async () => {
      // Arrange
      const dbRow = makeDbRow({ schemaCompatible: null });
      vi.mocked(prisma.aiProviderModel.findMany).mockResolvedValue([dbRow] as never);

      // Act
      const result = await getEmbeddingModels();

      // Assert
      expect(result[0].schemaCompatible).toBe(false);
    });

    it('should default costPerMillionTokens to 0 when DB value is null', async () => {
      // Arrange
      const dbRow = makeDbRow({ costPerMillionTokens: null });
      vi.mocked(prisma.aiProviderModel.findMany).mockResolvedValue([dbRow] as never);

      // Act
      const result = await getEmbeddingModels();

      // Assert
      expect(result[0].costPerMillionTokens).toBe(0);
    });

    it('should default hasFreeTier to false when DB value is null', async () => {
      // Arrange
      const dbRow = makeDbRow({ hasFreeTier: null });
      vi.mocked(prisma.aiProviderModel.findMany).mockResolvedValue([dbRow] as never);

      // Act
      const result = await getEmbeddingModels();

      // Assert
      expect(result[0].hasFreeTier).toBe(false);
    });

    it('should default quality to "medium" when DB value is null', async () => {
      // Arrange
      const dbRow = makeDbRow({ quality: null });
      vi.mocked(prisma.aiProviderModel.findMany).mockResolvedValue([dbRow] as never);

      // Act
      const result = await getEmbeddingModels();

      // Assert
      expect(result[0].quality).toBe('medium');
    });

    it('should use description as fallback when strengths is null', async () => {
      // Arrange: strengths is null, description has a value
      const dbRow = makeDbRow({ strengths: null, description: 'Fallback description' });
      vi.mocked(prisma.aiProviderModel.findMany).mockResolvedValue([dbRow] as never);

      // Act
      const result = await getEmbeddingModels();

      // Assert: description is used when strengths is null
      expect(result[0].strengths).toBe('Fallback description');
    });

    it('should default setup to empty string when DB value is null', async () => {
      // Arrange
      const dbRow = makeDbRow({ setup: null });
      vi.mocked(prisma.aiProviderModel.findMany).mockResolvedValue([dbRow] as never);

      // Act
      const result = await getEmbeddingModels();

      // Assert
      expect(result[0].setup).toBe('');
    });

    it('should compose the id as providerSlug/modelId', async () => {
      // Arrange
      const dbRow = makeDbRow({ providerSlug: 'voyage', modelId: 'voyage-3' });
      vi.mocked(prisma.aiProviderModel.findMany).mockResolvedValue([dbRow] as never);

      // Act
      const result = await getEmbeddingModels();

      // Assert
      expect(result[0].id).toBe('voyage/voyage-3');
    });
  });

  describe('sorting when DB returns multiple models', () => {
    it('should sort schema-compatible models before non-compatible ones', async () => {
      // Arrange: non-compatible first in DB order, compatible second
      const nonCompatible = makeDbRow({
        modelId: 'non-compat',
        name: 'Non Compat',
        schemaCompatible: false,
        quality: 'high',
        costPerMillionTokens: 0.01,
      });
      const compatible = makeDbRow({
        modelId: 'compat',
        name: 'Compat',
        schemaCompatible: true,
        quality: 'medium',
        costPerMillionTokens: 0.1,
      });
      vi.mocked(prisma.aiProviderModel.findMany).mockResolvedValue([
        nonCompatible,
        compatible,
      ] as never);

      // Act
      const result = await getEmbeddingModels();

      // Assert: compatible appears first despite being second in DB output
      expect(result[0].id).toContain('compat');
      expect(result[0].schemaCompatible).toBe(true);
      expect(result[1].schemaCompatible).toBe(false);
    });

    it('should sort higher quality before lower quality within the same schemaCompatible group', async () => {
      // Arrange: both non-compatible; budget comes before high in DB order
      const budgetModel = makeDbRow({
        modelId: 'budget-model',
        name: 'Budget',
        schemaCompatible: false,
        quality: 'budget',
        costPerMillionTokens: 0.01,
      });
      const highModel = makeDbRow({
        modelId: 'high-model',
        name: 'High',
        schemaCompatible: false,
        quality: 'high',
        costPerMillionTokens: 0.1,
      });
      vi.mocked(prisma.aiProviderModel.findMany).mockResolvedValue([
        budgetModel,
        highModel,
      ] as never);

      // Act
      const result = await getEmbeddingModels();

      // Assert: high quality comes first
      expect(result[0].quality).toBe('high');
      expect(result[1].quality).toBe('budget');
    });

    it('should sort by lower cost first when schemaCompatible and quality are equal', async () => {
      // Arrange: same schemaCompatible (false), same quality (medium); expensive first in DB
      const expensive = makeDbRow({
        modelId: 'expensive',
        name: 'Expensive',
        schemaCompatible: false,
        quality: 'medium',
        costPerMillionTokens: 0.5,
      });
      const cheap = makeDbRow({
        modelId: 'cheap',
        name: 'Cheap',
        schemaCompatible: false,
        quality: 'medium',
        costPerMillionTokens: 0.05,
      });
      vi.mocked(prisma.aiProviderModel.findMany).mockResolvedValue([expensive, cheap] as never);

      // Act
      const result = await getEmbeddingModels();

      // Assert: cheaper model sorted first
      expect(result[0].costPerMillionTokens).toBe(0.05);
      expect(result[1].costPerMillionTokens).toBe(0.5);
    });
  });

  describe('empty DB result — static fallback', () => {
    it('should return the static EMBEDDING_MODELS array when DB returns no rows', async () => {
      // Arrange: DB returns empty array
      vi.mocked(prisma.aiProviderModel.findMany).mockResolvedValue([] as never);

      // Act
      const result = await getEmbeddingModels();

      // Assert: falls back to the 9-entry static catalogue
      expect(result).toHaveLength(EMBEDDING_MODELS.length);
      expect(result[0].id).toBe(EMBEDDING_MODELS[0].id);
    });

    it('should not call logger.warn when DB simply returns an empty array', async () => {
      // Arrange
      vi.mocked(prisma.aiProviderModel.findMany).mockResolvedValue([] as never);

      // Act
      await getEmbeddingModels();

      // Assert: empty result is not an error condition
      expect(vi.mocked(logger.warn)).not.toHaveBeenCalled();
    });
  });

  describe('DB throws — error fallback', () => {
    it('should return static EMBEDDING_MODELS when the DB query throws', async () => {
      // Arrange
      vi.mocked(prisma.aiProviderModel.findMany).mockRejectedValue(new Error('Connection refused'));

      // Act
      const result = await getEmbeddingModels();

      // Assert: static catalogue returned as fallback
      expect(result).toHaveLength(EMBEDDING_MODELS.length);
    });

    it('should log a warning with the error message when DB throws an Error', async () => {
      // Arrange
      vi.mocked(prisma.aiProviderModel.findMany).mockRejectedValue(new Error('Connection refused'));

      // Act
      await getEmbeddingModels();

      // Assert: warn logged with the error message
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        'Failed to load embedding models from DB, using static fallback',
        { error: 'Connection refused' }
      );
    });

    it('should log a warning with String(err) when DB throws a non-Error value', async () => {
      // Arrange: throw a plain string, not an Error instance
      vi.mocked(prisma.aiProviderModel.findMany).mockRejectedValue('timeout');

      // Act
      await getEmbeddingModels();

      // Assert: String() conversion used for non-Error values
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        'Failed to load embedding models from DB, using static fallback',
        { error: 'timeout' }
      );
    });

    it('should return a mutable copy of EMBEDDING_MODELS, not the original readonly array', async () => {
      // Arrange
      vi.mocked(prisma.aiProviderModel.findMany).mockRejectedValue(new Error('fail'));

      // Act
      const result = await getEmbeddingModels();

      // Assert: spread copy, not the original reference
      expect(result).not.toBe(EMBEDDING_MODELS);
      // Verify same content
      expect(result.map((m) => m.id)).toEqual(EMBEDDING_MODELS.map((m) => m.id));
    });
  });
});
