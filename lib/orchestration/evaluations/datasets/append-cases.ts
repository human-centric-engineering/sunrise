/**
 * Append cases to an existing dataset.
 *
 * Used by:
 *   - `capture.ts` — converts prod conversation turns + workflow outputs
 *     into dataset cases.
 *   - `synthesis/case-generator.ts` (Phase 2.3) — writes accepted
 *     synthetic cases.
 *
 * The original `uploadDataset` helper creates a new `AiDataset` row with
 * its full case array in one transaction. This helper is the inverse:
 * given a dataset that already exists, write N new cases at the next
 * available positions and recompute the dataset's `contentHash` from
 * the new full case array so downstream hash-pin checks (in the eval
 * worker) still match.
 *
 * Caller is responsible for ownership: pass a `datasetId` you've
 * already authenticated via `findFirst({ userId })`. This helper does
 * not re-authenticate.
 */

import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { ValidationError } from '@/lib/api/errors';
import {
  datasetCaseSchema,
  MAX_CASES,
} from '@/lib/orchestration/evaluations/datasets/upload-handler';
import { hashDatasetCases } from '@/lib/orchestration/evaluations/datasets/hash';

export interface AppendCaseInput {
  input: string | Record<string, unknown>;
  expectedOutput?: string;
  metadata?: Record<string, unknown>;
  referenceCitations?: unknown[];
}

export interface AppendCasesResult {
  datasetId: string;
  appendedCount: number;
  newCaseCount: number;
  newContentHash: string;
}

/**
 * Validate + transactionally append cases. Throws `ValidationError` if
 * any case fails the schema check or the resulting case count would
 * exceed the per-dataset cap.
 *
 * `source` is the new value to stamp onto `AiDataset.source` —
 * `'conversation_capture'` from the capture API's conversation-turn
 * branch, `'workflow_capture'` from its workflow-execution branch,
 * `'synthetic'` from the synthesis API. Existing rows that were
 * already on that source are unaffected; an upload-source dataset
 * receiving its first captured case will flip to the new source so the
 * UI can label provenance accurately. Pass `null` to preserve.
 */
export async function appendCasesToDataset(params: {
  datasetId: string;
  cases: AppendCaseInput[];
  source?: 'conversation_capture' | 'workflow_capture' | 'synthetic' | null;
}): Promise<AppendCasesResult> {
  const validated = params.cases.map((c, i) => {
    const r = datasetCaseSchema.safeParse(c);
    if (!r.success) {
      throw new ValidationError(
        `Case at position ${i} is invalid: ${r.error.issues.map((iss) => iss.message).join('; ')}`
      );
    }
    return r.data;
  });

  if (validated.length === 0) {
    throw new ValidationError('At least one case is required');
  }

  const result = await prisma.$transaction(async (tx) => {
    const dataset = await tx.aiDataset.findUnique({
      where: { id: params.datasetId },
      select: { id: true, caseCount: true, source: true },
    });
    if (!dataset) {
      throw new ValidationError(`Dataset ${params.datasetId} not found`);
    }
    const nextCaseCount = dataset.caseCount + validated.length;
    if (nextCaseCount > MAX_CASES) {
      throw new ValidationError(
        `Dataset would exceed ${MAX_CASES}-case cap (${dataset.caseCount} existing + ${validated.length} new)`
      );
    }

    // Append rows at the next contiguous positions. Position is unique
    // per (datasetId, position) — relying on the existing row count is
    // safe inside the transaction.
    await tx.aiDatasetCase.createMany({
      data: validated.map((c, i) => ({
        datasetId: dataset.id,
        position: dataset.caseCount + i,
        input: c.input as Prisma.InputJsonValue,
        expectedOutput: c.expectedOutput ?? null,
        metadata: c.metadata !== undefined ? (c.metadata as Prisma.InputJsonValue) : Prisma.DbNull,
        referenceCitations:
          c.referenceCitations !== undefined
            ? (c.referenceCitations as Prisma.InputJsonValue)
            : Prisma.DbNull,
      })),
    });

    // Recompute the content hash over the full new case array. The
    // worker's hash-pin check expects this; an out-of-date hash would
    // make every queued run fail with `dataset_changed_post_submit`.
    const allCases = await tx.aiDatasetCase.findMany({
      where: { datasetId: dataset.id },
      orderBy: { position: 'asc' },
      select: {
        position: true,
        input: true,
        expectedOutput: true,
        metadata: true,
        referenceCitations: true,
      },
    });
    const newContentHash = hashDatasetCases(
      allCases.map((c) => ({
        position: c.position,
        input: c.input as unknown,
        expectedOutput: c.expectedOutput,
        metadata: c.metadata as unknown,
        referenceCitations: c.referenceCitations as unknown,
      }))
    );

    const updateData: Prisma.AiDatasetUpdateInput = {
      caseCount: nextCaseCount,
      contentHash: newContentHash,
    };
    // Only flip source when the caller asked AND the dataset isn't
    // already labelled that way. Preserves explicit provenance on
    // datasets that have been captured-into multiple times.
    if (params.source && dataset.source !== params.source) {
      updateData.source = params.source;
    }
    await tx.aiDataset.update({
      where: { id: dataset.id },
      data: updateData,
    });

    return {
      datasetId: dataset.id,
      appendedCount: validated.length,
      newCaseCount: nextCaseCount,
      newContentHash,
    };
  });

  logger.info('Dataset cases appended', {
    datasetId: result.datasetId,
    appendedCount: result.appendedCount,
    newCaseCount: result.newCaseCount,
    source: params.source,
  });

  return result;
}
