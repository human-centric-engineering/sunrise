/**
 * Admin Orchestration — Run Experiment
 *
 * POST /api/v1/admin/orchestration/experiments/:id/run
 *
 * Starts an experiment run: transitions status to "running",
 * creates evaluation sessions per variant using the agent version
 * snapshots, and returns the experiment with updated status.
 *
 * Currently sets status to running — full eval session integration
 * is a future enhancement that ties into the evaluation runner.
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

  const experiment = await prisma.aiExperiment.findUnique({
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

  const updated = await prisma.aiExperiment.update({
    where: { id },
    data: { status: 'running' },
    include: {
      agent: { select: { id: true, name: true, slug: true } },
      variants: true,
      creator: { select: { id: true, name: true } },
    },
  });

  logAdminAction({
    userId: session.user.id,
    action: 'experiment.run',
    entityType: 'experiment',
    entityId: id,
    entityName: experiment.name,
    metadata: { variantCount: experiment.variants.length },
    clientIp: clientIP,
  });

  log.info('Experiment run started', {
    experimentId: id,
    variantCount: experiment.variants.length,
  });

  return successResponse(updated);
});
