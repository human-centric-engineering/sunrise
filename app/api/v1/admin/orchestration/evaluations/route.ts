/**
 * Admin Orchestration — Evaluations (list + create)
 *
 * GET  /api/v1/admin/orchestration/evaluations — paginated list, scoped to the caller
 * POST /api/v1/admin/orchestration/evaluations — create a new evaluation session
 *
 * Ownership: all evaluation rows are scoped to `session.user.id`.
 * Cross-user access from other endpoints in this tree returns 404.
 *
 * Authentication: Admin role required.
 */

import type { Prisma } from '@prisma/client';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { paginatedResponse, successResponse } from '@/lib/api/responses';
import { NotFoundError } from '@/lib/api/errors';
import { validateQueryParams, validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import {
  createEvaluationSchema,
  listEvaluationsQuerySchema,
} from '@/lib/validations/orchestration';

export const GET = withAdminAuth(async (request, session) => {
  const log = await getRouteLogger(request);
  const { searchParams } = new URL(request.url);
  const { page, limit, agentId, status, q } = validateQueryParams(
    searchParams,
    listEvaluationsQuerySchema
  );
  const skip = (page - 1) * limit;

  const where: Prisma.AiEvaluationSessionWhereInput = {
    userId: session.user.id,
  };
  if (agentId) where.agentId = agentId;
  if (status) where.status = status;
  if (q) where.title = { contains: q, mode: 'insensitive' };

  const [evaluations, total] = await Promise.all([
    prisma.aiEvaluationSession.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      skip,
      take: limit,
      include: {
        agent: { select: { id: true, name: true, slug: true } },
        _count: { select: { logs: true } },
      },
    }),
    prisma.aiEvaluationSession.count({ where }),
  ]);

  log.info('Evaluations listed', { count: evaluations.length, total });

  return paginatedResponse(evaluations, { page, limit, total });
});

export const POST = withAdminAuth(async (request, session) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);
  const body = await validateRequestBody(request, createEvaluationSchema);

  // Verify the agent exists before creating the session. We don't
  // restrict to agents the caller owns — agents are shared admin-wide.
  const agent = await prisma.aiAgent.findUnique({
    where: { id: body.agentId },
    select: { id: true },
  });
  if (!agent) {
    throw new NotFoundError(`Agent ${body.agentId} not found`);
  }

  const created = await prisma.aiEvaluationSession.create({
    data: {
      userId: session.user.id,
      agentId: body.agentId,
      title: body.title,
      description: body.description ?? null,
      status: 'draft',
      metadata: body.metadata ?? undefined,
    },
  });

  log.info('Evaluation session created', {
    sessionId: created.id,
    agentId: created.agentId,
    userId: session.user.id,
  });

  return successResponse(created, undefined, { status: 201 });
});
