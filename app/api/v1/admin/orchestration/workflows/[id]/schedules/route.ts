/**
 * Admin Orchestration — Workflow Schedules (list + create)
 *
 * GET  /api/v1/admin/orchestration/workflows/:id/schedules
 * POST /api/v1/admin/orchestration/workflows/:id/schedules
 */

import type { Prisma } from '@prisma/client';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { successResponse } from '@/lib/api/responses';
import { validateRequestBody } from '@/lib/api/validation';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { cuidSchema } from '@/lib/validations/common';
import { createScheduleSchema } from '@/lib/validations/orchestration';
import { isValidCron, getNextRunAt } from '@/lib/orchestration/scheduling';

export const GET = withAdminAuth<{ id: string }>(async (request, _session, { params }) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const { id: rawId } = await params;
  const parsed = cuidSchema.safeParse(rawId);
  if (!parsed.success) {
    throw new ValidationError('Invalid workflow id', { id: ['Must be a valid CUID'] });
  }

  const workflow = await prisma.aiWorkflow.findUnique({ where: { id: parsed.data } });
  if (!workflow) throw new NotFoundError(`Workflow ${parsed.data} not found`);

  const schedules = await prisma.aiWorkflowSchedule.findMany({
    where: { workflowId: parsed.data },
    orderBy: { createdAt: 'desc' },
  });

  return successResponse({ schedules });
});

export const POST = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const { id: rawId } = await params;
  const parsed = cuidSchema.safeParse(rawId);
  if (!parsed.success) {
    throw new ValidationError('Invalid workflow id', { id: ['Must be a valid CUID'] });
  }

  const workflow = await prisma.aiWorkflow.findUnique({ where: { id: parsed.data } });
  if (!workflow) throw new NotFoundError(`Workflow ${parsed.data} not found`);

  const body = await validateRequestBody(request, createScheduleSchema);

  if (!isValidCron(body.cronExpression)) {
    throw new ValidationError('Invalid cron expression', {
      cronExpression: ['Must be a valid cron expression (e.g. "0 9 * * 1-5")'],
    });
  }

  const nextRunAt = body.isEnabled !== false ? getNextRunAt(body.cronExpression) : null;

  const schedule = await prisma.aiWorkflowSchedule.create({
    data: {
      workflowId: parsed.data,
      name: body.name,
      cronExpression: body.cronExpression,
      inputTemplate: (body.inputTemplate ?? {}) as Prisma.InputJsonValue,
      isEnabled: body.isEnabled ?? true,
      nextRunAt,
      createdBy: session.user.id,
    },
  });

  logAdminAction({
    userId: session.user.id,
    action: 'workflow_schedule.create',
    entityType: 'workflow_schedule',
    entityId: schedule.id,
    entityName: schedule.name,
    metadata: { workflowId: parsed.data, cronExpression: body.cronExpression },
    clientIp: clientIP,
  });

  return successResponse({ schedule }, undefined, { status: 201 });
});
