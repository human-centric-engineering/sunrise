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
import type {
  CapabilityContext,
  CapabilityFunctionDefinition,
  CapabilityResult,
} from '@/lib/orchestration/capabilities/types';

/** A single field change the LLM proposed and the admin accepted */
const auditChangeSchema = z.object({
  field: z.string().min(1).max(100),
  currentValue: z.unknown(),
  proposedValue: z.unknown(),
  reason: z.string().min(1).max(1000),
  confidence: z.enum(['high', 'medium', 'low']),
});

const schema = z.object({
  model_id: z.string().min(1).max(100),
  changes: z.array(auditChangeSchema).min(1).max(50),
});

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
      'Apply approved audit changes to a provider model entry. Each change updates a single field after validating it against the model update schema. Invalidates the model cache after all updates.',
    parameters: {
      type: 'object',
      properties: {
        model_id: {
          type: 'string',
          description: 'The ID of the provider model to update.',
          minLength: 1,
          maxLength: 100,
        },
        changes: {
          type: 'array',
          description: 'Array of approved field changes to apply.',
          items: {
            type: 'object',
            properties: {
              field: {
                type: 'string',
                description: 'The field name to update (e.g. "tierRole", "costEfficiency").',
              },
              currentValue: {
                description: 'The current value of the field (for verification).',
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
      },
      required: ['model_id', 'changes'],
    },
  };

  protected readonly schema = schema;

  async execute(args: Args, context: CapabilityContext): Promise<CapabilityResult<Data>> {
    const model = await prisma.aiProviderModel.findUnique({
      where: { id: args.model_id },
    });

    if (!model) {
      return this.error(`Provider model ${args.model_id} not found`, 'not_found');
    }

    const results: AppliedChange[] = [];
    let applied = 0;
    let skipped = 0;
    let invalid = 0;

    for (const change of args.changes) {
      // Validate the proposed change against the update schema
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

      // Apply the change
      try {
        await prisma.aiProviderModel.update({
          where: { id: args.model_id },
          data: {
            [change.field]: change.proposedValue,
            // Opt out of future seed updates since admin approved a change
            isDefault: false,
          },
        });
        results.push({
          field: change.field,
          previousValue: change.currentValue,
          newValue: change.proposedValue,
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
        where: { id: args.model_id },
        data: {
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
      modelId: args.model_id,
      modelName: model.name,
      applied,
      skipped,
      invalid,
    });

    return this.success(
      {
        modelId: args.model_id,
        modelName: model.name,
        applied,
        skipped,
        invalid,
        changes: results,
      },
      { skipFollowup: true }
    );
  }
}
