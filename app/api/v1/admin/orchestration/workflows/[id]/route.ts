/**
 * Admin Orchestration — Single workflow (GET / PATCH / DELETE)
 *
 * GET    /api/v1/admin/orchestration/workflows/:id
 * PATCH  /api/v1/admin/orchestration/workflows/:id — merge fields; if
 *        `workflowDefinition` is provided, it is re-validated by the
 *        same Zod schema as create.
 * DELETE /api/v1/admin/orchestration/workflows/:id — soft delete.
 *
 * Authentication: Admin role required.
 */

import { Prisma } from '@prisma/client';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { updateWorkflowSchema } from '@/lib/validations/orchestration';
import { cuidSchema } from '@/lib/validations/common';

function parseWorkflowId(raw: string): string {
  const parsed = cuidSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError('Invalid workflow id', { id: ['Must be a valid CUID'] });
  }
  return parsed.data;
}

export const GET = withAdminAuth<{ id: string }>(async (request, _session, { params }) => {
  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const id = parseWorkflowId(rawId);

  const workflow = await prisma.aiWorkflow.findUnique({ where: { id } });
  if (!workflow) throw new NotFoundError(`Workflow ${id} not found`);

  log.info('Workflow fetched', { workflowId: id });
  return successResponse(workflow);
});

export const PATCH = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const id = parseWorkflowId(rawId);

  const current = await prisma.aiWorkflow.findUnique({ where: { id } });
  if (!current) throw new NotFoundError(`Workflow ${id} not found`);

  const body = await validateRequestBody(request, updateWorkflowSchema);

  const data: Prisma.AiWorkflowUpdateInput = {};
  if (body.name !== undefined) data.name = body.name;
  if (body.slug !== undefined) data.slug = body.slug;
  if (body.description !== undefined) data.description = body.description;
  if (body.workflowDefinition !== undefined) {
    data.workflowDefinition = body.workflowDefinition as unknown as Prisma.InputJsonValue;
  }
  if (body.patternsUsed !== undefined) data.patternsUsed = body.patternsUsed;
  if (body.isActive !== undefined) data.isActive = body.isActive;
  if (body.isTemplate !== undefined) data.isTemplate = body.isTemplate;
  if (body.metadata !== undefined) data.metadata = body.metadata as Prisma.InputJsonValue;

  try {
    const workflow = await prisma.aiWorkflow.update({ where: { id }, data });
    log.info('Workflow updated', {
      workflowId: id,
      adminId: session.user.id,
      fieldsChanged: Object.keys(data),
    });
    return successResponse(workflow);
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new ValidationError(`Workflow with slug '${body.slug}' already exists`, {
        slug: ['Slug is already in use'],
      });
    }
    throw err;
  }
});

export const DELETE = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const id = parseWorkflowId(rawId);

  const current = await prisma.aiWorkflow.findUnique({ where: { id } });
  if (!current) throw new NotFoundError(`Workflow ${id} not found`);

  await prisma.aiWorkflow.update({
    where: { id },
    data: { isActive: false },
  });

  log.info('Workflow soft-deleted', {
    workflowId: id,
    slug: current.slug,
    adminId: session.user.id,
  });

  return successResponse({ id, isActive: false });
});
