/**
 * Webhook Deliveries — List
 *
 * GET /api/v1/admin/orchestration/webhooks/:id/deliveries
 *
 * Lists delivery history for a specific webhook subscription.
 * Paginated, filterable by status.
 *
 * Authentication: Admin only.
 */

import type { NextRequest } from 'next/server';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { NotFoundError } from '@/lib/api/errors';
import { z } from 'zod';

const querySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(['pending', 'delivered', 'failed', 'exhausted']).optional(),
});

export const GET = withAdminAuth<{ id: string }>(
  async (request: NextRequest, _session, { params }) => {
    const { id } = await params;

    const sub = await prisma.aiWebhookSubscription.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!sub) throw new NotFoundError('Webhook subscription not found');

    const url = new URL(request.url);
    const query = querySchema.parse({
      page: url.searchParams.get('page') ?? undefined,
      pageSize: url.searchParams.get('pageSize') ?? undefined,
      status: url.searchParams.get('status') ?? undefined,
    });

    const where = {
      subscriptionId: id,
      ...(query.status ? { status: query.status } : {}),
    };

    const [deliveries, total] = await Promise.all([
      prisma.aiWebhookDelivery.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      prisma.aiWebhookDelivery.count({ where }),
    ]);

    return successResponse(deliveries, {
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.ceil(total / query.pageSize),
    });
  }
);
