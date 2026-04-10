/**
 * Admin Orchestration — Single evaluation session
 *
 * GET   /api/v1/admin/orchestration/evaluations/:id — read
 * PATCH /api/v1/admin/orchestration/evaluations/:id — update
 *
 * Ownership: both methods scope to `session.user.id`. Cross-user
 * access returns 404 (not 403) to avoid confirming existence.
 *
 * PATCH deliberately cannot set `status='completed'` — completion
 * must go through `/complete` so the AI analysis and status flip
 * happen atomically. The Zod schema enforces this.
 *
 * Authentication: Admin role required.
 */

import type { Prisma } from '@prisma/client';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { cuidSchema } from '@/lib/validations/common';
import { updateEvaluationSchema } from '@/lib/validations/orchestration';

async function loadSession(id: string, userId: string) {
  const session = await prisma.aiEvaluationSession.findFirst({
    where: { id, userId },
    include: {
      agent: { select: { id: true, name: true, slug: true } },
      _count: { select: { logs: true } },
    },
  });
  if (!session) throw new NotFoundError(`Evaluation session ${id} not found`);
  return session;
}

function parseId(rawId: string): string {
  const parsed = cuidSchema.safeParse(rawId);
  if (!parsed.success) {
    throw new ValidationError('Invalid evaluation id', { id: ['Must be a valid CUID'] });
  }
  return parsed.data;
}

export const GET = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const id = parseId(rawId);

  const row = await loadSession(id, session.user.id);
  log.info('Evaluation fetched', { sessionId: id });
  return successResponse(row);
});

export const PATCH = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const id = parseId(rawId);

  const body = await validateRequestBody(request, updateEvaluationSchema);

  // Ownership check before update. Preserves 404-on-cross-user.
  await loadSession(id, session.user.id);

  const data: Prisma.AiEvaluationSessionUpdateInput = {};
  if (body.title !== undefined) data.title = body.title;
  if (body.description !== undefined) data.description = body.description;
  if (body.status !== undefined) data.status = body.status;
  if (body.metadata !== undefined) {
    data.metadata = body.metadata as Prisma.InputJsonValue;
  }

  const updated = await prisma.aiEvaluationSession.update({
    where: { id },
    data,
    include: {
      agent: { select: { id: true, name: true, slug: true } },
      _count: { select: { logs: true } },
    },
  });

  log.info('Evaluation updated', { sessionId: id, fields: Object.keys(data) });
  return successResponse(updated);
});
