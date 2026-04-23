/**
 * Event Hook Deliveries — List
 *
 * GET /api/v1/admin/orchestration/hooks/:id/deliveries
 *
 * Lists delivery history for a specific event hook.
 * Paginated, filterable by status.
 *
 * Authentication: Admin only.
 */

import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { paginatedResponse } from '@/lib/api/responses';
import { NotFoundError, ValidationError } from '@/lib/api/errors';

const querySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(['pending', 'delivered', 'failed', 'exhausted']).optional(),
});

export const GET = withAdminAuth<{ id: string }>(
  async (request: NextRequest, _session, { params }) => {
    const { id } = await params;

    const hook = await prisma.aiEventHook.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!hook) throw new NotFoundError('Event hook not found');

    const url = new URL(request.url);
    const parsed = querySchema.safeParse({
      page: url.searchParams.get('page') ?? undefined,
      pageSize: url.searchParams.get('pageSize') ?? undefined,
      status: url.searchParams.get('status') ?? undefined,
    });
    if (!parsed.success) {
      throw new ValidationError('Invalid query parameters', {
        fields: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      });
    }
    const query = parsed.data;

    const where = {
      hookId: id,
      ...(query.status ? { status: query.status } : {}),
    };

    const [deliveries, total] = await Promise.all([
      prisma.aiEventHookDelivery.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      prisma.aiEventHookDelivery.count({ where }),
    ]);

    return paginatedResponse(deliveries, {
      page: query.page,
      limit: query.pageSize,
      total,
    });
  }
);
