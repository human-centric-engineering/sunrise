/**
 * Admin Orchestration — Run Experiment
 *
 * POST /api/v1/admin/orchestration/experiments/:id/run
 *
 * Transitions a draft experiment to "running" and provisions one
 * scoring vehicle per variant. The vehicle depends on which mode the
 * experiment opted into at create time:
 *
 *   - **Dataset-driven mode** (`datasetId` + `metricConfigs` are set,
 *     Phase 2.4). Creates one `AiEvaluationRun` per variant, queued
 *     for the batch worker to drain. Variants compare via
 *     `AiEvaluationRun.summary.stats` per metric. UI in 2.5.
 *
 *   - **Legacy session mode** (`datasetId` is null). Creates one
 *     `AiEvaluationSession` per variant for the manual chat-and-score
 *     workflow. Preserved so in-flight experiments at deploy time keep
 *     working; new experiments should opt into dataset-driven.
 *
 * Authentication: Admin role required.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { visibleExperimentClause } from '@/lib/orchestration/experiments/visible-scope';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { getClientIP } from '@/lib/security/ip';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';

type Params = { id: string };

export const POST = withAdminAuth<Params>(
  async (request, session, { params }) => {
    const clientIP = getClientIP(request);

    const { id } = await params;
    const log = await getRouteLogger(request);

    // Quick 404 check before opening a transaction. Cross-user 404 (not
    // 403) so the existence of another admin's experiment never leaks —
    // the posture every route in this family uses (#741).
    const visible = await visibleExperimentClause(session);

    const exists = await prisma.aiExperiment.findFirst({
      where: { AND: [visible, { id }] },
      select: { id: true },
    });
    if (!exists) throw new NotFoundError('Experiment not found');

    const now = new Date();

    const updated = await prisma.$transaction(async (tx) => {
      const experiment = await tx.aiExperiment.findFirst({
        // Same clause object as the pre-transaction check — one policy answer
        // for the whole request, so the two reads cannot disagree.
        where: { AND: [visible, { id }] },
        include: {
          variants: true,
          // Pull dataset.userId here so we can defence-in-depth verify
          // it belongs to the caller before we copy its content into a
          // run we own. Today's create-experiment route enforces dataset
          // ownership at write time, but a future writer adding a new
          // create path would silently bypass it without this check.
          dataset: {
            select: { id: true, userId: true, contentHash: true, caseCount: true },
          },
        },
      });
      if (!experiment) throw new NotFoundError('Experiment not found');

      if (experiment.status !== 'draft') {
        throw new ValidationError(`Experiment is already ${experiment.status}`);
      }

      if (experiment.variants.length < 2) {
        throw new ValidationError('Experiment needs at least 2 variants to run');
      }

      const datasetDriven = !!experiment.dataset && !!experiment.metricConfigs;

      // Defence in depth: the dataset bound to this experiment must
      // belong to the caller. Create-time validation at
      // `POST /experiments` already enforces this, but checking again
      // here means a future writer can add a new experiment-create path
      // without re-introducing the cross-user-dataset hole.
      if (datasetDriven && experiment.dataset && experiment.dataset.userId !== session.user.id) {
        throw new NotFoundError('Experiment not found');
      }

      for (const variant of experiment.variants) {
        if (datasetDriven && experiment.dataset && experiment.metricConfigs) {
          // Dataset-driven path — create one AiEvaluationRun per variant.
          // The batch worker will drain them on the next maintenance tick.
          const evalRun = await tx.aiEvaluationRun.create({
            data: {
              userId: session.user.id,
              name: `${experiment.name} — ${variant.label}`,
              description: `Experiment ${id}, variant ${variant.id}`,
              subjectKind: 'agent',
              agentId: experiment.agentId,
              datasetId: experiment.dataset.id,
              datasetContentHash: experiment.dataset.contentHash,
              metricConfigs: experiment.metricConfigs,
              status: 'queued',
              progress: {
                casesTotal: experiment.dataset.caseCount,
                casesDone: 0,
                casesFailed: 0,
              },
            },
          });

          await tx.aiExperimentVariant.update({
            where: { id: variant.id },
            data: { evaluationRunId: evalRun.id },
          });
        } else {
          // Legacy session path — preserved for back-compat. Mid-flight
          // experiments at deploy time stay on this path until they
          // complete; new experiments should opt into dataset-driven.
          const evalSession = await tx.aiEvaluationSession.create({
            data: {
              userId: session.user.id,
              agentId: experiment.agentId,
              title: `${experiment.name} — ${variant.label}`,
              status: 'in_progress',
              startedAt: now,
            },
          });

          await tx.aiExperimentVariant.update({
            where: { id: variant.id },
            data: { evaluationSessionId: evalSession.id },
          });
        }
      }

      return tx.aiExperiment.update({
        where: { id },
        data: { status: 'running' },
        include: {
          agent: { select: { id: true, name: true, slug: true } },
          dataset: { select: { id: true, name: true, caseCount: true } },
          variants: {
            include: {
              evaluationSession: { select: { id: true, status: true, completedAt: true } },
              evaluationRun: {
                select: { id: true, status: true, totalCostUsd: true, completedAt: true },
              },
            },
          },
          creator: { select: { id: true, name: true } },
        },
      });
    });

    const datasetDriven = updated.variants.some((v) => v.evaluationRunId !== null);

    logAdminAction({
      userId: session.user.id,
      action: 'experiment.run',
      entityType: 'experiment',
      entityId: id,
      entityName: updated.name,
      metadata: {
        variantCount: updated.variants.length,
        mode: datasetDriven ? 'dataset_driven' : 'session_legacy',
      },
      clientIp: clientIP,
    });

    log.info('Experiment run started', {
      experimentId: id,
      variantCount: updated.variants.length,
      mode: datasetDriven ? 'dataset_driven' : 'session_legacy',
    });

    return successResponse(updated);
  },
  {
    ownership: {
      decidedBy: 'self',
      because:
        "Both experiment reads use the caller's visible clause — theirs, or unowned where the policy allows — the pre-transaction existence check and the in-transaction read, from one policy answer. The dataset is reached through that experiment and verified against userId = the caller before its content is copied, and the runs and sessions this writes are stamped with the same id.",
    },
  }
);
