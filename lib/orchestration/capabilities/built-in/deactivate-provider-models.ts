/**
 * Deactivate Provider Models capability
 *
 * Takes models out of the active registry, and records a vendor's retirement
 * of them (§136 t-1064). Used by the Provider Model Audit workflow after its
 * `human_approval` step, receiving admin-approved deactivation proposals.
 *
 * An entry WITHOUT `retiresAt` behaves as it always has: `isActive = false`,
 * skipped when already inactive.
 *
 * An entry WITH `retiresAt` (the day the vendor stops serving the model)
 * records the retirement, and optionally its successor (`replacedBy`, the
 * vendor's model id on the same provider):
 *
 * - a day still to come marks the model **retiring** and leaves it active.
 *   Deactivating it now would drop it from the model registry while agents
 *   still call it, so it stays on until the move (t-1066) or the day comes;
 * - a day already here marks it **retired** and deactivates it.
 *
 * The successor is looked up by vendor model id because it is often one this
 * same audit run has just added (`add_new_models` runs first), which has no
 * row id the analysing model could have seen. A successor that fails
 * `checkReplacement` is not stored; the retirement still is, and the result
 * says why the successor was left out.
 *
 * Every write is recorded in the admin audit log, with the fields it changed.
 */

import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { invalidateModelCache } from '@/lib/orchestration/llm/provider-selector';
import { BaseCapability } from '@/lib/orchestration/capabilities/base-capability';
import { unwrapApprovalPayload } from '@/lib/orchestration/capabilities/approval-payload-unwrap';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { isEmbedUserId } from '@/lib/embed/auth';
import {
  checkReplacement,
  modelLifecycleState,
  parseRetirementDate,
} from '@/lib/orchestration/model-lifecycle/state';
import { findReplacementByModelId } from '@/lib/orchestration/model-lifecycle/replacement';
import type {
  CapabilityContext,
  CapabilityFunctionDefinition,
  CapabilityResult,
} from '@/lib/orchestration/capabilities/types';

function emptyAsNull(value: unknown): unknown {
  return typeof value === 'string' && value.trim() === '' ? null : value;
}

const deactivateEntrySchema = z.object({
  modelId: z.string().min(1).max(100),
  reason: z.string().min(1).max(1000),
  // `null` or `""` is the analysing model saying it found no date or
  // successor — the same as leaving the field out.
  retiresAt: z.preprocess(emptyAsNull, z.string().max(20).nullish()),
  replacedBy: z.preprocess(emptyAsNull, z.string().max(100).nullish()),
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
type Entry = z.infer<typeof deactivateEntrySchema>;

interface DeactivatedModel {
  modelId: string;
  name: string;
  /**
   * `deactivated` — taken out of the registry (no retirement date given);
   * `retiring` — retirement recorded for a day still to come; `isActive` is
   *   left as it was (on, unless an admin had already turned the model off);
   * `retired` — retirement recorded for a day already here, and inactive;
   * `skipped` — nothing to change; `invalid` — not applied.
   */
  status: 'deactivated' | 'retiring' | 'retired' | 'skipped' | 'invalid';
  reason?: string;
  /** Why the proposed successor was not stored, when one was proposed and refused. */
  replacementNote?: string;
}

interface Data {
  deactivated: number;
  retiring: number;
  retired: number;
  skipped: number;
  invalid: number;
  models: DeactivatedModel[];
}

const MODEL_SELECT = {
  id: true,
  name: true,
  providerSlug: true,
  capabilities: true,
  isActive: true,
  retiresAt: true,
  replacementId: true,
  metadata: true,
} as const;

type ModelRow = Prisma.AiProviderModelGetPayload<{ select: typeof MODEL_SELECT }>;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export class DeactivateProviderModelsCapability extends BaseCapability<Args, Data> {
  readonly slug = 'deactivate_provider_models';
  readonly processesPii = false;
  /** Provider models are shared settings: refused outside the install org at `multi` (§107 t-751). */
  readonly writesSharedSettings = true;

  readonly functionDefinition: CapabilityFunctionDefinition = {
    name: 'deactivate_provider_models',
    description:
      'Deactivate provider model entries that have been deprecated or discontinued, and record a vendor retirement date and same-provider successor where known. A retirement date still to come marks the model retiring and leaves it active; one already here deactivates it. Already-inactive models without a new retirement are skipped.',
    parameters: {
      type: 'object',
      properties: {
        deactivateModels: {
          type: 'array',
          description: 'Array of models to deactivate or mark as retiring.',
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
              retiresAt: {
                type: 'string',
                description:
                  'The day the vendor stops serving the model, as YYYY-MM-DD, when the vendor has announced one.',
              },
              replacedBy: {
                type: 'string',
                description:
                  'The vendor\'s model id of the successor on the same provider (e.g. "gpt-5.1"), when the vendor names one.',
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
    const counts: Data = {
      deactivated: 0,
      retiring: 0,
      retired: 0,
      skipped: 0,
      invalid: 0,
      models: [],
    };

    // Empty array — nothing to deactivate (e.g. approval payload had no deactivations)
    if (args.deactivateModels.length === 0) {
      return this.success(counts, { skipFollowup: true });
    }

    // Models this same batch records as retiring or retired. Entries apply in
    // order, so without this a successor named early could be retired by a
    // later entry, leaving its predecessor pointing at a model going away.
    const retiringInBatch = new Set(
      args.deactivateModels
        .filter((e) => e.retiresAt != null && parseRetirementDate(e.retiresAt) !== null)
        .map((e) => e.modelId)
    );

    for (const entry of args.deactivateModels) {
      const result = await this.applyEntry(entry, context, retiringInBatch);
      counts[result.status]++;
      counts.models.push(result);
    }

    if (counts.deactivated + counts.retiring + counts.retired > 0) {
      invalidateModelCache();
    }

    return this.success(counts, { skipFollowup: true });
  }

  private async applyEntry(
    entry: Entry,
    context: CapabilityContext,
    retiringInBatch: ReadonlySet<string>
  ): Promise<DeactivatedModel> {
    const model = await prisma.aiProviderModel.findUnique({
      where: { id: entry.modelId },
      select: MODEL_SELECT,
    });

    if (!model) {
      logger.warn('Audit: deactivation target not found', { modelId: entry.modelId });
      return {
        modelId: entry.modelId,
        name: 'unknown',
        status: 'invalid',
        reason: `Provider model ${entry.modelId} not found`,
      };
    }

    if (entry.retiresAt == null) return this.deactivate(model, entry, context);

    const retiresAt = parseRetirementDate(entry.retiresAt);
    if (retiresAt === null) {
      return {
        modelId: model.id,
        name: model.name,
        status: 'invalid',
        reason: `Retirement date "${entry.retiresAt}" is not a day as YYYY-MM-DD`,
      };
    }
    return this.retire(model, entry, retiresAt, context, retiringInBatch);
  }

  /** No retirement date: take the model out of the registry, as before §136. */
  private async deactivate(
    model: ModelRow,
    entry: Entry,
    context: CapabilityContext
  ): Promise<DeactivatedModel> {
    // A successor is recorded with a retirement; without a day it is left out.
    const replacementNote =
      entry.replacedBy != null
        ? `Successor "${entry.replacedBy}" not recorded: it needs a retirement date`
        : undefined;

    if (!model.isActive) {
      logger.info('Audit: model already inactive, skipping deactivation', {
        modelId: model.id,
        name: model.name,
      });
      return {
        modelId: model.id,
        name: model.name,
        status: 'skipped',
        reason: 'Model is already inactive',
        ...(replacementNote ? { replacementNote } : {}),
      };
    }
    const written = await this.write(
      model,
      entry,
      context,
      { isActive: false },
      'provider_model.deactivate',
      { replacementNote }
    );
    return (
      written ?? {
        modelId: model.id,
        name: model.name,
        status: 'deactivated',
        ...(replacementNote ? { replacementNote } : {}),
      }
    );
  }

  /** A retirement date: record it and its successor; deactivate once the day is here. */
  private async retire(
    model: ModelRow,
    entry: Entry,
    retiresAt: Date,
    context: CapabilityContext,
    retiringInBatch: ReadonlySet<string>
  ): Promise<DeactivatedModel> {
    let replacementId = model.replacementId;
    let replacementNote: string | undefined;
    if (entry.replacedBy != null) {
      const resolved = await this.resolveSuccessor(model, entry.replacedBy, retiringInBatch);
      if (resolved.id !== null) replacementId = resolved.id;
      else replacementNote = `Successor not recorded: ${resolved.refusal}`;
    }

    const retired = modelLifecycleState({ retiresAt }) === 'retired';
    const change: { retiresAt?: Date; replacementId?: string | null; isActive?: boolean } = {};
    if (model.retiresAt?.getTime() !== retiresAt.getTime()) change.retiresAt = retiresAt;
    if (replacementId !== model.replacementId) change.replacementId = replacementId;
    if (retired && model.isActive) change.isActive = false;
    const status = retired ? 'retired' : 'retiring';

    if (Object.keys(change).length === 0) {
      return {
        modelId: model.id,
        name: model.name,
        status: 'skipped',
        reason: `Already recorded as ${status} on ${retiresAt.toISOString().slice(0, 10)}`,
        ...(replacementNote ? { replacementNote } : {}),
      };
    }

    const written = await this.write(model, entry, context, change, 'provider_model.retire', {
      replacementNote,
    });
    return (
      written ?? {
        modelId: model.id,
        name: model.name,
        status,
        ...(replacementNote ? { replacementNote } : {}),
      }
    );
  }

  /**
   * The successor's row id, or why it cannot be one. A failed lookup is a
   * refusal for this entry, not a throw: the retirement is still recorded and
   * the rest of the batch still applies.
   */
  private async resolveSuccessor(
    model: ModelRow,
    replacedBy: string,
    retiringInBatch: ReadonlySet<string>
  ): Promise<{ id: string; refusal?: undefined } | { id: null; refusal: string }> {
    let candidate;
    try {
      candidate = await findReplacementByModelId(model.providerSlug, replacedBy);
    } catch (err) {
      logger.error('Audit: successor lookup failed', {
        modelId: model.id,
        replacedBy,
        error: err instanceof Error ? err.message : String(err),
      });
      return { id: null, refusal: `the lookup of "${replacedBy}" failed` };
    }
    if (!candidate) {
      return { id: null, refusal: `"${replacedBy}" is not in the ${model.providerSlug} catalogue` };
    }
    if (retiringInBatch.has(candidate.id)) {
      return { id: null, refusal: `"${candidate.name}" is itself being retired in this audit` };
    }
    const refusal = checkReplacement(model, candidate);
    return refusal === null ? { id: candidate.id } : { id: null, refusal };
  }

  /**
   * Write `change` to the model and record it in the admin audit log. Returns
   * an `invalid` result when the write fails, `null` when it succeeded.
   */
  private async write(
    model: ModelRow,
    entry: Entry,
    context: CapabilityContext,
    change: { retiresAt?: Date; replacementId?: string | null; isActive?: boolean },
    action: 'provider_model.deactivate' | 'provider_model.retire',
    extra: { replacementNote?: string } = {}
  ): Promise<DeactivatedModel | null> {
    const stamp = {
      timestamp: new Date().toISOString(),
      agentId: context.agentId,
      reason: entry.reason,
    };
    try {
      await prisma.aiProviderModel.update({
        where: { id: model.id },
        data: {
          ...change,
          // The deactivation stamp predates §136 and readers may rely on it;
          // it is written whenever this capability takes a model offline.
          ...(change.isActive === false
            ? { metadata: { ...asRecord(model.metadata), deactivatedByAudit: stamp } }
            : {}),
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      logger.error('Audit: failed to write provider model lifecycle', {
        modelId: model.id,
        action,
        error: message,
      });
      return { modelId: model.id, name: model.name, status: 'invalid', reason: message };
    }

    const before: Record<string, unknown> = {
      retiresAt: model.retiresAt,
      replacementId: model.replacementId,
      isActive: model.isActive,
    };
    logAdminAction({
      // An embed visitor is not a User row; its id would fail the audit row's
      // foreign key and the row would be lost.
      userId: isEmbedUserId(context.userId) ? null : context.userId,
      action,
      entityType: 'provider_model',
      entityId: model.id,
      entityName: model.name,
      changes: Object.fromEntries(
        Object.entries(change).map(([field, to]) => [field, { from: before[field], to }])
      ),
      metadata: {
        source: 'model_audit',
        reason: entry.reason,
        ...(context.workflowExecutionId
          ? { workflowExecutionId: context.workflowExecutionId }
          : {}),
        ...(extra.replacementNote ? { replacementNote: extra.replacementNote } : {}),
      },
    });

    logger.info('Audit: provider model lifecycle written', {
      modelId: model.id,
      name: model.name,
      action,
      fields: Object.keys(change),
      agentId: context.agentId,
    });
    return null;
  }
}
