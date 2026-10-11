/**
 * Webhook Delivery — Manual Retry
 *
 * POST /api/v1/admin/orchestration/webhooks/deliveries/:id/retry
 *
 * Manually retries a failed or exhausted webhook delivery.
 * Resets the attempt counter and re-dispatches. A delivery whose
 * subscription was deleted is kept as a record and answers 409: there is
 * no current destination to send it to.
 *
 * Authentication: Admin only.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/api/errors';
import { getClientIP } from '@/lib/security/ip';
import { retryDelivery } from '@/lib/orchestration/webhooks/dispatcher';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { cuidSchema } from '@/lib/validations/common';
import { webhookDeliveryAccessBasis } from '@/lib/orchestration/access/webhook-delivery-access';

export const POST = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const clientIP = getClientIP(request);

  const { id: rawId } = await params;
  if (!cuidSchema.safeParse(rawId).success) {
    throw new ValidationError('Invalid delivery ID format');
  }
  const id = rawId;

  // Verify the delivery's parent subscription belongs to the calling admin
  const delivery = await prisma.aiWebhookDelivery.findUnique({
    where: { id },
    select: { subscription: { select: { createdBy: true } } },
  });
  if (!delivery || !webhookDeliveryAccessBasis(delivery, session)) {
    throw new NotFoundError('Webhook delivery not found');
  }
  if (!delivery.subscription) {
    throw new ConflictError(
      'The subscription that sent this delivery was deleted; the delivery is kept as a record and cannot be retried'
    );
  }

  const ok = await retryDelivery(id);
  if (!ok) throw new NotFoundError('Webhook delivery not found');

  logAdminAction({
    userId: session.user.id,
    action: 'webhook_delivery.retry',
    entityType: 'delivery',
    entityId: id,
    clientIp: clientIP,
  });

  return successResponse({ retried: true, deliveryId: id });
});
