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
import { getClientIP } from '@/lib/security/ip';
import { scheduleVersion } from '@/lib/orchestration/config-versions';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { cuidSchema } from '@/lib/validations/common';
import { createScheduleSchema } from '@/lib/validations/orchestration';
import { isValidCron, getNextRunAt } from '@/lib/orchestration/scheduling';
import { noteMaintenanceWork } from '@/lib/orchestration/maintenance/idle-gate';

export const GET = withAdminAuth<{ id: string }>(
  async (_request, _session, { params }) => {
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

    // Each schedule's version, for a save from the tab to send as If-Match
    // (§122 t-899).
    return successResponse({
      schedules: schedules.map((schedule) => ({ ...schedule, version: scheduleVersion(schedule) })),
    });
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

export const POST = withAdminAuth<{ id: string }>(
  async (request, session, { params }) => {
    const clientIP = getClientIP(request);

    const { id: rawId } = await params;
    const parsed = cuidSchema.safeParse(rawId);
    if (!parsed.success) {
      throw new ValidationError('Invalid workflow id', { id: ['Must be a valid CUID'] });
    }

    const workflow = await prisma.aiWorkflow.findUnique({ where: { id: parsed.data } });
    if (!workflow) throw new NotFoundError(`Workflow ${parsed.data} not found`);
    if (!workflow.isActive) {
      throw new ValidationError('Cannot create schedule on an inactive workflow', {
        workflowId: ['Workflow must be active to add schedules'],
      });
    }

    const existingCount = await prisma.aiWorkflowSchedule.count({
      where: { workflowId: parsed.data },
    });
    if (existingCount >= 10) {
      throw new ValidationError('Maximum of 10 schedules per workflow');
    }

    const body = await validateRequestBody(request, createScheduleSchema);

    if (!isValidCron(body.cronExpression)) {
      throw new ValidationError('Invalid cron expression', {
        cronExpression: ['Must be a valid cron expression (e.g. "0 9 * * 1-5")'],
      });
    }

    const nextRunAt = body.isEnabled !== false ? getNextRunAt(body.cronExpression) : null;

    // A create is new intent, not a copy of anything stored, so an address an
    // admin types into the template is saved even if its owner was once
    // erased (§122 t-899).
    const inputTemplate = (body.inputTemplate ?? {}) as Prisma.InputJsonValue;
    const schedule = await prisma.aiWorkflowSchedule
      .create({
        data: {
          workflowId: parsed.data,
          name: body.name,
          cronExpression: body.cronExpression,
          inputTemplate,
          isEnabled: body.isEnabled ?? true,
          ...(body.scope ? { scope: body.scope } : {}),
          nextRunAt,
          createdBy: session.user.id,
        },
      })
      .then((row) => ({ ...row, version: scheduleVersion(row) }));

    // A new schedule can be due sooner than an already-armed idle gate would next
    // sweep, so disarm it and let the next tick recompute the horizon (#442).
    if (nextRunAt) noteMaintenanceWork('schedule-created');

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
