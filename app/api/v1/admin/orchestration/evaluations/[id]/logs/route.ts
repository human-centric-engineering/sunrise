/**
 * Admin Orchestration — Evaluation logs
 *
 * GET /api/v1/admin/orchestration/evaluations/:id/logs
 *
 * Returns log events for an evaluation session, ordered by
 * `sequenceNumber` ascending. Ownership is enforced on the parent
 * session — cross-user returns 404.
 *
 * Cursor pagination: pass `before` (a positive integer `sequenceNumber`)
 * to return only rows with a strictly smaller sequence number. Because
 * results are ordered by `sequenceNumber asc`, the cursor matches the
 * display order exactly. The default `limit` is 100 with a hard ceiling
 * of 500.
 *
 * Authentication: Admin role required.
 */

import type { Prisma } from '@prisma/client';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { validateQueryParams } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { cuidSchema } from '@/lib/validations/common';
import { evaluationLogsQuerySchema } from '@/lib/validations/orchestration';

export const GET = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const parsed = cuidSchema.safeParse(rawId);
  if (!parsed.success) {
    throw new ValidationError('Invalid evaluation id', { id: ['Must be a valid CUID'] });
  }
  const sessionId = parsed.data;

  // Ownership check on the parent session.
  const parent = await prisma.aiEvaluationSession.findFirst({
    where: { id: sessionId, userId: session.user.id },
    select: { id: true },
  });
  if (!parent) throw new NotFoundError(`Evaluation session ${sessionId} not found`);

  const { searchParams } = new URL(request.url);
  const { limit, before } = validateQueryParams(searchParams, evaluationLogsQuerySchema);

  const where: Prisma.AiEvaluationLogWhereInput = { sessionId };
  if (before !== undefined) where.sequenceNumber = { lt: before };

  const logs = await prisma.aiEvaluationLog.findMany({
    where,
    orderBy: { sequenceNumber: 'asc' },
    take: limit,
  });

  log.info('Evaluation logs fetched', { sessionId, count: logs.length });
  return successResponse({ logs });
});
