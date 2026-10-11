/**
 * Webhook Deliveries — List across subscriptions
 *
 * GET /api/v1/admin/orchestration/webhooks/deliveries
 *
 * Lists webhook deliveries in every status across the subscriptions the
 * calling admin may see — their own, plus those whose subscription was deleted
 * where the authorization policy permits an unattributed read
 * (`webhook-delivery-access.ts`). A delivery outlives its subscription as the
 * record of where an event went (§109 t-739); the per-subscription list
 * (`/webhooks/:id/deliveries`) cannot reach it once the subscription is gone,
 * and the dead-letter list shows only `exhausted` rows. This route reaches the
 * rest.
 *
 * Paginated; filterable by status, by subscription, and to deliveries whose
 * subscription was deleted (`orphaned=true`).
 *
 * Authentication: Admin only.
 */

import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { paginatedResponse } from '@/lib/api/responses';
import { ValidationError } from '@/lib/api/errors';
import { cuidSchema } from '@/lib/validations/common';
import { webhookDeliveryVisibilityWhere } from '@/lib/orchestration/access/webhook-delivery-access';

const querySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(['pending', 'delivered', 'failed', 'exhausted']).optional(),
  subscriptionId: cuidSchema.optional(),
  // A query string carries text, so `z.coerce.boolean()` would read "false"
  // as true; only the literal "true" selects orphans.
  orphaned: z.enum(['true', 'false']).optional(),
});

export const GET = withAdminAuth(async (request: NextRequest, session) => {
  const url = new URL(request.url);
  const parsed = querySchema.safeParse({
    page: url.searchParams.get('page') ?? undefined,
    pageSize: url.searchParams.get('pageSize') ?? undefined,
    status: url.searchParams.get('status') ?? undefined,
    subscriptionId: url.searchParams.get('subscriptionId') ?? undefined,
    orphaned: url.searchParams.get('orphaned') ?? undefined,
  });
  if (!parsed.success) {
    throw new ValidationError('Invalid query parameters', {
      fields: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    });
  }
  const query = parsed.data;
  if (query.subscriptionId && query.orphaned === 'true') {
    throw new ValidationError('subscriptionId and orphaned=true cannot both be set', {
      fields: ['orphaned: a delivery with a subscription is not orphaned'],
    });
  }

  const filters = {
    ...(query.status ? { status: query.status } : {}),
    ...(query.subscriptionId ? { subscriptionId: query.subscriptionId } : {}),
    ...(query.orphaned === 'true' ? { subscriptionId: null } : {}),
    ...(query.orphaned === 'false' && !query.subscriptionId
      ? { subscriptionId: { not: null } }
      : {}),
  };
  // AND, not a spread: the visibility fragment's key can be `OR`.
  const where = { AND: [webhookDeliveryVisibilityWhere(session), filters] };

  const [deliveries, total] = await Promise.all([
    prisma.aiWebhookDelivery.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      // Not the subscription's `url`: it can carry a credential, and the row's
      // own `destination` already says where the delivery went.
      include: { subscription: { select: { id: true, description: true } } },
    }),
    prisma.aiWebhookDelivery.count({ where }),
  ]);

  return paginatedResponse(deliveries, {
    page: query.page,
    limit: query.pageSize,
    total,
  });
});
