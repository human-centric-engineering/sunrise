/**
 * Webhook Delivery — Manual Retry
 *
 * POST /api/v1/admin/orchestration/webhooks/deliveries/:id/retry
 *
 * Manually retries a failed or exhausted webhook delivery.
 * Resets the attempt counter and re-dispatches.
 *
 * Authentication: Admin only.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { successResponse } from '@/lib/api/responses';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { retryDelivery } from '@/lib/orchestration/webhooks/dispatcher';
import { cuidSchema } from '@/lib/validations/common';

export const POST = withAdminAuth<{ id: string }>(async (request, _session, { params }) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const { id } = await params;
  if (!cuidSchema.safeParse(id).success) {
    throw new ValidationError('Invalid delivery ID format');
  }

  const ok = await retryDelivery(id);
  if (!ok) throw new NotFoundError('Webhook delivery not found');

  return successResponse({ retried: true, deliveryId: id });
});
