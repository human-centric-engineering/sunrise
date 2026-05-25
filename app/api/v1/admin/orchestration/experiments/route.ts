/**
 * Admin Orchestration — Experiments (list + create)
 *
 * GET  /api/v1/admin/orchestration/experiments — list experiments
 * POST /api/v1/admin/orchestration/experiments — create experiment
 *
 * Authentication: Admin role required.
 */

import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse, paginatedResponse } from '@/lib/api/responses';
import { validateRequestBody, validateQueryParams } from '@/lib/api/validation';
import { NotFoundError } from '@/lib/api/errors';
import { getRouteLogger } from '@/lib/api/context';
import { getClientIP } from '@/lib/security/ip';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { paginationQuerySchema } from '@/lib/validations/common';

const listSchema = paginationQuerySchema.extend({
  status: z.enum(['draft', 'running', 'completed']).optional(),
  agentId: z.string().optional(),
});

const createSchema = z
  .object({
    name: z.string().min(1).max(200),
    description: z.string().max(2000).optional(),
    agentId: z.string().min(1),
    /**
     * Phase 2.4: opt into dataset-driven experiment runs. When set, the
     * `/run` route creates one `AiEvaluationRun` per variant against this
     * shared dataset, rather than the legacy `AiEvaluationSession` path.
     * `metricConfigs` is required when `datasetId` is set so each variant
     * is scored consistently.
     */
    datasetId: z.string().min(1).optional(),
    metricConfigs: z
      .array(
        z.object({
          slug: z.string().min(1),
          config: z.unknown().optional(),
        })
      )
      .min(1)
      .optional(),
    variants: z
      .array(
        z.object({
          label: z.string().min(1).max(100),
          agentVersionId: z.string().optional(),
        })
      )
      .min(2, 'At least 2 variants required')
      .max(5, 'At most 5 variants'),
  })
  .refine((v) => !v.datasetId || (v.metricConfigs && v.metricConfigs.length > 0), {
    message: 'metricConfigs is required when datasetId is set',
  });

export const GET = withAdminAuth(async (request) => {
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

  const log = await getRouteLogger(request);
  const body = await validateRequestBody(request, createSchema);

  // Dataset ownership when the caller opted in.
  if (body.datasetId) {
    const dataset = await prisma.aiDataset.findFirst({
      where: { id: body.datasetId, userId: session.user.id },
      select: { id: true },
    });
    if (!dataset) {
      throw new NotFoundError(`Dataset ${body.datasetId} not found`);
    }
  }

  const experiment = await prisma.aiExperiment.create({
    data: {
      name: body.name,
      description: body.description ?? null,
      agentId: body.agentId,
      datasetId: body.datasetId ?? null,
      metricConfigs:
        body.metricConfigs && body.metricConfigs.length > 0
          ? (body.metricConfigs as Prisma.InputJsonValue)
          : undefined,
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
      variants: {
        include: {
          evaluationSession: { select: { id: true, status: true, completedAt: true } },
        },
      },
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
