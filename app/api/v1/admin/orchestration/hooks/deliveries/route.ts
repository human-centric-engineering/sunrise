/**
 * Event Hook Deliveries — List across hooks
 *
 * GET /api/v1/admin/orchestration/hooks/deliveries
 *
 * Lists event-hook deliveries across every hook, including those whose hook
 * was deleted. A delivery outlives its hook as the record of where an event
 * went (§109 t-739), and the per-hook list (`/hooks/:id/deliveries`) cannot
 * reach it once the hook is gone — this is the route that can.
 *
 * Paginated; filterable by status, by hook, and to deliveries whose hook was
 * deleted (`orphaned=true`). Hooks are admin-global — every admin reads every
 * hook's deliveries — so there is no owner clause here, unlike the webhook
 * dead-letter list.
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

const querySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(['pending', 'delivered', 'failed', 'exhausted']).optional(),
  hookId: cuidSchema.optional(),
  // A query string carries text, so `z.coerce.boolean()` would read "false"
  // as true; only the literal "true" selects orphans.
  orphaned: z.enum(['true', 'false']).optional(),
});

export const GET = withAdminAuth(async (request: NextRequest) => {
  const url = new URL(request.url);
  const parsed = querySchema.safeParse({
    page: url.searchParams.get('page') ?? undefined,
    pageSize: url.searchParams.get('pageSize') ?? undefined,
    status: url.searchParams.get('status') ?? undefined,
    hookId: url.searchParams.get('hookId') ?? undefined,
    orphaned: url.searchParams.get('orphaned') ?? undefined,
  });
  if (!parsed.success) {
    throw new ValidationError('Invalid query parameters', {
      fields: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    });
  }
  const query = parsed.data;
  if (query.hookId && query.orphaned === 'true') {
    throw new ValidationError('hookId and orphaned=true cannot both be set', {
      fields: ['orphaned: a delivery with a hook is not orphaned'],
    });
  }

  const where = {
    ...(query.status ? { status: query.status } : {}),
    ...(query.hookId ? { hookId: query.hookId } : {}),
    ...(query.orphaned === 'true' ? { hookId: null } : {}),
    ...(query.orphaned === 'false' && !query.hookId ? { hookId: { not: null } } : {}),
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
});
