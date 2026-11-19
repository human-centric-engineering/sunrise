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
 * - Vendor retirement (§136 t-1064): a day to come marks retiring and keeps
 *   the model active; a day here retires and deactivates; the successor is
 *   resolved by vendor model id and refused when `checkReplacement` refuses;
 *   every write is in the admin audit log
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

vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({
  logAdminAction: vi.fn(),
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
const { logAdminAction } = await import('@/lib/orchestration/audit/admin-audit-logger');

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

  describe('shared settings (§107 t-751)', () => {
    it('declares that it changes a shared setting, so the dispatcher refuses it outside the install org', () => {
      expect(new DeactivateProviderModelsCapability().writesSharedSettings).toBe(true);
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

  describe('execute() — metadata merge', () => {
    it('merges deactivatedByAudit into existing object metadata', async () => {
      mockFindUnique.mockResolvedValue({
        id: 'model-1',
        name: 'GPT-4',
        isActive: true,
        metadata: { lastAudit: '2026-01-01', customField: 42 },
      });
      const cap = new DeactivateProviderModelsCapability();
      await cap.execute({ deactivateModels: [makeEntry()] }, context);

      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            metadata: expect.objectContaining({
              lastAudit: '2026-01-01',
              customField: 42,
              deactivatedByAudit: expect.objectContaining({ agentId: 'a1' }),
            }),
          }),
        })
      );
    });

    it('discards array-shaped metadata and starts fresh', async () => {
      mockFindUnique.mockResolvedValue({
        id: 'model-1',
        name: 'GPT-4',
        isActive: true,
        metadata: ['invalid', 'array'],
      });
      const cap = new DeactivateProviderModelsCapability();
      await cap.execute({ deactivateModels: [makeEntry()] }, context);

      const writtenMetadata = mockUpdate.mock.calls[0][0].data.metadata;
      expect(writtenMetadata).not.toHaveProperty('0');
      expect(writtenMetadata).toHaveProperty('deactivatedByAudit');
    });

    it('discards non-object metadata (string) and starts fresh', async () => {
      mockFindUnique.mockResolvedValue({
        id: 'model-1',
        name: 'GPT-4',
        isActive: true,
        metadata: 'some-string',
      });
      const cap = new DeactivateProviderModelsCapability();
      await cap.execute({ deactivateModels: [makeEntry()] }, context);

      const writtenMetadata = mockUpdate.mock.calls[0][0].data.metadata;
      expect(writtenMetadata).toEqual({
        deactivatedByAudit: expect.objectContaining({ agentId: 'a1' }),
      });
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

// ---------------------------------------------------------------------------
// Vendor retirement (§136 t-1064)
// ---------------------------------------------------------------------------

describe('DeactivateProviderModelsCapability — vendor retirement (§136 t-1064)', () => {
  // Far from today either way, so the derived state never depends on when the suite runs.
  const FUTURE_DAY = '2099-03-01';
  const PAST_DAY = '2020-03-01';
  const mockLogAdminAction = vi.mocked(logAdminAction);

  const RETIRING = {
    id: 'model-1',
    name: 'GPT-4',
    providerSlug: 'openai',
    capabilities: ['chat', 'vision'],
    isActive: true,
    retiresAt: null,
    replacementId: null,
    metadata: null,
  };
  const SUCCESSOR = {
    id: 'model-2',
    name: 'GPT-5',
    providerSlug: 'openai',
    capabilities: ['chat', 'vision'],
    isActive: true,
    retiresAt: null,
  };

  /**
   * `findUnique` answers by `where`: the model by its row id, and successors
   * by `(providerSlug, modelId)` from `catalogue`.
   */
  function catalogue(
    model: Record<string, unknown>,
    byVendorId: Record<string, Record<string, unknown>> = {}
  ) {
    mockFindUnique.mockImplementation(((args: {
      where: { id?: string; providerSlug_modelId?: { providerSlug: string; modelId: string } };
    }) => {
      if (args.where.id !== undefined) {
        return Promise.resolve(args.where.id === model.id ? model : null);
      }
      const key = args.where.providerSlug_modelId;
      const hit = key ? byVendorId[`${key.providerSlug}/${key.modelId}`] : undefined;
      return Promise.resolve(hit ?? null);
    }) as never);
  }

  async function run(entry: Record<string, unknown>) {
    const cap = new DeactivateProviderModelsCapability();
    return cap.execute(
      cap.validate({ deactivateModels: [{ modelId: 'model-1', reason: 'EOL', ...entry }] }),
      { ...context, workflowExecutionId: 'exec-1' }
    );
  }

  it('marks a model retiring on a day to come and leaves it active', async () => {
    catalogue(RETIRING);

    const result = await run({ retiresAt: FUTURE_DAY });

    expect(result.data?.retiring).toBe(1);
    expect(result.data?.deactivated).toBe(0);
    expect(result.data?.models[0].status).toBe('retiring');
    const data = mockUpdate.mock.calls[0][0].data;
    expect(data.retiresAt).toEqual(new Date(`${FUTURE_DAY}T00:00:00.000Z`));
    expect(data).not.toHaveProperty('isActive');
    expect(mockInvalidateModelCache).toHaveBeenCalledTimes(1);
  });

  it('retires and deactivates a model whose day is already here, stamping the deactivation', async () => {
    catalogue(RETIRING);

    const result = await run({ retiresAt: PAST_DAY });

    expect(result.data?.retired).toBe(1);
    expect(result.data?.models[0].status).toBe('retired');
    const data = mockUpdate.mock.calls[0][0].data;
    expect(data.isActive).toBe(false);
    expect(data.retiresAt).toEqual(new Date(`${PAST_DAY}T00:00:00.000Z`));
    expect(data.metadata.deactivatedByAudit).toMatchObject({ agentId: 'a1', reason: 'EOL' });
  });

  it('records the day on a model already turned off, without touching isActive', async () => {
    catalogue({ ...RETIRING, isActive: false });

    const result = await run({ retiresAt: PAST_DAY });

    expect(result.data?.models[0].status).toBe('retired');
    const data = mockUpdate.mock.calls[0][0].data;
    expect(data).toEqual({ retiresAt: new Date(`${PAST_DAY}T00:00:00.000Z`) });
  });

  it('resolves the successor by vendor model id on the same provider and stores its row id', async () => {
    catalogue(RETIRING, { 'openai/gpt-5': SUCCESSOR });

    const result = await run({ retiresAt: FUTURE_DAY, replacedBy: 'gpt-5' });

    expect(result.data?.models[0].replacementNote).toBeUndefined();
    expect(mockUpdate.mock.calls[0][0].data.replacementId).toBe('model-2');
    // Looked up on the retiring model's own provider, never another.
    expect(mockFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { providerSlug_modelId: { providerSlug: 'openai', modelId: 'gpt-5' } },
      })
    );
  });

  it('refuses a successor that fails checkReplacement but still records the retirement', async () => {
    catalogue(RETIRING, { 'openai/gpt-5': { ...SUCCESSOR, capabilities: ['chat'] } });

    const result = await run({ retiresAt: FUTURE_DAY, replacedBy: 'gpt-5' });

    expect(result.data?.models[0].status).toBe('retiring');
    expect(result.data?.models[0].replacementNote).toMatch(/lacks vision/);
    const data = mockUpdate.mock.calls[0][0].data;
    expect(data).not.toHaveProperty('replacementId');
    expect(data.retiresAt).toEqual(new Date(`${FUTURE_DAY}T00:00:00.000Z`));
  });

  it("cannot reach a successor on another provider: the lookup is pinned to the model's own", async () => {
    // The vendor id exists, but only under another provider.
    catalogue(RETIRING, { 'anthropic/claude-opus-5': { ...SUCCESSOR, providerSlug: 'anthropic' } });

    const result = await run({ retiresAt: FUTURE_DAY, replacedBy: 'claude-opus-5' });

    expect(result.data?.models[0].replacementNote).toMatch(
      /"claude-opus-5" is not in the openai catalogue/
    );
    expect(mockUpdate.mock.calls[0][0].data).not.toHaveProperty('replacementId');
  });

  it('reports a day that is not a day as invalid and writes nothing', async () => {
    catalogue(RETIRING);

    const result = await run({ retiresAt: '2099-02-30' });

    expect(result.data?.invalid).toBe(1);
    expect(result.data?.models[0].reason).toMatch(/not a day/);
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockLogAdminAction).not.toHaveBeenCalled();
  });

  it('skips, writing nothing, when the same retirement is already recorded', async () => {
    catalogue({
      ...RETIRING,
      retiresAt: new Date(`${FUTURE_DAY}T00:00:00.000Z`),
      replacementId: 'model-2',
    });

    const result = await run({ retiresAt: FUTURE_DAY });

    expect(result.data?.skipped).toBe(1);
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockLogAdminAction).not.toHaveBeenCalled();
    expect(mockInvalidateModelCache).not.toHaveBeenCalled();
  });

  it('writes an admin audit row naming each changed field, the reason and the run', async () => {
    catalogue(RETIRING, { 'openai/gpt-5': SUCCESSOR });

    await run({ retiresAt: PAST_DAY, replacedBy: 'gpt-5' });

    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    expect(mockLogAdminAction).toHaveBeenCalledWith({
      userId: 'u1',
      action: 'provider_model.retire',
      entityType: 'provider_model',
      entityId: 'model-1',
      entityName: 'GPT-4',
      changes: {
        retiresAt: { from: null, to: new Date(`${PAST_DAY}T00:00:00.000Z`) },
        replacementId: { from: null, to: 'model-2' },
        isActive: { from: true, to: false },
      },
      metadata: { source: 'model_audit', reason: 'EOL', workflowExecutionId: 'exec-1' },
    });
  });

  it('writes an audit row for a plain deactivation too', async () => {
    catalogue(RETIRING);

    await run({});

    expect(mockLogAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'provider_model.deactivate',
        changes: { isActive: { from: true, to: false } },
      })
    );
  });

  it('writes no audit row when the update fails', async () => {
    catalogue(RETIRING);
    mockUpdate.mockRejectedValueOnce(new Error('db down'));

    const result = await run({ retiresAt: FUTURE_DAY });

    expect(result.data?.invalid).toBe(1);
    expect(mockLogAdminAction).not.toHaveBeenCalled();
  });
});
