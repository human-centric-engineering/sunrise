/**
 * Admin Orchestration — Event Hook Secret Rotation
 *
 * POST   /api/v1/admin/orchestration/hooks/:id/rotate-secret
 *   Generates fresh HMAC signing material for an existing event hook.
 *   The new secret is returned ONCE in the response and is not retrievable
 *   afterwards — admins must copy it immediately into the receiving system.
 *   The previous secret (if any) is overwritten atomically; in-flight
 *   retries dispatched before rotation keep their original signature.
 *
 * DELETE /api/v1/admin/orchestration/hooks/:id/rotate-secret
 *   Clears the stored secret so future dispatches are unsigned.
 *
 * Auth: Admin role required.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { getRouteLogger } from '@/lib/api/context';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { invalidateHookCache } from '@/lib/orchestration/hooks/registry';
import { generateHookSecret } from '@/lib/orchestration/hooks/signing';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { cuidSchema } from '@/lib/validations/common';

export const POST = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const parsed = cuidSchema.safeParse(rawId);
  if (!parsed.success) {
    throw new ValidationError('Invalid hook id', { id: ['Must be a valid CUID'] });
  }
  const id = parsed.data;

  const existing = await prisma.aiEventHook.findUnique({
    where: { id },
    select: { id: true, name: true, secret: true },
  });
  if (!existing) throw new NotFoundError(`Hook ${id} not found`);

  const secret = generateHookSecret();
  const hadPrevious = existing.secret !== null;

  const updated = await prisma.aiEventHook.update({
    where: { id },
    data: { secret },
    select: { id: true, updatedAt: true },
  });

  invalidateHookCache();

  log.info('Event hook secret rotated', {
    adminId: session.user.id,
    hookId: id,
    hadPrevious,
  });

  logAdminAction({
    userId: session.user.id,
    action: 'hook.secret.rotated',
    entityType: 'webhook',
    entityId: id,
    entityName: existing.name,
    metadata: { hadPrevious },
    clientIp: clientIP,
  });

  return successResponse({
    id: updated.id,
    secret,
    rotatedAt: updated.updatedAt,
  });
});

export const DELETE = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const parsed = cuidSchema.safeParse(rawId);
  if (!parsed.success) {
    throw new ValidationError('Invalid hook id', { id: ['Must be a valid CUID'] });
  }
  const id = parsed.data;

  const existing = await prisma.aiEventHook.findUnique({
    where: { id },
    select: { id: true, name: true, secret: true },
  });
  if (!existing) throw new NotFoundError(`Hook ${id} not found`);

  if (existing.secret === null) {
    // Idempotent: no secret to clear → nothing to do
    return successResponse({ id, cleared: false });
  }

  await prisma.aiEventHook.update({
    where: { id },
    data: { secret: null },
    select: { id: true },
  });

  invalidateHookCache();

  log.info('Event hook secret cleared', { adminId: session.user.id, hookId: id });

  logAdminAction({
    userId: session.user.id,
    action: 'hook.secret.cleared',
    entityType: 'webhook',
    entityId: id,
    entityName: existing.name,
    clientIp: clientIP,
  });

  return successResponse({ id, cleared: true });
});
