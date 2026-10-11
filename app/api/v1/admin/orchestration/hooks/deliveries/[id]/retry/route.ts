/**
 * Event Hook Delivery — Manual Retry
 *
 * POST /api/v1/admin/orchestration/hooks/deliveries/:id/retry
 *
 * Manually retries a failed or exhausted event-hook delivery.
 * Resets the attempt counter and re-dispatches. A delivery whose hook was
 * deleted is kept as a record and answers 409, as the webhook retry route
 * does: there is no current destination to send it to.
 *
 * Authentication: Admin only.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/api/errors';
import { getClientIP } from '@/lib/security/ip';
import { retryHookDelivery } from '@/lib/orchestration/hooks/registry';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { cuidSchema } from '@/lib/validations/common';

export const POST = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const clientIP = getClientIP(request);

  const { id } = await params;
  if (!cuidSchema.safeParse(id).success) {
    throw new ValidationError('Invalid delivery ID format');
  }

  const delivery = await prisma.aiEventHookDelivery.findUnique({
    where: { id },
    select: { hookId: true },
  });
  if (!delivery) throw new NotFoundError('Hook delivery not found');
  if (delivery.hookId === null) {
    throw new ConflictError(
      'The hook that sent this delivery was deleted; the delivery is kept as a record and cannot be retried'
    );
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
