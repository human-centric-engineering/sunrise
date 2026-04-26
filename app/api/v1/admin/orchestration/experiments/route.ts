/**
 * Admin Orchestration — Experiments (list + create)
 *
 * GET  /api/v1/admin/orchestration/experiments — list experiments
 * POST /api/v1/admin/orchestration/experiments — create experiment
 *
 * Authentication: Admin role required.
 */

import { z } from 'zod';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse, paginatedResponse } from '@/lib/api/responses';
import { validateRequestBody, validateQueryParams } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { paginationQuerySchema } from '@/lib/validations/common';

const listSchema = paginationQuerySchema.extend({
  status: z.enum(['draft', 'running', 'completed']).optional(),
  agentId: z.string().optional(),
});

const createSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  agentId: z.string().min(1),
  variants: z
    .array(
      z.object({
        label: z.string().min(1).max(100),
        agentVersionId: z.string().optional(),
      })
    )
    .min(2, 'At least 2 variants required')
    .max(5, 'At most 5 variants'),
});

export const GET = withAdminAuth(async (request) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);
  const { searchParams } = new URL(request.url);
  const query = validateQueryParams(searchParams, listSchema);
  const { page, limit, status, agentId } = query;

  const where = {
    ...(status ? { status } : {}),
    ...(agentId ? { agentId } : {}),
  };

  const [experiments, total] = await Promise.all([
    prisma.aiExperiment.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
      include: {
        agent: { select: { id: true, name: true, slug: true } },
        variants: {
          include: {
            evaluationSession: { select: { id: true, status: true, completedAt: true } },
          },
        },
        creator: { select: { id: true, name: true } },
      },
    }),
    prisma.aiExperiment.count({ where }),
  ]);

  log.info('Experiments listed', { total, page });
  return paginatedResponse(experiments, { page, limit, total });
});

export const POST = withAdminAuth(async (request, session) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);
  const body = await validateRequestBody(request, createSchema);

  const experiment = await prisma.aiExperiment.create({
    data: {
      name: body.name,
      description: body.description ?? null,
      agentId: body.agentId,
      createdBy: session.user.id,
      variants: {
        create: body.variants.map((v) => ({
          label: v.label,
          agentVersionId: v.agentVersionId ?? null,
        })),
      },
    },
    include: {
      agent: { select: { id: true, name: true, slug: true } },
      variants: true,
      creator: { select: { id: true, name: true } },
    },
  });

  logAdminAction({
    userId: session.user.id,
    action: 'experiment.create',
    entityType: 'experiment',
    entityId: experiment.id,
    entityName: experiment.name,
    metadata: { agentId: body.agentId, variantCount: body.variants.length },
    clientIp: clientIP,
  });

  log.info('Experiment created', { experimentId: experiment.id });
  return successResponse(experiment, undefined, { status: 201 });
});
