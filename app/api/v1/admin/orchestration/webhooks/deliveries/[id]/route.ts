/**
 * Webhook Delivery — Detail / Delete
 *
 * DELETE /api/v1/admin/orchestration/webhooks/deliveries/:id
 *
 * Permanently removes a webhook delivery row. Used from the DLQ admin
 * page to discard exhausted deliveries an operator no longer wants to
 * keep around — the retention sweep handles bulk cleanup; this is the
 * targeted "I've reviewed this one, drop it" action.
 *
 * Authentication: Admin only. The delivery's parent subscription must
 * belong to the calling admin.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { cuidSchema } from '@/lib/validations/common';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';

export const DELETE = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const { id: rawId } = await params;
  if (!cuidSchema.safeParse(rawId).success) {
    throw new ValidationError('Invalid delivery ID format');
  }
  const id = rawId;

  // Verify ownership before deleting.
  const delivery = await prisma.aiWebhookDelivery.findUnique({
    where: { id },
    select: {
      id: true,
      status: true,
      eventType: true,
      subscription: { select: { id: true, createdBy: true, url: true } },
    },
  });
  if (!delivery || delivery.subscription.createdBy !== session.user.id) {
    throw new NotFoundError('Webhook delivery not found');
  }

  await prisma.aiWebhookDelivery.delete({ where: { id } });

  logAdminAction({
    userId: session.user.id,
    action: 'webhook_delivery.delete',
    entityType: 'delivery',
    entityId: id,
    entityName: delivery.subscription.url,
    metadata: { status: delivery.status, eventType: delivery.eventType },
    clientIp: clientIP,
  });

  return successResponse({ deleted: true, deliveryId: id });
});
