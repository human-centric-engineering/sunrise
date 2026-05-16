/**
 * Deactivate Provider Models capability
 *
 * Soft-deletes `AiProviderModel` entries by setting `isActive = false`.
 * Used by the Provider Model Audit workflow when the LLM identifies
 * deprecated or discontinued models that should be removed from the
 * active registry.
 *
 * Each deactivation is verified against the current DB state:
 * - Already-inactive models are skipped (no redundant write)
 * - Missing model IDs are reported as invalid
 *
 * Runs after the human_approval step, receiving admin-approved
 * deactivation proposals.
 */

import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { invalidateModelCache } from '@/lib/orchestration/llm/provider-selector';
import { BaseCapability } from '@/lib/orchestration/capabilities/base-capability';
import { unwrapApprovalPayload } from '@/lib/orchestration/capabilities/approval-payload-unwrap';
import type {
  CapabilityContext,
  CapabilityFunctionDefinition,
  CapabilityResult,
} from '@/lib/orchestration/capabilities/types';

const deactivateEntrySchema = z.object({
  modelId: z.string().min(1).max(100),
  reason: z.string().min(1).max(1000),
});

// Unwrap an `approvalPayload: { deactivateModels }` envelope written by
// `approval-actions.ts` so the existing top-level schema matches when
// called via `argsFrom` from a human_approval step.
const schema = z.preprocess(
  unwrapApprovalPayload,
  z.object({
    deactivateModels: z.array(deactivateEntrySchema).max(50).default([]),
  })
);

type Args = z.infer<typeof schema>;

interface DeactivatedModel {
  modelId: string;
  name: string;
  status: 'deactivated' | 'skipped' | 'invalid';
  reason?: string;
}

interface Data {
  deactivated: number;
  skipped: number;
  invalid: number;
  models: DeactivatedModel[];
}

export class DeactivateProviderModelsCapability extends BaseCapability<Args, Data> {
  readonly slug = 'deactivate_provider_models';

  readonly functionDefinition: CapabilityFunctionDefinition = {
    name: 'deactivate_provider_models',
    description:
      'Deactivate (soft-delete) provider model entries that have been deprecated or discontinued. Sets isActive=false. Already-inactive models are skipped.',
    parameters: {
      type: 'object',
      properties: {
        deactivateModels: {
          type: 'array',
          description: 'Array of models to deactivate.',
          items: {
            type: 'object',
            properties: {
              modelId: {
                type: 'string',
                description: 'The ID of the provider model to deactivate.',
              },
              reason: {
                type: 'string',
                description:
                  'Why this model should be deactivated (e.g. "Model deprecated by provider on 2026-03-01").',
              },
            },
            required: ['modelId', 'reason'],
          },
          minItems: 1,
          maxItems: 50,
        },
      },
      required: ['deactivateModels'],
    },
  };

  protected readonly schema = schema;

  async execute(args: Args, context: CapabilityContext): Promise<CapabilityResult<Data>> {
    // Empty array — nothing to deactivate (e.g. approval payload had no deactivations)
    if (args.deactivateModels.length === 0) {
      return this.success(
        { deactivated: 0, skipped: 0, invalid: 0, models: [] },
        { skipFollowup: true }
      );
    }

    const results: DeactivatedModel[] = [];
    let deactivated = 0;
    let skipped = 0;
    let invalid = 0;

    for (const entry of args.deactivateModels) {
      const model = await prisma.aiProviderModel.findUnique({
        where: { id: entry.modelId },
        select: { id: true, name: true, isActive: true, metadata: true },
      });

      if (!model) {
        logger.warn('Audit: deactivation target not found', { modelId: entry.modelId });
        results.push({
          modelId: entry.modelId,
          name: 'unknown',
          status: 'invalid',
          reason: `Provider model ${entry.modelId} not found`,
        });
        invalid++;
        continue;
      }

      if (!model.isActive) {
        logger.info('Audit: model already inactive, skipping deactivation', {
          modelId: entry.modelId,
          name: model.name,
        });
        results.push({
          modelId: entry.modelId,
          name: model.name,
          status: 'skipped',
          reason: 'Model is already inactive',
        });
        skipped++;
        continue;
      }

      try {
        const existingMetadata =
          model.metadata && typeof model.metadata === 'object' && !Array.isArray(model.metadata)
            ? (model.metadata as Record<string, unknown>)
            : {};
        await prisma.aiProviderModel.update({
          where: { id: entry.modelId },
          data: {
            isActive: false,
            metadata: {
              ...existingMetadata,
              deactivatedByAudit: {
                timestamp: new Date().toISOString(),
                agentId: context.agentId,
                reason: entry.reason,
              },
            },
          },
        });

        logger.info('Audit: provider model deactivated', {
          modelId: entry.modelId,
          name: model.name,
          reason: entry.reason,
          agentId: context.agentId,
        });

        results.push({
          modelId: entry.modelId,
          name: model.name,
          status: 'deactivated',
        });
        deactivated++;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        logger.error('Audit: failed to deactivate provider model', {
          modelId: entry.modelId,
          error: message,
        });
        results.push({
          modelId: entry.modelId,
          name: model.name,
          status: 'invalid',
          reason: message,
        });
        invalid++;
      }
    }

    if (deactivated > 0) {
      invalidateModelCache();
    }

    return this.success({ deactivated, skipped, invalid, models: results }, { skipFollowup: true });
  }
}
