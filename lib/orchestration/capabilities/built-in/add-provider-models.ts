/**
 * Add Provider Models capability
 *
 * Creates new `AiProviderModel` entries from approved audit proposals.
 * Each model is validated against the create schema before insertion.
 * Duplicate slugs (P2002) are caught and reported as "skipped" rather
 * than failing the entire batch.
 *
 * Runs after the human_approval step in the Provider Model Audit
 * workflow, receiving approved new model proposals.
 */

import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { invalidateModelCache } from '@/lib/orchestration/llm/provider-selector';
import { BaseCapability } from '@/lib/orchestration/capabilities/base-capability';
import type {
  CapabilityContext,
  CapabilityFunctionDefinition,
  CapabilityResult,
} from '@/lib/orchestration/capabilities/types';

const newModelSchema = z.object({
  name: z.string().min(1).max(100).trim(),
  slug: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Slug must be lowercase alphanumeric with hyphens only')
    .max(80),
  providerSlug: z.string().min(1).max(50).trim(),
  modelId: z.string().min(1).max(100).trim(),
  description: z.string().min(1).max(2000).trim(),
  capabilities: z
    .array(z.enum(['chat', 'reasoning', 'embedding', 'audio', 'image', 'moderation']))
    .min(1)
    .default(['chat']),
  tierRole: z.enum([
    'thinking',
    'worker',
    'infrastructure',
    'control_plane',
    'local_sovereign',
    'embedding',
  ]),
  reasoningDepth: z.enum(['very_high', 'high', 'medium', 'none']).default('medium'),
  latency: z.enum(['very_fast', 'fast', 'medium']).default('medium'),
  costEfficiency: z.enum(['very_high', 'high', 'medium', 'none']).default('medium'),
  contextLength: z.enum(['very_high', 'high', 'medium', 'n_a']).default('medium'),
  toolUse: z.enum(['strong', 'moderate', 'none']).default('none'),
  bestRole: z.string().min(1).max(200).trim(),
  // Embedding-specific (optional)
  dimensions: z.number().int().positive().optional(),
  schemaCompatible: z.boolean().optional(),
  quality: z.enum(['high', 'medium', 'budget']).optional(),
});

const schema = z.object({
  newModels: z.array(newModelSchema).max(20).default([]),
});

type Args = z.infer<typeof schema>;

interface CreatedModel {
  name: string;
  slug: string;
  providerSlug: string;
  status: 'created' | 'skipped' | 'invalid';
  reason?: string;
}

interface Data {
  created: number;
  skipped: number;
  invalid: number;
  models: CreatedModel[];
}

export class AddProviderModelsCapability extends BaseCapability<Args, Data> {
  readonly slug = 'add_provider_models';

  readonly functionDefinition: CapabilityFunctionDefinition = {
    name: 'add_provider_models',
    description:
      'Add new provider model entries to the registry. Each model is validated against the create schema. Duplicate slugs are skipped. Invalidates the model cache after all creates.',
    parameters: {
      type: 'object',
      properties: {
        newModels: {
          type: 'array',
          description: 'Array of new model entries to create.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Human-readable model name.' },
              slug: {
                type: 'string',
                description: 'URL-safe slug (lowercase alphanumeric with hyphens).',
              },
              providerSlug: { type: 'string', description: 'Provider identifier.' },
              modelId: { type: 'string', description: 'API model identifier.' },
              description: { type: 'string', description: 'Brief model description.' },
              capabilities: {
                type: 'array',
                items: {
                  type: 'string',
                  enum: ['chat', 'reasoning', 'embedding', 'audio', 'image', 'moderation'],
                },
                description: 'Model capabilities.',
              },
              tierRole: {
                type: 'string',
                enum: [
                  'thinking',
                  'worker',
                  'infrastructure',
                  'control_plane',
                  'local_sovereign',
                  'embedding',
                ],
                description: 'Tier classification.',
              },
              reasoningDepth: {
                type: 'string',
                enum: ['very_high', 'high', 'medium', 'none'],
              },
              latency: { type: 'string', enum: ['very_fast', 'fast', 'medium'] },
              costEfficiency: {
                type: 'string',
                enum: ['very_high', 'high', 'medium', 'none'],
              },
              contextLength: {
                type: 'string',
                enum: ['very_high', 'high', 'medium', 'n_a'],
              },
              toolUse: { type: 'string', enum: ['strong', 'moderate', 'none'] },
              bestRole: { type: 'string', description: 'Optimal use case summary.' },
              dimensions: { type: 'number', description: 'Embedding vector dimensions.' },
              schemaCompatible: {
                type: 'boolean',
                description: 'Compatible with pgvector(1536) schema.',
              },
              quality: { type: 'string', enum: ['high', 'medium', 'budget'] },
            },
            required: [
              'name',
              'slug',
              'providerSlug',
              'modelId',
              'description',
              'capabilities',
              'tierRole',
              'bestRole',
            ],
          },
          minItems: 1,
          maxItems: 20,
        },
      },
      required: ['newModels'],
    },
  };

  protected readonly schema = schema;

  async execute(args: Args, context: CapabilityContext): Promise<CapabilityResult<Data>> {
    // Empty array — nothing to add (e.g. approval payload had no new models)
    if (args.newModels.length === 0) {
      return this.success(
        { created: 0, skipped: 0, invalid: 0, models: [] },
        { skipFollowup: true }
      );
    }

    const results: CreatedModel[] = [];
    let created = 0;
    let skipped = 0;
    let invalid = 0;

    for (const model of args.newModels) {
      try {
        await prisma.aiProviderModel.create({
          data: {
            name: model.name,
            slug: model.slug,
            providerSlug: model.providerSlug,
            modelId: model.modelId,
            description: model.description,
            capabilities: model.capabilities,
            tierRole: model.tierRole,
            reasoningDepth: model.reasoningDepth,
            latency: model.latency,
            costEfficiency: model.costEfficiency,
            contextLength: model.contextLength,
            toolUse: model.toolUse,
            bestRole: model.bestRole,
            dimensions: model.dimensions ?? null,
            schemaCompatible: model.schemaCompatible ?? null,
            quality: model.quality ?? null,
            isDefault: false,
            isActive: true,
            createdBy: context.userId,
            metadata: {
              addedByAudit: {
                timestamp: new Date().toISOString(),
                agentId: context.agentId,
              },
            },
          },
        });

        logger.info('Audit: new provider model created', {
          slug: model.slug,
          providerSlug: model.providerSlug,
          agentId: context.agentId,
        });

        results.push({
          name: model.name,
          slug: model.slug,
          providerSlug: model.providerSlug,
          status: 'created',
        });
        created++;
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          logger.warn('Audit: duplicate slug, skipping model creation', {
            slug: model.slug,
          });
          results.push({
            name: model.name,
            slug: model.slug,
            providerSlug: model.providerSlug,
            status: 'skipped',
            reason: `Model with slug '${model.slug}' already exists`,
          });
          skipped++;
        } else {
          const message = err instanceof Error ? err.message : 'Unknown error';
          logger.error('Audit: failed to create provider model', {
            slug: model.slug,
            error: message,
          });
          results.push({
            name: model.name,
            slug: model.slug,
            providerSlug: model.providerSlug,
            status: 'invalid',
            reason: message,
          });
          invalid++;
        }
      }
    }

    if (created > 0) {
      invalidateModelCache();
    }

    return this.success({ created, skipped, invalid, models: results }, { skipFollowup: true });
  }
}
