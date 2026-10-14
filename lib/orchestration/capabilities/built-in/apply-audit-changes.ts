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
import {
  isHalfPrice,
  numericStringToNumber,
  PRICE_FIELDS,
  PRICE_PAIR_MESSAGE,
  touchesPricesAsPair,
} from '@/lib/validations/model-pricing';
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
  // Chat pricing (t-774). Applied only as a pair; a price proposal must
  // cite a source with a reference (`audit-proposals` schema).
  'inputCostPerMillionTokens',
  'outputCostPerMillionTokens',
] as const;

/**
 * Auditable fields whose values are numbers. The approval screen edits a
 * proposed value as text, so an admin's modified `"3.5"` arrives as a
 * string; it is read as the number it spells before validation.
 */
const NUMERIC_AUDIT_FIELDS: ReadonlySet<string> = new Set([...PRICE_FIELDS, 'dimensions']);

function coerceNumeric(field: string, value: unknown): unknown {
  return NUMERIC_AUDIT_FIELDS.has(field) ? numericStringToNumber(value) : value;
}

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
  readonly processesPii = false;
  /** Provider models are shared settings: refused outside the install org at `multi` (§107 t-751). */
  readonly writesSharedSettings = true;

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

    const record = (outcome: AppliedChange[]): void => {
      results.push(...outcome);
      for (const r of outcome) {
        if (r.status === 'applied') applied++;
        else if (r.status === 'skipped') skipped++;
        else invalid++;
      }
    };

    // Each change is its own unit, except the two prices, which apply
    // together or not at all (t-774): half a price records the other half
    // of every turn at $0. An admin who accepts one and rejects the other
    // gets neither.
    const priceChanges = changes.filter((c) => PRICE_FIELDS.has(c.field));
    const units: Array<typeof changes> = changes
      .filter((c) => !PRICE_FIELDS.has(c.field))
      .map((c) => [c]);
    if (priceChanges.length > 0) {
      if (touchesPricesAsPair(priceChanges.map((c) => c.field))) {
        units.push(priceChanges);
      } else {
        record(
          priceChanges.map((c) => ({
            field: c.field,
            previousValue: c.currentValue,
            newValue: c.proposedValue,
            status: 'invalid' as const,
            reason:
              'Input and output prices apply as a pair: accept both, or neither, exactly once each',
          }))
        );
      }
    }

    for (const unit of units) {
      const outcome = await this.applyUnit(modelId, unit, (fresh) => {
        if (capturedName === undefined) {
          capturedName = fresh.name;
          capturedMetadata = fresh.metadata;
        }
      });
      record(outcome);
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
  /**
   * Validate and apply a set of changes as one unit: all are checked for
   * drift and written in a single serializable transaction, or none are.
   *
   * Atomic check-then-update: the previous implementation read the model
   * once and compared against that cached snapshot before writing — a
   * TOCTOU window in which a concurrent admin edit could be silently
   * overwritten. Re-reading inside a serializable transaction collapses
   * the gap to zero.
   */
  private async applyUnit(
    modelId: string,
    unit: z.infer<typeof singleModelSchema>['changes'],
    onFound: (fresh: { name: string; metadata: unknown }) => void
  ): Promise<AppliedChange[]> {
    // Validate every proposed value against the update schema first.
    const validated: Array<{ change: (typeof unit)[number]; value: unknown }> = [];
    const invalidResults: AppliedChange[] = [];
    for (const change of unit) {
      const proposed = coerceNumeric(change.field, change.proposedValue);
      const parsed = updateProviderModelSchema.safeParse({ [change.field]: proposed });
      if (!parsed.success) {
        invalidResults.push({
          field: change.field,
          previousValue: change.currentValue,
          newValue: change.proposedValue,
          status: 'invalid',
          reason: parsed.error.issues.map((i) => i.message).join('; '),
        });
        continue;
      }
      // Use the Zod-parsed value, not the raw proposedValue
      validated.push({
        change,
        value: (parsed.data as Record<string, unknown>)[change.field],
      });
    }
    if (invalidResults.length > 0) {
      // One invalid value sinks the unit; its partners are reported too.
      return [
        ...invalidResults,
        ...validated.map(({ change }) => ({
          field: change.field,
          previousValue: change.currentValue,
          newValue: change.proposedValue,
          status: 'invalid' as const,
          reason: 'Not applied: its paired change is invalid',
        })),
      ];
    }

    // A price pair must leave both set or both cleared: one number beside a
    // `null` is half a price, which the update schema accepts field by field
    // and the database refuses (`ai_provider_model_price_pair`).
    const prices = validated.filter(({ change }) => PRICE_FIELDS.has(change.field));
    if (prices.length === 2 && isHalfPrice(prices[0].value, prices[1].value)) {
      return prices.map(({ change }) => ({
        field: change.field,
        previousValue: change.currentValue,
        newValue: change.proposedValue,
        status: 'invalid' as const,
        reason: PRICE_PAIR_MESSAGE,
      }));
    }

    let outcome: 'applied' | 'drift' | 'missing' | 'error';
    const drift: Record<string, unknown> = {};
    let updateError: string | null = null;
    try {
      outcome = await prisma.$transaction(
        async (tx) => {
          const fresh = await tx.aiProviderModel.findUnique({ where: { id: modelId } });
          if (!fresh) return 'missing' as const;
          onFound(fresh);
          for (const { change } of validated) {
            const current = (fresh as Record<string, unknown>)[change.field];
            // A model may write a numeric currentValue as a string ("3");
            // read it the way the proposed value is read, so a match is not
            // mistaken for drift.
            const expected = coerceNumeric(change.field, change.currentValue);
            if (!valuesEqual(current, expected)) drift[change.field] = current;
          }
          if (Object.keys(drift).length > 0) return 'drift' as const;
          await tx.aiProviderModel.update({
            where: { id: modelId },
            data: Object.fromEntries(validated.map(({ change, value }) => [change.field, value])),
          });
          return 'applied' as const;
        },
        { isolationLevel: 'Serializable' }
      );
    } catch (err) {
      updateError = err instanceof Error ? err.message : 'Unknown error';
      outcome = 'error';
    }

    return validated.map(({ change, value }): AppliedChange => {
      switch (outcome) {
        case 'applied':
          return {
            field: change.field,
            previousValue: change.currentValue,
            newValue: value,
            status: 'applied',
          };
        case 'drift':
          return change.field in drift
            ? {
                field: change.field,
                previousValue: drift[change.field],
                newValue: change.proposedValue,
                status: 'skipped',
                reason: `Field value changed since audit (expected ${JSON.stringify(change.currentValue)}, found ${JSON.stringify(drift[change.field])})`,
              }
            : {
                field: change.field,
                previousValue: change.currentValue,
                newValue: change.proposedValue,
                status: 'skipped',
                reason: 'Not applied: its paired field changed since audit',
              };
        case 'missing':
          return {
            field: change.field,
            previousValue: change.currentValue,
            newValue: change.proposedValue,
            status: 'invalid',
            reason: `Provider model ${modelId} no longer exists`,
          };
        case 'error':
          return {
            field: change.field,
            previousValue: change.currentValue,
            newValue: change.proposedValue,
            status: 'invalid',
            reason: `Database update failed: ${updateError ?? 'unknown'}`,
          };
      }
    });
  }
}
