/**
 * Admin Orchestration — Workflows (list + create)
 *
 * GET  /api/v1/admin/orchestration/workflows — paginated list with filters
 * POST /api/v1/admin/orchestration/workflows — create a new workflow
 *
 * `workflowDefinition` is schema-validated by `createWorkflowSchema`;
 * structural DAG checks (reachability, cycles, step-type config) are
 * performed by `POST /workflows/:id/validate` and by the engine pre-flight.
 *
 * Authentication: Admin role required.
 */

import { Prisma } from '@prisma/client';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { paginatedResponse, successResponse } from '@/lib/api/responses';
import { ConflictError } from '@/lib/api/errors';
import { validateQueryParams, validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { createWorkflowSchema, listWorkflowsQuerySchema } from '@/lib/validations/orchestration';

export const GET = withAdminAuth(async (request, _session) => {
  const log = await getRouteLogger(request);

  const { searchParams } = new URL(request.url);
  const { page, limit, isActive, isTemplate, q } = validateQueryParams(
    searchParams,
    listWorkflowsQuerySchema
  );
  const skip = (page - 1) * limit;

  const where: Prisma.AiWorkflowWhereInput = {};
  if (isActive !== undefined) where.isActive = isActive;
  if (isTemplate !== undefined) where.isTemplate = isTemplate;
  if (q) {
    where.OR = [
      { name: { contains: q, mode: 'insensitive' } },
      { slug: { contains: q, mode: 'insensitive' } },
      { description: { contains: q, mode: 'insensitive' } },
    ];
  }

  const [workflows, total] = await Promise.all([
    prisma.aiWorkflow.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
      include: { _count: { select: { executions: true } } },
    }),
    prisma.aiWorkflow.count({ where }),
  ]);

  log.info('Workflows listed', { count: workflows.length, total, page, limit });
  return paginatedResponse(workflows, { page, limit, total });
});

export const POST = withAdminAuth(async (request, session) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);
  const body = await validateRequestBody(request, createWorkflowSchema);

  try {
    const workflow = await prisma.aiWorkflow.create({
      data: {
        name: body.name,
        slug: body.slug,
        description: body.description,
        workflowDefinition: body.workflowDefinition as unknown as Prisma.InputJsonValue,
        patternsUsed: body.patternsUsed,
        isActive: body.isActive,
        isTemplate: body.isTemplate,
        metadata: (body.metadata ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        createdBy: session.user.id,
      },
    });

    log.info('Workflow created', {
      workflowId: workflow.id,
      slug: workflow.slug,
      adminId: session.user.id,
    });

    return successResponse(workflow, undefined, { status: 201 });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new ConflictError(`Workflow with slug '${body.slug}' already exists`);
    }
    throw err;
  }
});
