/**
 * Tests for the DeactivateProviderModelsCapability built-in.
 *
 * Test Coverage:
 * - slug matches functionDefinition.name
 * - Validates valid input (deactivateModels array)
 * - Rejects empty deactivateModels array
 * - Rejects missing required fields
 * - Happy path — deactivates model and returns deactivated=1
 * - Skips already-inactive models
 * - Reports invalid (not found) model IDs
 * - Calls invalidateModelCache after deactivation
 * - Does NOT call invalidateModelCache when no models deactivated
 * - Stores deactivatedByAudit metadata
 * - Handles DB errors gracefully
 * - Mixed results (deactivated + skipped + invalid)
 *
 * @see lib/orchestration/capabilities/built-in/deactivate-provider-models.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — must be declared before dynamic imports
// ---------------------------------------------------------------------------

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiProviderModel: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock('@/lib/orchestration/llm/provider-selector', () => ({
  invalidateModelCache: vi.fn(),
}));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Dynamic imports (after mocks are in place)
// ---------------------------------------------------------------------------

const { prisma } = await import('@/lib/db/client');
const { invalidateModelCache } = await import('@/lib/orchestration/llm/provider-selector');
const { DeactivateProviderModelsCapability } =
  await import('@/lib/orchestration/capabilities/built-in/deactivate-provider-models');
const { CapabilityValidationError } =
  await import('@/lib/orchestration/capabilities/base-capability');

// ---------------------------------------------------------------------------
// Typed mock aliases
// ---------------------------------------------------------------------------

const mockFindUnique = prisma.aiProviderModel.findUnique as ReturnType<typeof vi.fn>;
const mockUpdate = prisma.aiProviderModel.update as ReturnType<typeof vi.fn>;
const mockInvalidateModelCache = invalidateModelCache as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<{ modelId: string; reason: string }> = {}) {
  return {
    modelId: 'model-1',
    reason: 'Model deprecated by provider on 2026-03-01',
    ...overrides,
  };
}

const context = { userId: 'u1', agentId: 'a1', conversationId: 'conv-1' };

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockFindUnique.mockResolvedValue({ id: 'model-1', name: 'GPT-4', isActive: true });
  mockUpdate.mockResolvedValue({ id: 'model-1' });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DeactivateProviderModelsCapability', () => {
  describe('slug', () => {
    it('slug matches functionDefinition.name', () => {
      const cap = new DeactivateProviderModelsCapability();
      expect(cap.slug).toBe(cap.functionDefinition.name);
      expect(cap.slug).toBe('deactivate_provider_models');
    });
  });

  describe('validate()', () => {
    it('accepts valid deactivateModels array', () => {
      const cap = new DeactivateProviderModelsCapability();
      const result = cap.validate({ deactivateModels: [makeEntry()] });
      expect(result.deactivateModels).toHaveLength(1);
    });

    it('accepts empty deactivateModels array (no-op when approval has no deactivations)', () => {
      const cap = new DeactivateProviderModelsCapability();
      const result = cap.validate({ deactivateModels: [] });
      expect(result.deactivateModels).toEqual([]);
    });

    it('rejects when deactivateModels exceeds 50 items', () => {
      const cap = new DeactivateProviderModelsCapability();
      const entries = Array.from({ length: 51 }, (_, i) => makeEntry({ modelId: `model-${i}` }));
      expect(() => cap.validate({ deactivateModels: entries })).toThrow(CapabilityValidationError);
    });

    it('rejects missing modelId', () => {
      const cap = new DeactivateProviderModelsCapability();
      const entry = makeEntry();
      delete (entry as Record<string, unknown>).modelId;
      expect(() => cap.validate({ deactivateModels: [entry] })).toThrow(CapabilityValidationError);
    });

    it('rejects empty modelId', () => {
      const cap = new DeactivateProviderModelsCapability();
      expect(() => cap.validate({ deactivateModels: [makeEntry({ modelId: '' })] })).toThrow(
        CapabilityValidationError
      );
    });

    it('rejects missing reason', () => {
      const cap = new DeactivateProviderModelsCapability();
      const entry = makeEntry();
      delete (entry as Record<string, unknown>).reason;
      expect(() => cap.validate({ deactivateModels: [entry] })).toThrow(CapabilityValidationError);
    });

    it('rejects empty reason', () => {
      const cap = new DeactivateProviderModelsCapability();
      expect(() => cap.validate({ deactivateModels: [makeEntry({ reason: '' })] })).toThrow(
        CapabilityValidationError
      );
    });
  });

  describe('execute() — happy path', () => {
    it('deactivates a model and returns deactivated=1', async () => {
      const cap = new DeactivateProviderModelsCapability();
      const result = await cap.execute({ deactivateModels: [makeEntry()] }, context);

      expect(result.success).toBe(true);
      expect(result.data?.deactivated).toBe(1);
      expect(result.data?.skipped).toBe(0);
      expect(result.data?.invalid).toBe(0);
      expect(result.data?.models).toHaveLength(1);
      expect(result.data?.models[0].status).toBe('deactivated');
    });

    it('sets isActive=false via prisma.update', async () => {
      const cap = new DeactivateProviderModelsCapability();
      await cap.execute({ deactivateModels: [makeEntry()] }, context);

      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'model-1' },
          data: expect.objectContaining({
            isActive: false,
          }),
        })
      );
    });

    it('stores deactivatedByAudit metadata with timestamp, agentId, and reason', async () => {
      const cap = new DeactivateProviderModelsCapability();
      await cap.execute({ deactivateModels: [makeEntry()] }, context);

      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            metadata: expect.objectContaining({
              deactivatedByAudit: expect.objectContaining({
                agentId: 'a1',
                reason: 'Model deprecated by provider on 2026-03-01',
                timestamp: expect.any(String),
              }),
            }),
          }),
        })
      );
    });

    it('returns skipFollowup=true', async () => {
      const cap = new DeactivateProviderModelsCapability();
      const result = await cap.execute({ deactivateModels: [makeEntry()] }, context);
      expect(result.skipFollowup).toBe(true);
    });
  });

  describe('execute() — already inactive', () => {
    it('skips models that are already inactive', async () => {
      mockFindUnique.mockResolvedValue({ id: 'model-1', name: 'GPT-4', isActive: false });
      const cap = new DeactivateProviderModelsCapability();

      const result = await cap.execute({ deactivateModels: [makeEntry()] }, context);

      expect(result.success).toBe(true);
      expect(result.data?.deactivated).toBe(0);
      expect(result.data?.skipped).toBe(1);
      expect(result.data?.models[0].status).toBe('skipped');
      expect(result.data?.models[0].reason).toContain('already inactive');
      expect(mockUpdate).not.toHaveBeenCalled();
    });
  });

  describe('execute() — model not found', () => {
    it('reports invalid when model ID does not exist', async () => {
      mockFindUnique.mockResolvedValue(null);
      const cap = new DeactivateProviderModelsCapability();

      const result = await cap.execute(
        { deactivateModels: [makeEntry({ modelId: 'nonexistent' })] },
        context
      );

      expect(result.success).toBe(true);
      expect(result.data?.invalid).toBe(1);
      expect(result.data?.models[0].status).toBe('invalid');
      expect(result.data?.models[0].reason).toContain('not found');
      expect(mockUpdate).not.toHaveBeenCalled();
    });
  });

  describe('execute() — DB error', () => {
    it('marks model as invalid when update throws', async () => {
      mockUpdate.mockRejectedValue(new Error('Connection lost'));
      const cap = new DeactivateProviderModelsCapability();

      const result = await cap.execute({ deactivateModels: [makeEntry()] }, context);

      expect(result.success).toBe(true);
      expect(result.data?.invalid).toBe(1);
      expect(result.data?.models[0].status).toBe('invalid');
      expect(result.data?.models[0].reason).toContain('Connection lost');
    });
  });

  describe('execute() — invalidateModelCache', () => {
    it('calls invalidateModelCache after at least one model is deactivated', async () => {
      const cap = new DeactivateProviderModelsCapability();
      await cap.execute({ deactivateModels: [makeEntry()] }, context);
      expect(mockInvalidateModelCache).toHaveBeenCalledTimes(1);
    });

    it('does NOT call invalidateModelCache when all models are skipped', async () => {
      mockFindUnique.mockResolvedValue({ id: 'model-1', name: 'GPT-4', isActive: false });
      const cap = new DeactivateProviderModelsCapability();

      await cap.execute({ deactivateModels: [makeEntry()] }, context);

      expect(mockInvalidateModelCache).not.toHaveBeenCalled();
    });

    it('does NOT call invalidateModelCache when all models are invalid', async () => {
      mockFindUnique.mockResolvedValue(null);
      const cap = new DeactivateProviderModelsCapability();

      await cap.execute({ deactivateModels: [makeEntry()] }, context);

      expect(mockInvalidateModelCache).not.toHaveBeenCalled();
    });
  });

  describe('execute() — mixed results', () => {
    it('handles a mix of deactivated, skipped, and invalid models', async () => {
      mockFindUnique
        .mockResolvedValueOnce({ id: 'model-a', name: 'Model A', isActive: true }) // will deactivate
        .mockResolvedValueOnce({ id: 'model-b', name: 'Model B', isActive: false }) // will skip
        .mockResolvedValueOnce(null); // will be invalid

      const cap = new DeactivateProviderModelsCapability();
      const result = await cap.execute(
        {
          deactivateModels: [
            makeEntry({ modelId: 'model-a' }),
            makeEntry({ modelId: 'model-b' }),
            makeEntry({ modelId: 'model-c' }),
          ],
        },
        context
      );

      expect(result.data?.deactivated).toBe(1);
      expect(result.data?.skipped).toBe(1);
      expect(result.data?.invalid).toBe(1);
      expect(result.data?.models).toHaveLength(3);
      expect(mockUpdate).toHaveBeenCalledTimes(1);
      expect(mockInvalidateModelCache).toHaveBeenCalledTimes(1);
    });
  });
});
