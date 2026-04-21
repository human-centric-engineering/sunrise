/**
 * Admin Orchestration — Single Experiment (GET / PATCH / DELETE)
 *
 * GET    /api/v1/admin/orchestration/experiments/:id
 * PATCH  /api/v1/admin/orchestration/experiments/:id
 * DELETE /api/v1/admin/orchestration/experiments/:id
 *
 * Authentication: Admin role required.
 */

import { z } from 'zod';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { NotFoundError } from '@/lib/api/errors';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';

type Params = { id: string };

const updateSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).nullable().optional(),
    status: z.enum(['draft', 'running', 'completed']).optional(),
  })
  .refine((v) => v.name !== undefined || v.description !== undefined || v.status !== undefined, {
    message: 'At least one field must be provided',
  });

export const GET = withAdminAuth<Params>(async (request, _session, { params }) => {
  const { id } = await params;
  const log = await getRouteLogger(request);

  const experiment = await prisma.aiExperiment.findUnique({
    where: { id },
    include: {
      agent: { select: { id: true, name: true, slug: true } },
      variants: true,
      creator: { select: { id: true, name: true } },
    },
  });
  if (!experiment) throw new NotFoundError('Experiment not found');

  log.info('Experiment fetched', { experimentId: id });
  return successResponse(experiment);
});

export const PATCH = withAdminAuth<Params>(async (request, session, { params }) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const { id } = await params;
  const log = await getRouteLogger(request);
  const body = await validateRequestBody(request, updateSchema);

  const existing = await prisma.aiExperiment.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Experiment not found');

  const experiment = await prisma.aiExperiment.update({
    where: { id },
    data: {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.status !== undefined ? { status: body.status } : {}),
    },
    include: {
      agent: { select: { id: true, name: true, slug: true } },
      variants: true,
      creator: { select: { id: true, name: true } },
    },
  });

  logAdminAction({
    userId: session.user.id,
    action: 'experiment.update',
    entityType: 'experiment',
    entityId: id,
    entityName: experiment.name,
    metadata: { changedKeys: Object.keys(body) },
    clientIp: clientIP,
  });

  log.info('Experiment updated', { experimentId: id });
  return successResponse(experiment);
});

export const DELETE = withAdminAuth<Params>(async (request, session, { params }) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const { id } = await params;
  const log = await getRouteLogger(request);

  const existing = await prisma.aiExperiment.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Experiment not found');

  await prisma.aiExperiment.delete({ where: { id } });

  logAdminAction({
    userId: session.user.id,
    action: 'experiment.delete',
    entityType: 'experiment',
    entityId: id,
    entityName: existing.name,
    clientIp: clientIP,
  });

  log.info('Experiment deleted', { experimentId: id });
  return successResponse({ deleted: true });
});
