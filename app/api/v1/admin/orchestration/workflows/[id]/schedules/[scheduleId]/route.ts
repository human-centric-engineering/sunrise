/**
 * Admin Orchestration — Single Workflow Schedule (get, update, delete)
 *
 * GET    /api/v1/admin/orchestration/workflows/:id/schedules/:scheduleId
 * PATCH  /api/v1/admin/orchestration/workflows/:id/schedules/:scheduleId
 * DELETE /api/v1/admin/orchestration/workflows/:id/schedules/:scheduleId
 */

import { Prisma } from '@prisma/client';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { successResponse } from '@/lib/api/responses';
import { validateRequestBody } from '@/lib/api/validation';
import { getClientIP } from '@/lib/security/ip';
import { WRITER_TRANSACTION_OPTIONS } from '@/lib/privacy/erased-subjects';
import { requireIfMatch } from '@/lib/api/record-version';
import { assertUnchangedSince, scheduleVersion } from '@/lib/orchestration/config-versions';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { cuidSchema } from '@/lib/validations/common';
import { updateScheduleSchema } from '@/lib/validations/orchestration';
import { isValidCron, getNextRunAt } from '@/lib/orchestration/scheduling';
import { noteMaintenanceWork } from '@/lib/orchestration/maintenance/idle-gate';

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

export const GET = withAdminAuth<Params>(async (_request, _session, { params }) => {
  const { id, scheduleId } = await params;
  const schedule = await resolveSchedule(id, scheduleId);
  // The version is a field, not the ETag: it covers only what a save writes,
  // and `nextRunAt` and `lastRunAt` move without it.
  return successResponse({ schedule: { ...schedule, version: scheduleVersion(schedule) } });
});

export const PATCH = withAdminAuth<Params>(
  async (request, session, { params }) => {
    const clientIP = getClientIP(request);

    const { id, scheduleId } = await params;
    const existing = await resolveSchedule(id, scheduleId);

    // The version the form loaded (§122 t-899), checked under the row lock.
    const loadedAt = requireIfMatch(request);
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

    // The edit form sends the whole template it loaded, so one opened before a
    // person was erased would write their address back. Refused when the
    // schedule has moved on since it was loaded (§122 t-899), under the lock
    // erasure takes; a template typed into a freshly loaded form is saved.
    const updated = await prisma.$transaction(async (tx) => {
      await assertUnchangedSince(tx, { kind: 'workflow-schedule', id: existing.id }, loadedAt);
      return tx.aiWorkflowSchedule.update({
        where: { id: existing.id },
        data: {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.cronExpression !== undefined ? { cronExpression: body.cronExpression } : {}),
          ...(body.inputTemplate !== undefined
            ? { inputTemplate: body.inputTemplate as Prisma.InputJsonValue }
            : {}),
          ...(body.isEnabled !== undefined ? { isEnabled: body.isEnabled } : {}),
          // `scope` is a `Json?` column: JS `null` can't clear it (Prisma needs the
          // `DbNull` sentinel), and `undefined` leaves it untouched.
          ...(body.scope !== undefined
            ? { scope: body.scope === null ? Prisma.DbNull : body.scope }
            : {}),
          nextRunAt,
        },
      });
    }, WRITER_TRANSACTION_OPTIONS);

    // The edited schedule can be due sooner than an already-armed idle gate would
    // next sweep, so disarm it and let the next tick recompute the horizon (#442).
    if (nextRunAt) noteMaintenanceWork('schedule-updated');

    logAdminAction({
      userId: session.user.id,
      action: 'workflow_schedule.update',
      entityType: 'workflow_schedule',
      entityId: existing.id,
      entityName: updated.name,
      metadata: { workflowId: id },
      clientIp: clientIP,
    });

    return successResponse({ schedule: { ...updated, version: scheduleVersion(updated) } });
  },
  {
    tier: 'org',
    ownership: {
      decidedBy: 'nothing',
      because:
        'Workflows, their versions, schedules and templates are the org’s configuration, not anyone’s personal rows; row isolation bounds them to the entered org.',
    },
  }
);

export const DELETE = withAdminAuth<Params>(
  async (request, session, { params }) => {
    const clientIP = getClientIP(request);

    const { id, scheduleId } = await params;
    const existing = await resolveSchedule(id, scheduleId);

    await prisma.aiWorkflowSchedule.delete({ where: { id: existing.id } });

    logAdminAction({
      userId: session.user.id,
      action: 'workflow_schedule.delete',
      entityType: 'workflow_schedule',
      entityId: existing.id,
      entityName: existing.name,
      metadata: { workflowId: id },
      clientIp: clientIP,
    });

    return successResponse({ deleted: true });
  },
  {
    tier: 'org',
    ownership: {
      decidedBy: 'nothing',
      because:
        'Workflows, their versions, schedules and templates are the org’s configuration, not anyone’s personal rows; row isolation bounds them to the entered org.',
    },
  }
);
