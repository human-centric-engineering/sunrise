import type { Prisma } from '@prisma/client';

import { BUILTIN_WORKFLOW_TEMPLATES } from '@/prisma/seeds/data/templates';
import type { SeedUnit } from '@/prisma/runner';
import { serviceAccountWhere } from '@/lib/auth/account';
import type { WorkflowDefinition, WorkflowStep } from '@/types/orchestration';

/**
 * Backfill `WorkflowStep.description` on existing built-in template
 * snapshots.
 *
 * The original `004-builtin-templates.ts` seed only writes a fresh v1
 * snapshot on first creation — on re-seed it leaves the published
 * snapshot alone (intentional: workflow versions are immutable and
 * executions pin to versionId). So when we added the `description`
 * field, fresh installs picked it up but pre-existing dev DBs did not.
 *
 * This unit fills that gap without `db:reset`:
 *   1. For each built-in template, find the AiWorkflow row by slug.
 *   2. Read the published version's snapshot.
 *   3. For each step in the snapshot: if it's missing a `description`
 *      AND the seed-source step with the same `id` has one, set it.
 *      Never overwrite an existing description; never touch other
 *      step fields. Admin edits to prompts / configs are preserved.
 *   4. If any step got a description, publish a NEW version with the
 *      patched snapshot and flip `publishedVersionId`. The old version
 *      stays put — executions pinned to it keep working.
 *
 * Idempotent: a re-run finds nothing to fill and writes nothing.
 * The seed runner's `contentHash` will also short-circuit re-imports
 * when the unit + its hashInputs are unchanged.
 */

const SEED_USER_QUERY = { where: serviceAccountWhere, select: { id: true } };

interface SnapshotLike {
  steps: WorkflowStep[];
  entryStepId: string;
  errorStrategy: WorkflowDefinition['errorStrategy'];
}

interface MergeResult {
  /** The patched snapshot. Always returned even when nothing changed. */
  snapshot: SnapshotLike;
  /** Number of steps that received a new description. */
  filledCount: number;
}

/**
 * Walk `existing.steps` and, for each step whose `description` is
 * absent (or empty), set it from the seed-source step with the same
 * `id`. Pure function so the merge logic is unit-testable without a
 * DB.
 */
export function mergeDescriptionsIntoSnapshot(
  existing: SnapshotLike,
  source: WorkflowDefinition
): MergeResult {
  const sourceById = new Map<string, WorkflowStep>(source.steps.map((s) => [s.id, s]));
  let filledCount = 0;
  const patchedSteps = existing.steps.map((step) => {
    const sourceStep = sourceById.get(step.id);
    // Only fill: source must have a description AND existing must not.
    // Empty strings count as "missing" so a previous round of {description:''}
    // doesn't block the backfill.
    const existingHas = typeof step.description === 'string' && step.description.trim().length > 0;
    const sourceHas =
      typeof sourceStep?.description === 'string' && sourceStep.description.trim().length > 0;
    if (sourceHas && !existingHas) {
      filledCount += 1;
      return { ...step, description: sourceStep.description };
    }
    return step;
  });
  return {
    snapshot: { ...existing, steps: patchedSteps },
    filledCount,
  };
}

const unit: SeedUnit = {
  name: '005-backfill-step-descriptions',
  hashInputs: [
    // Re-run when any template's source text changes, so newly added
    // descriptions land on the next `db:seed` without `db:reset`.
    './data/templates/index.ts',
    './data/templates/types.ts',
    './data/templates/code-review.ts',
    './data/templates/content-pipeline.ts',
    './data/templates/conversational-learning.ts',
    './data/templates/customer-support.ts',
    './data/templates/data-pipeline.ts',
    './data/templates/outreach-safety.ts',
    './data/templates/research-agent.ts',
    './data/templates/saas-backend.ts',
    './data/templates/autonomous-research.ts',
    './data/templates/cited-knowledge-advisor.ts',
    './data/templates/scheduled-source-monitor.ts',
    './data/templates/provider-model-audit.ts',
  ],
  async run({ prisma, logger }) {
    logger.info('🩹 Backfilling step descriptions on built-in templates...');

    const admin = await prisma.user.findFirst(SEED_USER_QUERY);
    if (!admin) {
      // 004-builtin-templates would have failed first if there were no admin,
      // so the only way to land here is a hand-deleted user row. Bail loudly
      // rather than silently no-op.
      throw new Error('No admin user found — ensure 001-system-owner runs first.');
    }
    const createdBy = admin.id;

    let templatesUpdated = 0;
    let templatesSkippedNoRow = 0;
    let templatesSkippedNoPublished = 0;
    let templatesSkippedAlreadyFilled = 0;

    for (const template of BUILTIN_WORKFLOW_TEMPLATES) {
      const workflow = await prisma.aiWorkflow.findUnique({
        where: { slug: template.slug },
        select: {
          id: true,
          name: true,
          publishedVersionId: true,
          publishedVersion: { select: { id: true, version: true, snapshot: true } },
        },
      });

      if (!workflow) {
        // First-time seed hasn't created this template yet — 004 will land
        // it with descriptions already in v1. Nothing for us to do.
        templatesSkippedNoRow += 1;
        continue;
      }

      if (!workflow.publishedVersion) {
        // Drafted-but-never-published or somehow orphaned. Don't try to
        // guess — leave it for the admin to publish manually.
        logger.warn(`  ⚠  ${template.slug} has no published version — skipping backfill.`);
        templatesSkippedNoPublished += 1;
        continue;
      }

      // The snapshot is `Json`. We treat it as a loose `SnapshotLike` —
      // the merge function only touches `description` per step and is
      // safe against extra fields the snapshot may carry.
      const existing = workflow.publishedVersion.snapshot as unknown as SnapshotLike;
      if (!existing || !Array.isArray(existing.steps)) {
        logger.warn(
          `  ⚠  ${template.slug} v${workflow.publishedVersion.version} snapshot is not shaped like a WorkflowDefinition — skipping.`
        );
        continue;
      }

      const { snapshot: patched, filledCount } = mergeDescriptionsIntoSnapshot(
        existing,
        template.workflowDefinition
      );

      if (filledCount === 0) {
        templatesSkippedAlreadyFilled += 1;
        continue;
      }

      // Mutating the existing version's snapshot in place would violate
      // the documented immutability of `AiWorkflowVersion`. We publish a
      // new version instead — old execution traces keep pointing at
      // their original version and continue to render as they always
      // did; new runs use the snapshot with descriptions.
      await prisma.$transaction(async (tx) => {
        const previousVersion = workflow.publishedVersion!.version;
        const newVersion = await tx.aiWorkflowVersion.create({
          data: {
            workflowId: workflow.id,
            version: previousVersion + 1,
            snapshot: patched as unknown as Prisma.InputJsonValue,
            changeSummary: `Seed backfill: added description to ${filledCount} step${filledCount === 1 ? '' : 's'}`,
            createdBy,
          },
        });
        await tx.aiWorkflow.update({
          where: { id: workflow.id },
          data: { publishedVersionId: newVersion.id },
        });
      });

      logger.info(
        `  ✓ ${template.slug}: filled ${filledCount} description${filledCount === 1 ? '' : 's'}, published v${workflow.publishedVersion.version + 1}`
      );
      templatesUpdated += 1;
    }

    logger.info(
      `✅ Step-description backfill: updated ${templatesUpdated}, already filled ${templatesSkippedAlreadyFilled}, no row yet ${templatesSkippedNoRow}, no published version ${templatesSkippedNoPublished}`
    );
  },
};

export default unit;
