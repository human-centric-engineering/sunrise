/**
 * Admin Orchestration — Single Workflow Schedule (get, update, delete)
 *
 * GET    /api/v1/admin/orchestration/workflows/:id/schedules/:scheduleId
 * PATCH  /api/v1/admin/orchestration/workflows/:id/schedules/:scheduleId
 * DELETE /api/v1/admin/orchestration/workflows/:id/schedules/:scheduleId
 */

import type { Prisma } from '@prisma/client';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { successResponse } from '@/lib/api/responses';
import { validateRequestBody } from '@/lib/api/validation';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { cuidSchema } from '@/lib/validations/common';
import { updateScheduleSchema } from '@/lib/validations/orchestration';
import { isValidCron, getNextRunAt } from '@/lib/orchestration/scheduling';

type Params = { id: string; scheduleId: string };

async function resolveSchedule(rawId: string, rawScheduleId: string) {
  const workflowId = cuidSchema.safeParse(rawId);
  if (!workflowId.success) {
    throw new ValidationError('Invalid workflow id', { id: ['Must be a valid CUID'] });
  }
  const scheduleId = cuidSchema.safeParse(rawScheduleId);
  if (!scheduleId.success) {
    throw new ValidationError('Invalid schedule id', { scheduleId: ['Must be a valid CUID'] });
  }

  const schedule = await prisma.aiWorkflowSchedule.findFirst({
    where: { id: scheduleId.data, workflowId: workflowId.data },
  });
  if (!schedule) throw new NotFoundError('Schedule not found');

  return schedule;
}

export const GET = withAdminAuth<Params>(async (request, _session, { params }) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const { id, scheduleId } = await params;
  const schedule = await resolveSchedule(id, scheduleId);

  return successResponse({ schedule });
});

export const PATCH = withAdminAuth<Params>(async (request, _session, { params }) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const { id, scheduleId } = await params;
  const existing = await resolveSchedule(id, scheduleId);

  const body = await validateRequestBody(request, updateScheduleSchema);

  if (body.cronExpression && !isValidCron(body.cronExpression)) {
    throw new ValidationError('Invalid cron expression', {
      cronExpression: ['Must be a valid cron expression (e.g. "0 9 * * 1-5")'],
    });
  }

  // Recompute nextRunAt if cron or enabled status changed
  const cronExpr = body.cronExpression ?? existing.cronExpression;
  const isEnabled = body.isEnabled ?? existing.isEnabled;
  const nextRunAt = isEnabled ? getNextRunAt(cronExpr) : null;

  const updated = await prisma.aiWorkflowSchedule.update({
    where: { id: existing.id },
    data: {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.cronExpression !== undefined ? { cronExpression: body.cronExpression } : {}),
      ...(body.inputTemplate !== undefined
        ? { inputTemplate: body.inputTemplate as Prisma.InputJsonValue }
        : {}),
      ...(body.isEnabled !== undefined ? { isEnabled: body.isEnabled } : {}),
      nextRunAt,
    },
  });

  return successResponse({ schedule: updated });
});

export const DELETE = withAdminAuth<Params>(async (request, _session, { params }) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const { id, scheduleId } = await params;
  const existing = await resolveSchedule(id, scheduleId);

  await prisma.aiWorkflowSchedule.delete({ where: { id: existing.id } });

  return successResponse({ deleted: true });
});
