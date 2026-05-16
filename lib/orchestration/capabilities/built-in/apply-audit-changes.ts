/**
 * Apply Audit Changes capability
 *
 * Receives approved model audit changes from a `human_approval` step
 * and applies them to the `AiProviderModel` table via Prisma. Each
 * change is validated against the `updateProviderModelSchema` before
 * being written. After all updates, the model cache is invalidated
 * so subsequent queries reflect the new data.
 *
 * Audit metadata (timestamp, source, confidence) is stored in the
 * model's `metadata` JSON field for provenance tracking.
 */

import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { invalidateModelCache } from '@/lib/orchestration/llm/provider-selector';
import { updateProviderModelSchema } from '@/lib/validations/orchestration';
import { BaseCapability } from '@/lib/orchestration/capabilities/base-capability';
import { unwrapApprovalPayload } from '@/lib/orchestration/capabilities/approval-payload-unwrap';
import type {
  CapabilityContext,
  CapabilityFunctionDefinition,
  CapabilityResult,
} from '@/lib/orchestration/capabilities/types';

/**
 * Fields that audits are allowed to modify. Intentionally narrower than
 * `updateProviderModelSchema` — audits change classification/ratings,
 * not identity (`id`, `slug`, `name`) or lifecycle (`isDefault`, `isActive`,
 * `createdBy`, `metadata`) fields.
 */
export const AUDITABLE_FIELDS = [
  'tierRole',
  'deploymentProfiles',
  'reasoningDepth',
  'latency',
  'costEfficiency',
  'contextLength',
  'toolUse',
  'bestRole',
  'description',
  'dimensions',
  'schemaCompatible',
  'quality',
] as const;

/** A single field change the LLM proposed and the admin accepted */
const auditChangeSchema = z.object({
  field: z.enum(AUDITABLE_FIELDS),
  currentValue: z.unknown(),
  proposedValue: z.unknown(),
  reason: z.string().min(1).max(1000),
  confidence: z.enum(['high', 'medium', 'low']),
});

const singleModelSchema = z.object({
  model_id: z.string().min(1).max(100),
  changes: z.array(auditChangeSchema).min(1).max(50),
});

const multiModelSchema = z.object({
  models: z
    .array(
      z.object({
        model_id: z.string().min(1).max(100),
        changes: z.array(auditChangeSchema).min(1).max(50),
      })
    )
    .max(50),
});

/**
 * The approval payload contains all three categories (models, newModels,
 * deactivateModels). When this capability receives the full payload and
 * neither `model_id`/`changes` nor `models` is present, there are no
 * changes to apply — we normalise to an empty multi-model input.
 *
 * A `preprocess(unwrapApprovalPayload, ...)` lifts an
 * `approvalPayload: { models, ... }` envelope (written by
 * `approval-actions.ts`) to top-level so the existing union picks the
 * `models` array directly.
 *
 * `multiModelSchema.models` accepts an empty array — admins can reject
 * every proposed change, and the no-op is recorded without erroring.
 */
const schema = z.preprocess(
  unwrapApprovalPayload,
  z.union([
    singleModelSchema,
    multiModelSchema,
    z
      .object({})
      .passthrough()
      .refine(
        (v) => !('model_id' in v) && !('models' in v) && !('changes' in v),
        'Expected model_id + changes, or models array'
      )
      .transform(() => ({ models: [] as z.infer<typeof multiModelSchema>['models'] })),
  ])
);

type Args = z.infer<typeof schema>;

interface AppliedChange {
  field: string;
  previousValue: unknown;
  newValue: unknown;
  status: 'applied' | 'skipped' | 'invalid';
  reason?: string;
}

interface Data {
  modelId: string;
  modelName: string;
  applied: number;
  skipped: number;
  invalid: number;
  changes: AppliedChange[];
}

export class ApplyAuditChangesCapability extends BaseCapability<Args, Data> {
  readonly slug = 'apply_audit_changes';

  readonly functionDefinition: CapabilityFunctionDefinition = {
    name: 'apply_audit_changes',
    description:
      'Apply approved audit changes to provider model entries. Accepts a single model (model_id + changes) or multiple models (models array). Each change updates one auditable field after validation. Invalidates the model cache after all updates.',
    parameters: {
      type: 'object',
      properties: {
        model_id: {
          type: 'string',
          description: 'The ID of the provider model to update (single-model mode).',
          minLength: 1,
          maxLength: 100,
        },
        changes: {
          type: 'array',
          description: 'Array of approved field changes to apply (single-model mode).',
          items: {
            type: 'object',
            properties: {
              field: {
                type: 'string',
                enum: [...AUDITABLE_FIELDS],
                description: 'The auditable field name to update.',
              },
              currentValue: {
                description: 'The current value of the field (for drift verification).',
              },
              proposedValue: {
                description: 'The new value to set.',
              },
              reason: {
                type: 'string',
                description: 'Why this change is being made.',
              },
              confidence: {
                type: 'string',
                enum: ['high', 'medium', 'low'],
                description: 'How confident the audit is in this change.',
              },
            },
            required: ['field', 'currentValue', 'proposedValue', 'reason', 'confidence'],
          },
          minItems: 1,
          maxItems: 50,
        },
        models: {
          type: 'array',
          description:
            'Array of models to update (multi-model mode). Each entry has model_id and changes.',
          items: {
            type: 'object',
            properties: {
              model_id: { type: 'string' },
              changes: { type: 'array', items: { type: 'object' } },
            },
            required: ['model_id', 'changes'],
          },
          minItems: 1,
          maxItems: 50,
        },
      },
    },
  };

  protected readonly schema = schema;

  async execute(args: Args, context: CapabilityContext): Promise<CapabilityResult<Data>> {
    // Normalise single-model and multi-model input into a uniform list
    const entries = 'models' in args ? args.models : [args];

    // Empty models array — nothing to apply (e.g. approval payload had no changes)
    if (entries.length === 0) {
      return this.success(
        { modelId: 'none', modelName: 'none', applied: 0, skipped: 0, invalid: 0, changes: [] },
        { skipFollowup: true }
      );
    }

    let totalApplied = 0;
    let totalSkipped = 0;
    let totalInvalid = 0;
    const allChanges: AppliedChange[] = [];
    let lastName = '';
    let lastId = '';

    for (const entry of entries) {
      const { applied, skipped, invalid, changes, modelName, modelId } =
        await this.applyModelChanges(entry.model_id, entry.changes, context);
      totalApplied += applied;
      totalSkipped += skipped;
      totalInvalid += invalid;
      allChanges.push(...changes);
      lastName = modelName;
      lastId = modelId;
    }

    return this.success(
      {
        modelId: entries.length === 1 ? lastId : `${entries.length} models`,
        modelName: entries.length === 1 ? lastName : `${entries.length} models`,
        applied: totalApplied,
        skipped: totalSkipped,
        invalid: totalInvalid,
        changes: allChanges,
      },
      { skipFollowup: true }
    );
  }

  private async applyModelChanges(
    modelId: string,
    changes: z.infer<typeof singleModelSchema>['changes'],
    context: CapabilityContext
  ): Promise<Data> {
    const model = await prisma.aiProviderModel.findUnique({
      where: { id: modelId },
    });

    if (!model) {
      logger.warn('Audit target model not found, skipping', { modelId });
      return {
        modelId,
        modelName: 'unknown',
        applied: 0,
        skipped: 0,
        invalid: changes.length,
        changes: changes.map((c) => ({
          field: c.field,
          previousValue: c.currentValue,
          newValue: c.proposedValue,
          status: 'invalid' as const,
          reason: `Provider model ${modelId} not found`,
        })),
      };
    }

    const results: AppliedChange[] = [];
    let applied = 0;
    let skipped = 0;
    let invalid = 0;

    for (const change of changes) {
      // Validate the proposed value against the update schema
      const partial = { [change.field]: change.proposedValue };
      const parsed = updateProviderModelSchema.safeParse(partial);

      if (!parsed.success) {
        results.push({
          field: change.field,
          previousValue: change.currentValue,
          newValue: change.proposedValue,
          status: 'invalid',
          reason: parsed.error.issues.map((i) => i.message).join('; '),
        });
        invalid++;
        continue;
      }

      // Use the Zod-parsed value, not the raw proposedValue
      const validatedValue = (parsed.data as Record<string, unknown>)[change.field];

      // Verify the current value matches what the audit saw
      const currentValue = (model as Record<string, unknown>)[change.field];
      if (JSON.stringify(currentValue) !== JSON.stringify(change.currentValue)) {
        results.push({
          field: change.field,
          previousValue: currentValue,
          newValue: change.proposedValue,
          status: 'skipped',
          reason: `Field value changed since audit (expected ${JSON.stringify(change.currentValue)}, found ${JSON.stringify(currentValue)})`,
        });
        skipped++;
        continue;
      }

      // Apply the change using the validated value
      try {
        await prisma.aiProviderModel.update({
          where: { id: modelId },
          data: {
            [change.field]: validatedValue,
          },
        });
        results.push({
          field: change.field,
          previousValue: change.currentValue,
          newValue: validatedValue,
          status: 'applied',
        });
        applied++;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        results.push({
          field: change.field,
          previousValue: change.currentValue,
          newValue: change.proposedValue,
          status: 'invalid',
          reason: `Database update failed: ${message}`,
        });
        invalid++;
      }
    }

    // Store audit metadata on the model for provenance tracking
    if (applied > 0) {
      const existingMetadata =
        model.metadata && typeof model.metadata === 'object' && !Array.isArray(model.metadata)
          ? (model.metadata as Record<string, unknown>)
          : {};
      await prisma.aiProviderModel.update({
        where: { id: modelId },
        data: {
          // Opt out of future seed updates since admin approved changes
          isDefault: false,
          metadata: {
            ...existingMetadata,
            lastAudit: {
              timestamp: new Date().toISOString(),
              agentId: context.agentId,
              changesApplied: applied,
              changesSkipped: skipped,
              changesInvalid: invalid,
            },
          },
        },
      });

      invalidateModelCache();
    }

    logger.info('Audit changes applied', {
      modelId,
      modelName: model.name,
      applied,
      skipped,
      invalid,
    });

    return {
      modelId,
      modelName: model.name,
      applied,
      skipped,
      invalid,
      changes: results,
    };
  }
}
