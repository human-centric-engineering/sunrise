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
import { NotFoundError } from '@/lib/api/errors';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { retryHookDelivery } from '@/lib/orchestration/hooks/registry';

export const POST = withAdminAuth<{ id: string }>(async (request, _session, { params }) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const { id } = await params;

  const ok = await retryHookDelivery(id);
  if (!ok) throw new NotFoundError('Hook delivery not found or no longer retriable');

  return successResponse({ retried: true, deliveryId: id });
});
