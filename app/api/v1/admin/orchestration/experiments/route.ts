/**
 * Admin Orchestration — Experiments (list + create)
 *
 * GET  /api/v1/admin/orchestration/experiments — list experiments
 * POST /api/v1/admin/orchestration/experiments — create experiment
 *
 * Authentication: Admin role required.
 *
 * Ownership: owner-scoped on `createdBy`, every route in the family, which is
 * the posture `run` / `compare` / `verdicts` already had and the list and the
 * detail routes did not (#741). An experiment is personal work product, not
 * shared configuration: it reads an `AiDataset` and writes `AiEvaluationRun` /
 * `AiEvaluationSession` rows, and every route under `orchestration/evaluations`
 * scopes those three to their owner — on `userId`, not `createdBy`. A wider
 * parent would list experiments whose results the viewer cannot open.
 *
 * One read of those models sits outside that family and is NOT owner-scoped:
 * `agents/compare/route.ts` counts `AiEvaluationSession` per agent across the
 * install. Correct today (a count, to a platform admin), and named here because
 * a roster of this family assembled by reading the `evaluations/` directory
 * misses it. Filed as #753.
 *
 * **Ownerless rows are a third case, and they are the policy's to decide.**
 * `createdBy` is `SetNull`, so erasing an admin leaves their experiments with no
 * owner. Those belong to nobody rather than to someone else, so every handler
 * here reads them too — but only when `canRead` permits an `'unattributed'`
 * read, which the default policy grants platform staff and a fork narrows by
 * registering a policy. Without that, scoping to the owner would make a retained
 * row unreachable by everyone (t-678). `mayReadUnattributed` is the one place
 * that question is asked.
 */

import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { withAdminAuth } from '@/lib/auth/guards';
import { datasetVisibilityWhere } from '@/lib/orchestration/access/dataset-access';
import { visibleExperimentClause } from '@/lib/orchestration/experiments/visible-scope';
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

export const GET = withAdminAuth(
  async (request, session) => {
    const log = await getRouteLogger(request);
    const { searchParams } = new URL(request.url);
    const query = validateQueryParams(searchParams, listSchema);
    const { page, limit, status, agentId } = query;

    // Mine, plus nobody's when the policy allows it. `AND`, not a spread: the
    // optional filters are assigned onto their own object so no query parameter
    // can reach the key that is the boundary.
    const ownerClause = await visibleExperimentClause(session);
    const filters: Prisma.AiExperimentWhereInput = {};
    if (status) filters.status = status;
    if (agentId) filters.agentId = agentId;
    const where: Prisma.AiExperimentWhereInput = { AND: [ownerClause, filters] };

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
  },
  {
    ownership: {
      decidedBy: 'self',
      because:
        "The list and its count are keyed on createdBy = the caller, widened only to rows with NO owner and only when canRead permits an unattributed read. Never another subject's row. Not `policy`: subjectScope widens to {} for a platform admin, which is the admin-global posture this route was fixed away from.",
    },
  }
);

export const POST = withAdminAuth(
  async (request, session) => {
    const clientIP = getClientIP(request);

    const log = await getRouteLogger(request);
    const body = await validateRequestBody(request, createSchema);

    // Dataset visibility when the caller opted in — theirs, or one nobody
    // owns where the policy allows. Matches `[id]/run`, which already permits
    // an ownerless dataset (t-678); binding and running must agree.
    if (body.datasetId) {
      const dataset = await prisma.aiDataset.findFirst({
        where: { AND: [await datasetVisibilityWhere(session), { id: body.datasetId }] },
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
  },
  {
    ownership: {
      decidedBy: 'self',
      because:
        'Stamps createdBy = the caller, and the optional dataset is read under the same key. Nothing here reads another subject.',
    },
  }
);
