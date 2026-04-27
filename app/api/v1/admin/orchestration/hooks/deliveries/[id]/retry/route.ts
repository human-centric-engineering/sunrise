/**
 * Event Hook Delivery — Manual Retry
 *
 * POST /api/v1/admin/orchestration/hooks/deliveries/:id/retry
 *
 * Manually retries a failed or exhausted event-hook delivery.
 * Resets the attempt counter and re-dispatches.
 *
 * Authentication: Admin only.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { successResponse } from '@/lib/api/responses';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { retryHookDelivery } from '@/lib/orchestration/hooks/registry';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { cuidSchema } from '@/lib/validations/common';

export const POST = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const { id } = await params;
  if (!cuidSchema.safeParse(id).success) {
    throw new ValidationError('Invalid delivery ID format');
  }

  const ok = await retryHookDelivery(id);
  if (!ok) throw new NotFoundError('Hook delivery not found or no longer retriable');

  logAdminAction({
    userId: session.user.id,
    action: 'hook_delivery.retry',
    entityType: 'delivery',
    entityId: id,
    clientIp: clientIP,
  });

  return successResponse({ retried: true, deliveryId: id });
});
