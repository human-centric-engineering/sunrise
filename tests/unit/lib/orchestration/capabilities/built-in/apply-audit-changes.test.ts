/**
 * Tests for the ApplyAuditChangesCapability built-in.
 *
 * Test Coverage:
 * - slug matches functionDefinition.name
 * - Validates valid input (model_id + changes array)
 * - Rejects invalid input (missing model_id, empty changes array)
 * - Happy path — applies valid changes and returns applied count
 * - Returns not_found error when model does not exist
 * - Skips changes where current value has drifted since the audit
 * - Returns invalid status for changes that fail updateProviderModelSchema validation
 * - Calls invalidateModelCache() after applying at least one change
 * - Writes lastAudit metadata to the model after successful changes
 * - Does NOT call invalidateModelCache() when no changes were applied
 *
 * @see lib/orchestration/capabilities/built-in/apply-audit-changes.ts
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
const { ApplyAuditChangesCapability, AUDITABLE_FIELDS } =
  await import('@/lib/orchestration/capabilities/built-in/apply-audit-changes');
const { CapabilityValidationError } =
  await import('@/lib/orchestration/capabilities/base-capability');

type AuditableField = (typeof AUDITABLE_FIELDS)[number];

// ---------------------------------------------------------------------------
// Typed mock aliases
// ---------------------------------------------------------------------------

const mockFindUnique = prisma.aiProviderModel.findUnique as ReturnType<typeof vi.fn>;
const mockUpdate = prisma.aiProviderModel.update as ReturnType<typeof vi.fn>;
const mockInvalidateModelCache = invalidateModelCache as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

/** Minimal AiProviderModel DB row with sensible defaults */
function makeModel(overrides: Record<string, unknown> = {}) {
  return {
    id: 'model-1',
    name: 'GPT-4o',
    slug: 'gpt-4o',
    providerSlug: 'openai',
    modelId: 'gpt-4o',
    tierRole: 'reasoning',
    costEfficiency: 'medium',
    isDefault: true,
    metadata: null,
    ...overrides,
  };
}

/** A valid audit change that targets the `costEfficiency` field */
function makeChange(
  overrides: Partial<{
    field: AuditableField;
    currentValue: unknown;
    proposedValue: unknown;
    reason: string;
    confidence: 'high' | 'medium' | 'low';
  }> = {}
) {
  return {
    field: 'costEfficiency' as AuditableField,
    currentValue: 'medium',
    proposedValue: 'high',
    reason: 'Updated based on latest pricing data',
    confidence: 'high' as const,
    ...overrides,
  };
}

const context = { userId: 'u1', agentId: 'a1', conversationId: 'conv-1' };

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  // Default: update succeeds
  mockUpdate.mockResolvedValue({});
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ApplyAuditChangesCapability', () => {
  describe('slug', () => {
    it('slug matches functionDefinition.name', () => {
      const cap = new ApplyAuditChangesCapability();
      expect(cap.slug).toBe(cap.functionDefinition.name);
      expect(cap.slug).toBe('apply_audit_changes');
    });
  });

  describe('validate()', () => {
    it('accepts valid model_id and a single-item changes array', () => {
      const cap = new ApplyAuditChangesCapability();

      const result = cap.validate({
        model_id: 'model-abc',
        changes: [makeChange()],
      });

      expect('model_id' in result && result.model_id).toBe('model-abc');
      expect('changes' in result && result.changes).toHaveLength(1);
    });

    it('accepts up to 50 changes', () => {
      const cap = new ApplyAuditChangesCapability();
      const changes = Array.from({ length: 50 }, (_, i) =>
        makeChange({ field: 'costEfficiency', reason: `Reason ${i}` })
      );

      expect(() => cap.validate({ model_id: 'model-1', changes })).not.toThrow();
    });

    it('rejects when model_id is missing', () => {
      const cap = new ApplyAuditChangesCapability();
      expect(() => cap.validate({ changes: [makeChange()] })).toThrow(CapabilityValidationError);
    });

    it('rejects when model_id is an empty string', () => {
      const cap = new ApplyAuditChangesCapability();
      expect(() => cap.validate({ model_id: '', changes: [makeChange()] })).toThrow(
        CapabilityValidationError
      );
    });

    it('rejects when changes array is empty (min: 1)', () => {
      const cap = new ApplyAuditChangesCapability();
      expect(() => cap.validate({ model_id: 'model-1', changes: [] })).toThrow(
        CapabilityValidationError
      );
    });

    it('rejects when changes exceeds 50 items (max: 50)', () => {
      const cap = new ApplyAuditChangesCapability();
      const changes = Array.from({ length: 51 }, () => makeChange());
      expect(() => cap.validate({ model_id: 'model-1', changes })).toThrow(
        CapabilityValidationError
      );
    });

    it('rejects a change with an invalid confidence value', () => {
      const cap = new ApplyAuditChangesCapability();
      expect(() =>
        cap.validate({
          model_id: 'model-1',
          changes: [makeChange({ confidence: 'very-high' as 'high' })],
        })
      ).toThrow(CapabilityValidationError);
    });

    it('rejects a change with an empty field name', () => {
      const cap = new ApplyAuditChangesCapability();
      expect(() =>
        cap.validate({
          model_id: 'model-1',
          changes: [makeChange({ field: '' as AuditableField })],
        })
      ).toThrow(CapabilityValidationError);
    });
  });

  describe('validate() — field allowlist', () => {
    it('rejects field names not in AUDITABLE_FIELDS (e.g. "id")', () => {
      const cap = new ApplyAuditChangesCapability();
      expect(() =>
        cap.validate({
          model_id: 'model-1',
          changes: [makeChange({ field: 'id' as AuditableField })],
        })
      ).toThrow(CapabilityValidationError);
    });

    it('rejects identity fields like "createdBy"', () => {
      const cap = new ApplyAuditChangesCapability();
      expect(() =>
        cap.validate({
          model_id: 'model-1',
          changes: [makeChange({ field: 'createdBy' as AuditableField })],
        })
      ).toThrow(CapabilityValidationError);
    });

    it('rejects lifecycle fields like "isDefault"', () => {
      const cap = new ApplyAuditChangesCapability();
      expect(() =>
        cap.validate({
          model_id: 'model-1',
          changes: [makeChange({ field: 'isDefault' as AuditableField })],
        })
      ).toThrow(CapabilityValidationError);
    });

    it('rejects prototype pollution attempts ("__proto__")', () => {
      const cap = new ApplyAuditChangesCapability();
      expect(() =>
        cap.validate({
          model_id: 'model-1',
          changes: [makeChange({ field: '__proto__' as AuditableField })],
        })
      ).toThrow(CapabilityValidationError);
    });

    it('accepts all fields in the AUDITABLE_FIELDS allowlist', () => {
      const cap = new ApplyAuditChangesCapability();
      for (const field of AUDITABLE_FIELDS) {
        expect(() =>
          cap.validate({
            model_id: 'model-1',
            changes: [makeChange({ field })],
          })
        ).not.toThrow();
      }
    });
  });

  describe('validate() — multi-model input', () => {
    it('accepts multi-model format with models array', () => {
      const cap = new ApplyAuditChangesCapability();
      const result = cap.validate({
        models: [
          { model_id: 'model-1', changes: [makeChange()] },
          { model_id: 'model-2', changes: [makeChange({ field: 'tierRole' })] },
        ],
      });
      expect('models' in result && result.models).toHaveLength(2);
    });

    it('rejects multi-model input with empty models array', () => {
      const cap = new ApplyAuditChangesCapability();
      expect(() => cap.validate({ models: [] })).toThrow(CapabilityValidationError);
    });

    it('rejects multi-model input when a model has empty changes', () => {
      const cap = new ApplyAuditChangesCapability();
      expect(() =>
        cap.validate({
          models: [{ model_id: 'model-1', changes: [] }],
        })
      ).toThrow(CapabilityValidationError);
    });

    it('accepts approval payload with no models key (no-op for shared payload)', () => {
      const cap = new ApplyAuditChangesCapability();
      const result = cap.validate({ newModels: [], deactivateModels: [] });
      expect('models' in result && result.models).toEqual([]);
    });
  });

  describe('execute() — multi-model', () => {
    it('applies changes across multiple models', async () => {
      mockFindUnique
        .mockResolvedValueOnce(makeModel({ id: 'model-1', costEfficiency: 'medium' }))
        .mockResolvedValueOnce(
          makeModel({ id: 'model-2', tierRole: 'worker', name: 'GPT-4o-mini' })
        );
      mockUpdate.mockResolvedValue({});
      const cap = new ApplyAuditChangesCapability();

      const result = await cap.execute(
        {
          models: [
            {
              model_id: 'model-1',
              changes: [
                makeChange({
                  field: 'costEfficiency',
                  currentValue: 'medium',
                  proposedValue: 'high',
                }),
              ],
            },
            {
              model_id: 'model-2',
              changes: [
                makeChange({
                  field: 'tierRole',
                  currentValue: 'worker',
                  proposedValue: 'infrastructure',
                }),
              ],
            },
          ],
        },
        context
      );

      expect(result.success).toBe(true);
      expect(result.data?.applied).toBe(2);
    });

    it('marks changes as invalid when a model in multi-model input is missing', async () => {
      mockFindUnique.mockResolvedValueOnce(null);
      const cap = new ApplyAuditChangesCapability();

      const result = await cap.execute(
        {
          models: [{ model_id: 'missing-model', changes: [makeChange()] }],
        },
        context
      );

      expect(result.success).toBe(true);
      expect(result.data?.invalid).toBe(1);
      expect(result.data?.applied).toBe(0);
      expect(result.data?.changes[0].status).toBe('invalid');
      expect(result.data?.changes[0].reason).toContain('missing-model');
    });
  });

  describe('execute() — model not found', () => {
    it('marks all changes as invalid when model is not found', async () => {
      // Arrange
      mockFindUnique.mockResolvedValue(null);
      const cap = new ApplyAuditChangesCapability();

      // Act
      const result = await cap.execute(
        { model_id: 'missing-model', changes: [makeChange()] },
        context
      );

      // Assert: returns success with all changes invalid
      expect(result.success).toBe(true);
      expect(result.data?.invalid).toBe(1);
      expect(result.data?.applied).toBe(0);
      expect(result.data?.changes[0].status).toBe('invalid');
      expect(result.data?.changes[0].reason).toContain('missing-model');
    });

    it('never calls prisma.aiProviderModel.update when model is not found', async () => {
      // Arrange
      mockFindUnique.mockResolvedValue(null);
      const cap = new ApplyAuditChangesCapability();

      // Act
      await cap.execute({ model_id: 'missing-model', changes: [makeChange()] }, context);

      // Assert
      expect(mockUpdate).not.toHaveBeenCalled();
    });
  });

  describe('execute() — happy path', () => {
    it('applies a valid change and returns applied=1', async () => {
      // Arrange: model field matches the change currentValue
      mockFindUnique.mockResolvedValue(makeModel({ costEfficiency: 'medium' }));
      const cap = new ApplyAuditChangesCapability();

      // Act
      const result = await cap.execute(
        {
          model_id: 'model-1',
          changes: [
            makeChange({ field: 'costEfficiency', currentValue: 'medium', proposedValue: 'high' }),
          ],
        },
        context
      );

      // Assert
      expect(result.success).toBe(true);
      expect(result.data?.applied).toBe(1);
      expect(result.data?.skipped).toBe(0);
      expect(result.data?.invalid).toBe(0);
      expect(result.data?.modelId).toBe('model-1');
      expect(result.data?.modelName).toBe('GPT-4o');
    });

    it('records the applied change with status applied in the changes array', async () => {
      // Arrange
      mockFindUnique.mockResolvedValue(makeModel({ costEfficiency: 'medium' }));
      const cap = new ApplyAuditChangesCapability();

      // Act
      const result = await cap.execute(
        {
          model_id: 'model-1',
          changes: [
            makeChange({ field: 'costEfficiency', currentValue: 'medium', proposedValue: 'high' }),
          ],
        },
        context
      );

      // Assert
      expect(result.data?.changes).toHaveLength(1);
      expect(result.data?.changes[0]).toMatchObject({
        field: 'costEfficiency',
        previousValue: 'medium',
        newValue: 'high',
        status: 'applied',
      });
    });

    it('calls prisma.aiProviderModel.update with the correct field, then sets isDefault=false in metadata write', async () => {
      // Arrange
      mockFindUnique.mockResolvedValue(makeModel({ costEfficiency: 'medium' }));
      const cap = new ApplyAuditChangesCapability();

      // Act
      await cap.execute(
        {
          model_id: 'model-1',
          changes: [
            makeChange({ field: 'costEfficiency', currentValue: 'medium', proposedValue: 'high' }),
          ],
        },
        context
      );

      // Assert: first update is the field change (no isDefault)
      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'model-1' },
          data: expect.objectContaining({
            costEfficiency: 'high',
          }),
        })
      );
      // Assert: second update is metadata + isDefault batched together
      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'model-1' },
          data: expect.objectContaining({
            isDefault: false,
          }),
        })
      );
    });

    it('returns skipFollowup=true in the result', async () => {
      // Arrange
      mockFindUnique.mockResolvedValue(makeModel({ costEfficiency: 'medium' }));
      const cap = new ApplyAuditChangesCapability();

      // Act
      const result = await cap.execute(
        {
          model_id: 'model-1',
          changes: [makeChange()],
        },
        context
      );

      // Assert
      expect(result.skipFollowup).toBe(true);
    });
  });

  describe('execute() — skipped changes (value drift)', () => {
    it('skips a change when current DB value differs from the change.currentValue', async () => {
      // Arrange: model has costEfficiency='low', but change expects 'medium'
      mockFindUnique.mockResolvedValue(makeModel({ costEfficiency: 'low' }));
      const cap = new ApplyAuditChangesCapability();

      // Act
      const result = await cap.execute(
        {
          model_id: 'model-1',
          changes: [
            makeChange({ field: 'costEfficiency', currentValue: 'medium', proposedValue: 'high' }),
          ],
        },
        context
      );

      // Assert
      expect(result.success).toBe(true);
      expect(result.data?.skipped).toBe(1);
      expect(result.data?.applied).toBe(0);
      expect(result.data?.changes[0]).toMatchObject({
        field: 'costEfficiency',
        status: 'skipped',
      });
    });

    it('includes a descriptive reason for skipped changes', async () => {
      // Arrange
      mockFindUnique.mockResolvedValue(makeModel({ costEfficiency: 'low' }));
      const cap = new ApplyAuditChangesCapability();

      // Act
      const result = await cap.execute(
        {
          model_id: 'model-1',
          changes: [makeChange({ field: 'costEfficiency', currentValue: 'medium' })],
        },
        context
      );

      // Assert
      expect(result.data?.changes[0].reason).toMatch(/changed since audit/i);
    });

    it('does not call update for skipped changes', async () => {
      // Arrange
      mockFindUnique.mockResolvedValue(makeModel({ costEfficiency: 'low' }));
      const cap = new ApplyAuditChangesCapability();

      // Act
      await cap.execute(
        {
          model_id: 'model-1',
          changes: [makeChange({ field: 'costEfficiency', currentValue: 'medium' })],
        },
        context
      );

      // Assert: no field-update calls (only the metadata write would fire, but skipped=0 applied)
      expect(mockUpdate).not.toHaveBeenCalled();
    });
  });

  describe('execute() — invalid changes (schema validation failure)', () => {
    it('marks a change as invalid when the proposed value fails updateProviderModelSchema', async () => {
      // Arrange: 'tierRole' expects specific enum values; 'not-a-real-tier' is invalid
      mockFindUnique.mockResolvedValue(makeModel({ tierRole: 'reasoning' }));
      const cap = new ApplyAuditChangesCapability();

      // Act
      const result = await cap.execute(
        {
          model_id: 'model-1',
          changes: [
            {
              field: 'tierRole',
              currentValue: 'reasoning',
              proposedValue: 'not-a-real-tier',
              reason: 'Changing tier',
              confidence: 'high',
            },
          ],
        },
        context
      );

      // Assert
      expect(result.success).toBe(true);
      expect(result.data?.invalid).toBe(1);
      expect(result.data?.applied).toBe(0);
      expect(result.data?.changes[0]).toMatchObject({
        field: 'tierRole',
        status: 'invalid',
      });
    });

    it('includes a non-empty reason string for invalid changes', async () => {
      // Arrange
      mockFindUnique.mockResolvedValue(makeModel({ tierRole: 'reasoning' }));
      const cap = new ApplyAuditChangesCapability();

      // Act
      const result = await cap.execute(
        {
          model_id: 'model-1',
          changes: [
            {
              field: 'tierRole',
              currentValue: 'reasoning',
              proposedValue: 'not-a-real-tier',
              reason: 'Changing tier',
              confidence: 'medium',
            },
          ],
        },
        context
      );

      // Assert
      expect(result.data?.changes[0].reason?.length).toBeGreaterThan(0);
    });

    it('does not call update for invalid changes', async () => {
      // Arrange
      mockFindUnique.mockResolvedValue(makeModel({ tierRole: 'reasoning' }));
      const cap = new ApplyAuditChangesCapability();

      // Act
      await cap.execute(
        {
          model_id: 'model-1',
          changes: [
            {
              field: 'tierRole',
              currentValue: 'reasoning',
              proposedValue: 'bad-value',
              reason: 'Reason',
              confidence: 'low',
            },
          ],
        },
        context
      );

      // Assert
      expect(mockUpdate).not.toHaveBeenCalled();
    });
  });

  describe('execute() — DB update failure', () => {
    it('marks a change as invalid when prisma.update throws', async () => {
      // Arrange
      mockFindUnique.mockResolvedValue(makeModel({ costEfficiency: 'medium' }));
      // First update (field write) throws; metadata write is never reached
      mockUpdate.mockRejectedValue(new Error('DB connection lost'));
      const cap = new ApplyAuditChangesCapability();

      // Act
      const result = await cap.execute(
        {
          model_id: 'model-1',
          changes: [
            makeChange({ field: 'costEfficiency', currentValue: 'medium', proposedValue: 'high' }),
          ],
        },
        context
      );

      // Assert
      expect(result.success).toBe(true);
      expect(result.data?.invalid).toBe(1);
      expect(result.data?.changes[0].status).toBe('invalid');
      expect(result.data?.changes[0].reason).toMatch(/DB connection lost/);
    });
  });

  describe('execute() — invalidateModelCache', () => {
    it('calls invalidateModelCache after at least one change is applied', async () => {
      // Arrange
      mockFindUnique.mockResolvedValue(makeModel({ costEfficiency: 'medium' }));
      const cap = new ApplyAuditChangesCapability();

      // Act
      await cap.execute(
        {
          model_id: 'model-1',
          changes: [
            makeChange({ field: 'costEfficiency', currentValue: 'medium', proposedValue: 'high' }),
          ],
        },
        context
      );

      // Assert
      expect(mockInvalidateModelCache).toHaveBeenCalledTimes(1);
    });

    it('does NOT call invalidateModelCache when all changes are skipped', async () => {
      // Arrange: value drifted — all changes will be skipped
      mockFindUnique.mockResolvedValue(makeModel({ costEfficiency: 'low' }));
      const cap = new ApplyAuditChangesCapability();

      // Act
      await cap.execute(
        {
          model_id: 'model-1',
          changes: [makeChange({ field: 'costEfficiency', currentValue: 'medium' })],
        },
        context
      );

      // Assert
      expect(mockInvalidateModelCache).not.toHaveBeenCalled();
    });

    it('does NOT call invalidateModelCache when all changes are invalid', async () => {
      // Arrange: proposed value fails schema
      mockFindUnique.mockResolvedValue(makeModel({ tierRole: 'reasoning' }));
      const cap = new ApplyAuditChangesCapability();

      // Act
      await cap.execute(
        {
          model_id: 'model-1',
          changes: [
            {
              field: 'tierRole',
              currentValue: 'reasoning',
              proposedValue: 'bad-value',
              reason: 'Reason',
              confidence: 'low',
            },
          ],
        },
        context
      );

      // Assert
      expect(mockInvalidateModelCache).not.toHaveBeenCalled();
    });
  });

  describe('execute() — audit metadata', () => {
    it('writes lastAudit metadata to the model after applying changes', async () => {
      // Arrange
      mockFindUnique.mockResolvedValue(makeModel({ costEfficiency: 'medium', metadata: null }));
      const cap = new ApplyAuditChangesCapability();

      // Act
      await cap.execute(
        {
          model_id: 'model-1',
          changes: [
            makeChange({ field: 'costEfficiency', currentValue: 'medium', proposedValue: 'high' }),
          ],
        },
        context
      );

      // Assert: second update call writes the metadata
      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'model-1' },
          data: expect.objectContaining({
            metadata: expect.objectContaining({
              lastAudit: expect.objectContaining({
                agentId: 'a1',
                changesApplied: 1,
                changesSkipped: 0,
                changesInvalid: 0,
              }),
            }),
          }),
        })
      );
    });

    it('merges lastAudit into existing metadata without overwriting other keys', async () => {
      // Arrange: model already has metadata with a custom key
      mockFindUnique.mockResolvedValue(
        makeModel({
          costEfficiency: 'medium',
          metadata: { customKey: 'preserved' },
        })
      );
      const cap = new ApplyAuditChangesCapability();

      // Act
      await cap.execute(
        {
          model_id: 'model-1',
          changes: [
            makeChange({ field: 'costEfficiency', currentValue: 'medium', proposedValue: 'high' }),
          ],
        },
        context
      );

      // Assert: the metadata update includes the existing key
      // mockUpdate.mock.calls is any[][] — cast to unknown first to avoid strict tuple errors
      const allCalls = mockUpdate.mock.calls as unknown as Array<
        [{ data: { metadata?: Record<string, unknown> } }]
      >;
      const metadataUpdateCall = allCalls.find((call) => call[0]?.data?.metadata !== undefined);
      expect(metadataUpdateCall).toBeDefined();
      expect(metadataUpdateCall![0].data.metadata).toMatchObject({
        customKey: 'preserved',
        lastAudit: expect.objectContaining({ agentId: 'a1' }),
      });
    });

    it('includes a timestamp string in lastAudit metadata', async () => {
      // Arrange
      mockFindUnique.mockResolvedValue(makeModel({ costEfficiency: 'medium' }));
      const cap = new ApplyAuditChangesCapability();

      // Act
      await cap.execute(
        {
          model_id: 'model-1',
          changes: [
            makeChange({ field: 'costEfficiency', currentValue: 'medium', proposedValue: 'high' }),
          ],
        },
        context
      );

      // Assert
      const allCalls = mockUpdate.mock.calls as unknown as Array<
        [{ data: { metadata?: Record<string, unknown> } }]
      >;
      const metadataUpdateCall = allCalls.find((call) => call[0]?.data?.metadata !== undefined);
      const lastAudit = (
        metadataUpdateCall![0].data.metadata as { lastAudit: { timestamp: string } }
      ).lastAudit;
      expect(typeof lastAudit.timestamp).toBe('string');
      expect(lastAudit.timestamp.length).toBeGreaterThan(0);
    });

    it('does NOT write audit metadata when applied=0', async () => {
      // Arrange: value has drifted — nothing applied
      mockFindUnique.mockResolvedValue(makeModel({ costEfficiency: 'low' }));
      const cap = new ApplyAuditChangesCapability();

      // Act
      await cap.execute(
        {
          model_id: 'model-1',
          changes: [makeChange({ field: 'costEfficiency', currentValue: 'medium' })],
        },
        context
      );

      // Assert: no update calls at all (no field write, no metadata write)
      expect(mockUpdate).not.toHaveBeenCalled();
    });
  });

  describe('execute() — mixed changes', () => {
    it('correctly tallies applied, skipped, and invalid across multiple changes', async () => {
      // Arrange: model has costEfficiency='medium', name='GPT-4o'
      // The model fixture has isActive=undefined, so we only set what we need.
      mockFindUnique.mockResolvedValue(makeModel({ costEfficiency: 'medium' }));
      mockUpdate.mockResolvedValue({});
      const cap = new ApplyAuditChangesCapability();

      // Act:
      //   1. Applied  — costEfficiency matches currentValue='medium' → schema OK → applied
      //   2. Skipped  — costEfficiency currentValue='low' does not match model's 'medium' → skipped
      //   3. Invalid  — costEfficiency proposedValue='not-a-valid-rating' → schema fail → invalid
      const result = await cap.execute(
        {
          model_id: 'model-1',
          changes: [
            // Applied: current value matches, proposed value is valid
            makeChange({ field: 'costEfficiency', currentValue: 'medium', proposedValue: 'high' }),
            // Skipped: change expected 'low' but model has 'medium' (drifted)
            makeChange({ field: 'costEfficiency', currentValue: 'low', proposedValue: 'none' }),
            // Invalid: 'not-a-valid-rating' is not in ratingLevelSchema
            makeChange({
              field: 'costEfficiency',
              currentValue: 'medium',
              proposedValue: 'not-a-valid-rating',
            }),
          ],
        },
        context
      );

      // Assert
      expect(result.success).toBe(true);
      expect(result.data?.applied).toBe(1);
      expect(result.data?.skipped).toBe(1);
      expect(result.data?.invalid).toBe(1);
      expect(result.data?.changes).toHaveLength(3);
    });
  });
});
