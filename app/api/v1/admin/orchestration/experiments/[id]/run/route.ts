/**
 * Admin Orchestration — Run Experiment
 *
 * POST /api/v1/admin/orchestration/experiments/:id/run
 *
 * Transitions a draft experiment to "running" and creates one evaluation
 * session per variant, linking each via evaluationSessionId. The admin
 * then chats with each variant's session and completes them. When all
 * sessions reach "completed", the experiment can be marked complete.
 *
 * Authentication: Admin role required.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';

type Params = { id: string };

export const POST = withAdminAuth<Params>(async (request, session, { params }) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const { id } = await params;
  const log = await getRouteLogger(request);

  // Quick 404 check before opening a transaction
  const exists = await prisma.aiExperiment.findUnique({
    where: { id },
    select: { id: true },
  });
  if (!exists) throw new NotFoundError('Experiment not found');

  const now = new Date();

  // All reads and writes inside the transaction to prevent TOCTOU races
  const updated = await prisma.$transaction(async (tx) => {
    const experiment = await tx.aiExperiment.findUnique({
      where: { id },
      include: { variants: true },
    });
    if (!experiment) throw new NotFoundError('Experiment not found');

    if (experiment.status !== 'draft') {
      throw new ValidationError(`Experiment is already ${experiment.status}`);
    }

    if (experiment.variants.length < 2) {
      throw new ValidationError('Experiment needs at least 2 variants to run');
    }

    // Create one evaluation session per variant
    for (const variant of experiment.variants) {
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

    // Transition experiment to running
    return tx.aiExperiment.update({
      where: { id },
      data: { status: 'running' },
      include: {
        agent: { select: { id: true, name: true, slug: true } },
        variants: {
          include: {
            evaluationSession: { select: { id: true, status: true, completedAt: true } },
          },
        },
        creator: { select: { id: true, name: true } },
      },
    });
  });

  logAdminAction({
    userId: session.user.id,
    action: 'experiment.run',
    entityType: 'experiment',
    entityId: id,
    entityName: updated.name,
    metadata: { variantCount: updated.variants.length },
    clientIp: clientIP,
  });

  log.info('Experiment run started', {
    experimentId: id,
    variantCount: updated.variants.length,
  });

  return successResponse(updated);
});
