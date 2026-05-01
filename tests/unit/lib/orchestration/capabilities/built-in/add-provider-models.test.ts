/**
 * Tests for the AddProviderModelsCapability built-in.
 *
 * Test Coverage:
 * - slug matches functionDefinition.name
 * - Validates valid input (newModels array)
 * - Rejects empty newModels array
 * - Rejects invalid slug format
 * - Rejects missing required fields
 * - Happy path — creates model and returns created=1
 * - Handles P2002 duplicate slug → skipped
 * - Calls invalidateModelCache after creation
 * - Does NOT call invalidateModelCache when no models created
 * - Sets isDefault=false and createdBy from context
 * - Stores addedByAudit metadata
 * - Handles DB errors gracefully
 *
 * @see lib/orchestration/capabilities/built-in/add-provider-models.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — must be declared before dynamic imports
// ---------------------------------------------------------------------------

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiProviderModel: {
      create: vi.fn(),
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
const { AddProviderModelsCapability } =
  await import('@/lib/orchestration/capabilities/built-in/add-provider-models');
const { CapabilityValidationError } =
  await import('@/lib/orchestration/capabilities/base-capability');

// Import real Prisma error class for instanceof checks in capability code
const { Prisma } = await import('@prisma/client');

// ---------------------------------------------------------------------------
// Typed mock aliases
// ---------------------------------------------------------------------------

const mockCreate = prisma.aiProviderModel.create as ReturnType<typeof vi.fn>;
const mockInvalidateModelCache = invalidateModelCache as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

type TierRole =
  | 'thinking'
  | 'worker'
  | 'infrastructure'
  | 'control_plane'
  | 'local_sovereign'
  | 'embedding';
type RatingLevel = 'very_high' | 'high' | 'medium' | 'none';
type LatencyLevel = 'very_fast' | 'fast' | 'medium';
type ContextLevel = 'very_high' | 'high' | 'medium' | 'n_a';
type ToolUseLevel = 'strong' | 'moderate' | 'none';
type QualityLevel = 'high' | 'medium' | 'budget';

function makeNewModel(
  overrides: Partial<{
    name: string;
    slug: string;
    providerSlug: string;
    modelId: string;
    description: string;
    capabilities: ('chat' | 'embedding')[];
    tierRole: TierRole;
    bestRole: string;
    reasoningDepth: RatingLevel;
    latency: LatencyLevel;
    costEfficiency: RatingLevel;
    contextLength: ContextLevel;
    toolUse: ToolUseLevel;
    dimensions: number;
    schemaCompatible: boolean;
    quality: QualityLevel;
  }> = {}
) {
  return {
    name: 'GPT-5' as string,
    slug: 'openai-gpt-5' as string,
    providerSlug: 'openai' as string,
    modelId: 'gpt-5' as string,
    description: 'Next-generation reasoning model from OpenAI.' as string,
    capabilities: ['chat'] as ('chat' | 'embedding')[],
    tierRole: 'thinking' as TierRole,
    bestRole: 'Complex multi-step reasoning and analysis' as string,
    reasoningDepth: 'very_high' as RatingLevel,
    latency: 'medium' as LatencyLevel,
    costEfficiency: 'none' as RatingLevel,
    contextLength: 'very_high' as ContextLevel,
    toolUse: 'strong' as ToolUseLevel,
    ...overrides,
  };
}

const context = { userId: 'u1', agentId: 'a1', conversationId: 'conv-1' };

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockCreate.mockResolvedValue({ id: 'new-model-1' });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AddProviderModelsCapability', () => {
  describe('slug', () => {
    it('slug matches functionDefinition.name', () => {
      const cap = new AddProviderModelsCapability();
      expect(cap.slug).toBe(cap.functionDefinition.name);
      expect(cap.slug).toBe('add_provider_models');
    });
  });

  describe('validate()', () => {
    it('accepts valid newModels array with a single model', () => {
      const cap = new AddProviderModelsCapability();
      const result = cap.validate({ newModels: [makeNewModel()] });
      expect(result.newModels).toHaveLength(1);
    });

    it('accepts up to 20 models', () => {
      const cap = new AddProviderModelsCapability();
      const newModels = Array.from({ length: 20 }, (_, i) =>
        makeNewModel({ slug: `model-${i}`, name: `Model ${i}` })
      );
      expect(() => cap.validate({ newModels })).not.toThrow();
    });

    it('accepts empty newModels array (no-op when approval has no new models)', () => {
      const cap = new AddProviderModelsCapability();
      const result = cap.validate({ newModels: [] });
      expect(result.newModels).toEqual([]);
    });

    it('rejects when newModels exceeds 20 items', () => {
      const cap = new AddProviderModelsCapability();
      const newModels = Array.from({ length: 21 }, (_, i) =>
        makeNewModel({ slug: `model-${i}`, name: `Model ${i}` })
      );
      expect(() => cap.validate({ newModels })).toThrow(CapabilityValidationError);
    });

    it('rejects invalid slug format (uppercase)', () => {
      const cap = new AddProviderModelsCapability();
      expect(() => cap.validate({ newModels: [makeNewModel({ slug: 'Invalid-Slug' })] })).toThrow(
        CapabilityValidationError
      );
    });

    it('rejects invalid slug format (spaces)', () => {
      const cap = new AddProviderModelsCapability();
      expect(() => cap.validate({ newModels: [makeNewModel({ slug: 'has spaces' })] })).toThrow(
        CapabilityValidationError
      );
    });

    it('rejects missing required field (name)', () => {
      const cap = new AddProviderModelsCapability();
      const model = makeNewModel();

      delete (model as any).name;
      expect(() => cap.validate({ newModels: [model] })).toThrow(CapabilityValidationError);
    });

    it('rejects missing required field (providerSlug)', () => {
      const cap = new AddProviderModelsCapability();
      const model = makeNewModel();

      delete (model as any).providerSlug;
      expect(() => cap.validate({ newModels: [model] })).toThrow(CapabilityValidationError);
    });

    it('rejects invalid tierRole value', () => {
      const cap = new AddProviderModelsCapability();
      expect(() =>
        cap.validate({ newModels: [makeNewModel({ tierRole: 'invalid-tier' as TierRole })] })
      ).toThrow(CapabilityValidationError);
    });
  });

  describe('execute() — happy path', () => {
    it('creates a model and returns created=1', async () => {
      const cap = new AddProviderModelsCapability();
      const result = await cap.execute({ newModels: [makeNewModel()] }, context);

      expect(result.success).toBe(true);
      expect(result.data?.created).toBe(1);
      expect(result.data?.skipped).toBe(0);
      expect(result.data?.invalid).toBe(0);
      expect(result.data?.models).toHaveLength(1);
      expect(result.data?.models[0].status).toBe('created');
    });

    it('passes correct data to prisma.create including isDefault=false', async () => {
      const cap = new AddProviderModelsCapability();
      await cap.execute({ newModels: [makeNewModel()] }, context);

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            name: 'GPT-5',
            slug: 'openai-gpt-5',
            providerSlug: 'openai',
            modelId: 'gpt-5',
            isDefault: false,
            isActive: true,
            createdBy: 'u1',
          }),
        })
      );
    });

    it('sets createdBy from context.userId', async () => {
      const cap = new AddProviderModelsCapability();
      await cap.execute(
        { newModels: [makeNewModel()] },
        { userId: 'admin-42', agentId: 'a1', conversationId: 'c1' }
      );

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ createdBy: 'admin-42' }),
        })
      );
    });

    it('stores addedByAudit metadata with timestamp and agentId', async () => {
      const cap = new AddProviderModelsCapability();
      await cap.execute({ newModels: [makeNewModel()] }, context);

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            metadata: expect.objectContaining({
              addedByAudit: expect.objectContaining({
                agentId: 'a1',
                timestamp: expect.any(String),
              }),
            }),
          }),
        })
      );
    });

    it('creates multiple models in sequence', async () => {
      const cap = new AddProviderModelsCapability();
      const result = await cap.execute(
        {
          newModels: [
            makeNewModel({ slug: 'model-a', name: 'Model A' }),
            makeNewModel({ slug: 'model-b', name: 'Model B' }),
          ],
        },
        context
      );

      expect(result.data?.created).toBe(2);
      expect(mockCreate).toHaveBeenCalledTimes(2);
    });

    it('returns skipFollowup=true', async () => {
      const cap = new AddProviderModelsCapability();
      const result = await cap.execute({ newModels: [makeNewModel()] }, context);
      expect(result.skipFollowup).toBe(true);
    });
  });

  describe('execute() — duplicate slug (P2002)', () => {
    it('marks model as skipped when slug already exists', async () => {
      mockCreate.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: '0.0.0',
        })
      );
      const cap = new AddProviderModelsCapability();

      const result = await cap.execute(
        { newModels: [makeNewModel({ slug: 'existing-slug' })] },
        context
      );

      expect(result.success).toBe(true);
      expect(result.data?.created).toBe(0);
      expect(result.data?.skipped).toBe(1);
      expect(result.data?.models[0].status).toBe('skipped');
      expect(result.data?.models[0].reason).toContain('existing-slug');
    });
  });

  describe('execute() — DB error', () => {
    it('marks model as invalid when create throws a non-P2002 error', async () => {
      mockCreate.mockRejectedValue(new Error('Connection lost'));
      const cap = new AddProviderModelsCapability();

      const result = await cap.execute({ newModels: [makeNewModel()] }, context);

      expect(result.success).toBe(true);
      expect(result.data?.invalid).toBe(1);
      expect(result.data?.models[0].status).toBe('invalid');
      expect(result.data?.models[0].reason).toContain('Connection lost');
    });
  });

  describe('execute() — invalidateModelCache', () => {
    it('calls invalidateModelCache after at least one model is created', async () => {
      const cap = new AddProviderModelsCapability();
      await cap.execute({ newModels: [makeNewModel()] }, context);
      expect(mockInvalidateModelCache).toHaveBeenCalledTimes(1);
    });

    it('does NOT call invalidateModelCache when all models are skipped', async () => {
      mockCreate.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: '0.0.0',
        })
      );
      const cap = new AddProviderModelsCapability();

      await cap.execute({ newModels: [makeNewModel()] }, context);

      expect(mockInvalidateModelCache).not.toHaveBeenCalled();
    });

    it('does NOT call invalidateModelCache when all models fail', async () => {
      mockCreate.mockRejectedValue(new Error('DB down'));
      const cap = new AddProviderModelsCapability();

      await cap.execute({ newModels: [makeNewModel()] }, context);

      expect(mockInvalidateModelCache).not.toHaveBeenCalled();
    });
  });

  describe('execute() — embedding model', () => {
    it('passes embedding-specific fields (dimensions, quality, schemaCompatible)', async () => {
      const cap = new AddProviderModelsCapability();
      await cap.execute(
        {
          newModels: [
            makeNewModel({
              slug: 'openai-embed-v4',
              name: 'text-embedding-v4',
              capabilities: ['embedding'],
              tierRole: 'embedding',
              dimensions: 3072,
              quality: 'high',
              schemaCompatible: false,
            }),
          ],
        },
        context
      );

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            dimensions: 3072,
            quality: 'high',
            schemaCompatible: false,
          }),
        })
      );
    });
  });
});
