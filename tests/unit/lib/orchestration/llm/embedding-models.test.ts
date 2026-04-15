/**
 * Embedding Model Registry Tests
 *
 * Tests for the static embedding model catalogue and filter helper.
 *
 * Test Coverage:
 * - EMBEDDING_MODELS array: expected entries, required fields, structural integrity
 * - filterEmbeddingModels(): no filters, schemaCompatibleOnly, hasFreeTier, local true/false
 * - Combined filter scenarios
 *
 * @see lib/orchestration/llm/embedding-models.ts
 */

import { describe, it, expect } from 'vitest';
import {
  EMBEDDING_MODELS,
  filterEmbeddingModels,
  type EmbeddingModelInfo,
} from '@/lib/orchestration/llm/embedding-models';

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
