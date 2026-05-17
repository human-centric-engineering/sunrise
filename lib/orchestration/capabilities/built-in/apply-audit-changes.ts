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

/**
 * Compare an auditable field's current value against the value the
 * audit observed. Most AUDITABLE_FIELDS are scalar (string / number /
 * boolean) and JSON.stringify equality is sound. `deploymentProfiles`
 * is `String[]` (Postgres) and the LLM has no obligation to emit
 * elements in a fixed order, so we treat arrays as sets — sort the
 * stringified elements before comparing so `['hosted','sovereign']`
 * matches `['sovereign','hosted']` instead of producing a spurious
 * "Field value changed since audit" skip.
 */
function valuesEqual(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    const sortedA = a.map((v) => JSON.stringify(v)).sort();
    const sortedB = b.map((v) => JSON.stringify(v)).sort();
    return sortedA.every((v, i) => v === sortedB[i]);
  }
  return JSON.stringify(a) === JSON.stringify(b);
}

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
    const results: AppliedChange[] = [];
    let applied = 0;
    let skipped = 0;
    let invalid = 0;

    // Captured from the first transaction that finds the row, used
    // for the post-loop metadata update and the audit log line. Stays
    // undefined if every iteration finds the model missing — in which
    // case `applied === 0` and the metadata write is skipped anyway.
    let capturedName: string | undefined = undefined;
    let capturedMetadata: unknown = undefined;

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

      // Atomic check-then-update inside a serializable transaction.
      // The previous implementation read the model once at the top of
      // the function and compared against that cached snapshot before
      // writing — a TOCTOU window in which a concurrent admin edit
      // could be silently overwritten (the cached snapshot still
      // matched the audit's expected value, the drift check passed,
      // and the write clobbered the operator's change without
      // surfacing it in `results`). Re-reading inside a serializable
      // transaction collapses the gap to zero.
      let outcome: 'applied' | 'drift' | 'missing' | 'error';
      let driftActualValue: unknown = undefined;
      let updateError: string | null = null;
      try {
        outcome = await prisma.$transaction(
          async (tx) => {
            const fresh = await tx.aiProviderModel.findUnique({ where: { id: modelId } });
            if (!fresh) return 'missing' as const;
            if (capturedName === undefined) {
              capturedName = fresh.name;
              capturedMetadata = fresh.metadata;
            }
            const current = (fresh as Record<string, unknown>)[change.field];
            if (!valuesEqual(current, change.currentValue)) {
              driftActualValue = current;
              return 'drift' as const;
            }
            await tx.aiProviderModel.update({
              where: { id: modelId },
              data: {
                [change.field]: validatedValue,
              },
            });
            return 'applied' as const;
          },
          { isolationLevel: 'Serializable' }
        );
      } catch (err) {
        updateError = err instanceof Error ? err.message : 'Unknown error';
        outcome = 'error';
      }

      switch (outcome) {
        case 'applied':
          results.push({
            field: change.field,
            previousValue: change.currentValue,
            newValue: validatedValue,
            status: 'applied',
          });
          applied++;
          break;
        case 'drift':
          results.push({
            field: change.field,
            previousValue: driftActualValue,
            newValue: change.proposedValue,
            status: 'skipped',
            reason: `Field value changed since audit (expected ${JSON.stringify(change.currentValue)}, found ${JSON.stringify(driftActualValue)})`,
          });
          skipped++;
          break;
        case 'missing':
          results.push({
            field: change.field,
            previousValue: change.currentValue,
            newValue: change.proposedValue,
            status: 'invalid',
            reason: `Provider model ${modelId} no longer exists`,
          });
          invalid++;
          break;
        case 'error':
          results.push({
            field: change.field,
            previousValue: change.currentValue,
            newValue: change.proposedValue,
            status: 'invalid',
            reason: `Database update failed: ${updateError ?? 'unknown'}`,
          });
          invalid++;
          break;
      }
    }

    const modelName = capturedName ?? 'unknown';

    // Store audit metadata on the model for provenance tracking. We
    // reuse the metadata snapshot captured during the first successful
    // transaction read — it's only stale w.r.t. fields *not* in the
    // metadata blob (admin-edited auditable fields), so the merge here
    // doesn't risk clobbering admin-supplied metadata.
    if (applied > 0) {
      const existingMetadata =
        capturedMetadata && typeof capturedMetadata === 'object' && !Array.isArray(capturedMetadata)
          ? (capturedMetadata as Record<string, unknown>)
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

    if (capturedName === undefined) {
      logger.warn('Audit target model not found, all changes invalid', { modelId });
    }
    logger.info('Audit changes applied', {
      modelId,
      modelName,
      applied,
      skipped,
      invalid,
    });

    return {
      modelId,
      modelName,
      applied,
      skipped,
      invalid,
      changes: results,
    };
  }
}
