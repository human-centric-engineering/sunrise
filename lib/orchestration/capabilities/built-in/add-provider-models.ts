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
import {
  isHalfPrice,
  MAX_PRICE_PER_MILLION_TOKENS,
  PRICE_PAIR_MESSAGE,
  splitPriceInputSchema,
} from '@/lib/validations/model-pricing';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { invalidateModelCache } from '@/lib/orchestration/llm/provider-selector';
import { BaseCapability } from '@/lib/orchestration/capabilities/base-capability';
import { unwrapApprovalPayload } from '@/lib/orchestration/capabilities/approval-payload-unwrap';
import { CAPABILITIES } from '@/lib/orchestration/model-audit/enums';
import { isEmbedUserId } from '@/lib/embed/auth';
import type {
  CapabilityContext,
  CapabilityFunctionDefinition,
  CapabilityResult,
} from '@/lib/orchestration/capabilities/types';

/**
 * A new model's chat prices (t-774), read one model at a time: each must be
 * a valid price (a numeric string, as the approval screen sends an edited
 * cell, is read as a number), and they come as a pair. `null` or absent is
 * an admin clearing the cell, or the audit finding no price: no price.
 */
function readPrices(
  rawInput: unknown,
  rawOutput: unknown
): { ok: true; input: number | null; output: number | null } | { ok: false; reason: string } {
  const read = (raw: unknown, label: string): number | null | string => {
    if (raw === null || raw === undefined) return null;
    const parsed = splitPriceInputSchema.safeParse(raw);
    return parsed.success
      ? parsed.data
      : `${label} price must be a number from 0 to ${MAX_PRICE_PER_MILLION_TOKENS} per 1M tokens`;
  };
  const input = read(rawInput, 'Input');
  const output = read(rawOutput, 'Output');
  if (typeof input === 'string') return { ok: false, reason: input };
  if (typeof output === 'string') return { ok: false, reason: output };
  // Half a price records the other half of every turn at $0.
  if (isHalfPrice(input, output)) {
    return { ok: false, reason: PRICE_PAIR_MESSAGE };
  }
  return { ok: true, input, output };
}

const newModelSchema = z.object({
  name: z.string().trim().min(1).max(100),
  slug: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Slug must be lowercase alphanumeric with hyphens only')
    .max(80),
  providerSlug: z.string().trim().min(1).max(50),
  modelId: z.string().trim().min(1).max(100),
  description: z.string().trim().min(1).max(2000),
  // Source the closed set from the canonical CAPABILITIES enum so this
  // capability stays in sync with the audit-proposals Zod schema and
  // the analyse_chat / discover_new_models prompts. The previous
  // hardcoded list was missing `vision` and `documents`, which the
  // audit pipeline emits as valid proposals — the workflow then died
  // here at step 14 (add_approved_models) with a confusing schema
  // error.
  capabilities: z
    .array(z.enum(CAPABILITIES as unknown as [string, ...string[]]))
    .min(1)
    .default(['chat']),
  tierRole: z.enum(['thinking', 'worker', 'infrastructure', 'control_plane', 'embedding']),
  deploymentProfiles: z
    .array(z.enum(['hosted', 'sovereign']))
    .min(1)
    .max(8)
    .default(['hosted']),
  reasoningDepth: z.enum(['very_high', 'high', 'medium', 'none']).default('medium'),
  latency: z.enum(['very_fast', 'fast', 'medium']).default('medium'),
  costEfficiency: z.enum(['very_high', 'high', 'medium', 'none']).default('medium'),
  contextLength: z.enum(['very_high', 'high', 'medium', 'n_a']).default('medium'),
  toolUse: z.enum(['strong', 'moderate', 'none']).default('none'),
  bestRole: z.string().trim().min(1).max(200),
  // Embedding-specific (optional)
  dimensions: z.number().int().positive().optional(),
  schemaCompatible: z.boolean().optional(),
  quality: z.enum(['high', 'medium', 'budget']).optional(),
  // Chat pricing per 1M tokens (t-774), proposed by the audit and checked
  // by the admin. Created only as a pair (see `execute`).
  // Validated per model in `execute`, not here: one bad cell an admin typed
  // on the approval screen must fail that model, not every approved one.
  inputCostPerMillionTokens: z.unknown().optional(),
  outputCostPerMillionTokens: z.unknown().optional(),
});

// Unwrap an `approvalPayload: { newModels }` envelope written by
// `approval-actions.ts` so the existing top-level `newModels` schema
// matches when called via `argsFrom` from a human_approval step.
const schema = z.preprocess(
  unwrapApprovalPayload,
  z.object({
    newModels: z.array(newModelSchema).max(20).default([]),
  })
);

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
  readonly processesPii = false;
  /** Provider models are shared settings: refused outside the install org at `multi` (§107 t-751). */
  readonly writesSharedSettings = true;

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
                  // Mirror the runtime Zod enum above — sourced from the
                  // canonical CAPABILITIES constant so the tool definition
                  // shown to LLMs and the validation gate that catches
                  // their output never disagree.
                  enum: [...CAPABILITIES],
                },
                description: 'Model capabilities.',
              },
              tierRole: {
                type: 'string',
                enum: ['thinking', 'worker', 'infrastructure', 'control_plane', 'embedding'],
                description:
                  'Capability tier classification — what the model is for. Orthogonal to deploymentProfiles (where it runs).',
              },
              deploymentProfiles: {
                type: 'array',
                items: { type: 'string', enum: ['hosted', 'sovereign'] },
                description:
                  'Deployment locus — where the model runs. `hosted` is vendor-managed; `sovereign` is operator infrastructure. Defaults to ["hosted"].',
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
              inputCostPerMillionTokens: {
                type: 'number',
                description:
                  'Published USD price per 1M input tokens. Set together with outputCostPerMillionTokens, or omit both.',
              },
              outputCostPerMillionTokens: {
                type: 'number',
                description:
                  'Published USD price per 1M output tokens. Set together with inputCostPerMillionTokens, or omit both.',
              },
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
    // An anonymous embed widget visitor is not a `User`, and `createdBy` is a
    // FK to one (#705, t-765). Changing the provider catalogue is an
    // operator's act, so a visitor is refused outright rather than recorded
    // as no one; this reaches a visitor only if an admin binds the capability
    // to an agent published on the widget.
    if (isEmbedUserId(context.userId)) {
      return this.error(
        'Adding provider models is unavailable to anonymous embed widget visitors.',
        'anonymous_visitor'
      );
    }

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
      // A price the admin left half-set or mistyped doesn't cost them the
      // model they approved: it is created without prices, and the result
      // says why. Unpriced turns are recorded as such, never at a wrong rate.
      const read = readPrices(model.inputCostPerMillionTokens, model.outputCostPerMillionTokens);
      const prices = read.ok ? read : { input: null, output: null };
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
            deploymentProfiles: model.deploymentProfiles,
            reasoningDepth: model.reasoningDepth,
            latency: model.latency,
            costEfficiency: model.costEfficiency,
            contextLength: model.contextLength,
            toolUse: model.toolUse,
            bestRole: model.bestRole,
            dimensions: model.dimensions ?? null,
            schemaCompatible: model.schemaCompatible ?? null,
            quality: model.quality ?? null,
            inputCostPerMillionTokens: prices.input,
            outputCostPerMillionTokens: prices.output,
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
          ...(!read.ok && { reason: `Created without prices: ${read.reason}` }),
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
