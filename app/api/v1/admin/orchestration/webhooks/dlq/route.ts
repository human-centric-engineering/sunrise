/**
 * Webhook Dead Letter Queue — List
 *
 * GET /api/v1/admin/orchestration/webhooks/dlq
 *
 * Lists all `exhausted` deliveries across the calling admin's
 * subscriptions. The single per-subscription delivery view does not
 * scale when an operator manages multiple subscriptions — partners
 * need one console to see what failed and why.
 *
 * Filterable by subscription, event type, and creation date range.
 * Paginated.
 *
 * Authentication: Admin only.
 */

import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { paginatedResponse } from '@/lib/api/responses';
import { ValidationError } from '@/lib/api/errors';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { cuidSchema } from '@/lib/validations/common';

const querySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  subscriptionId: cuidSchema.optional(),
  eventType: z.string().min(1).max(100).optional(),
  // ISO date strings — inclusive lower bound, exclusive upper bound.
  since: z.coerce.date().optional(),
  until: z.coerce.date().optional(),
});

export const GET = withAdminAuth(async (request: NextRequest, session) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const url = new URL(request.url);
  const parsed = querySchema.safeParse({
    page: url.searchParams.get('page') ?? undefined,
    pageSize: url.searchParams.get('pageSize') ?? undefined,
    subscriptionId: url.searchParams.get('subscriptionId') ?? undefined,
    eventType: url.searchParams.get('eventType') ?? undefined,
    since: url.searchParams.get('since') ?? undefined,
    until: url.searchParams.get('until') ?? undefined,
  });
  if (!parsed.success) {
    throw new ValidationError('Invalid query parameters', {
      fields: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    });
  }
  const query = parsed.data;

  const where = {
    status: 'exhausted' as const,
    subscription: { createdBy: session.user.id },
    ...(query.subscriptionId ? { subscriptionId: query.subscriptionId } : {}),
    ...(query.eventType ? { eventType: query.eventType } : {}),
    ...(query.since || query.until
      ? {
          createdAt: {
            ...(query.since ? { gte: query.since } : {}),
            ...(query.until ? { lt: query.until } : {}),
          },
        }
      : {}),
  };

  const [deliveries, total] = await Promise.all([
    prisma.aiWebhookDelivery.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      include: {
        subscription: {
          select: { id: true, url: true, description: true },
        },
      },
    }),
    prisma.aiWebhookDelivery.count({ where }),
  ]);

  return paginatedResponse(deliveries, {
    page: query.page,
    limit: query.pageSize,
    total,
  });
});
