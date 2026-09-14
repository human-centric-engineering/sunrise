/**
 * Admin Orchestration — Lease inspector
 *
 * GET /api/v1/admin/orchestration/executions/:id/lease
 *
 * Returns the current lease state on `AiWorkflowExecution` plus the
 * append-only lease event history (last 50, newest first). Powers the
 * lease-inspector drill-in on the executions list so operators can
 * answer "is the engine restarting? how many times has this row been
 * recovered?" without reading raw DB.
 *
 * Tokens are only ever exposed as a 5-char redacted tail (the same
 * format `redactLeaseToken` uses for the event rows). The full token
 * is a write-capability secret and must never reach the browser.
 *
 * Authentication: Admin role required. Ownership: the caller's own runs,
 * plus system-owned runs (`userId = null`) where the authorization policy
 * permits an unattributed read — any other admin's own run returns 404.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { getRouteLogger } from '@/lib/api/context';
import { cuidSchema } from '@/lib/validations/common';
import { adminCanViewExecution } from '@/lib/orchestration/access/execution-access';
import { redactLeaseToken } from '@/lib/orchestration/engine/lease';

const HISTORY_LIMIT = 50;

export const GET = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const parsedId = cuidSchema.safeParse(rawId);
  if (!parsedId.success) {
    throw new ValidationError('Invalid execution id', { id: ['Must be a valid CUID'] });
  }
  const id = parsedId.data;

  const execution = await prisma.aiWorkflowExecution.findUnique({
    where: { id },
    select: {
      id: true,
      userId: true,
      leaseToken: true,
      leaseExpiresAt: true,
      lastHeartbeatAt: true,
      recoveryAttempts: true,
    },
  });
  if (!execution || !adminCanViewExecution(execution, session)) {
    throw new NotFoundError(`Execution ${id} not found`);
  }

  const history = await prisma.aiWorkflowExecutionLeaseEvent.findMany({
    where: { executionId: id },
    orderBy: { createdAt: 'desc' },
    take: HISTORY_LIMIT,
    select: {
      id: true,
      event: true,
      leaseToken: true,
      reason: true,
      metadata: true,
      createdAt: true,
    },
  });

  log.info('Lease inspector served', {
    executionId: id,
    historyCount: history.length,
  });

  return successResponse({
    current: {
      token: redactLeaseToken(execution.leaseToken),
      expiresAt: execution.leaseExpiresAt,
      lastHeartbeatAt: execution.lastHeartbeatAt,
      recoveryAttempts: execution.recoveryAttempts,
    },
    history,
  });
});
