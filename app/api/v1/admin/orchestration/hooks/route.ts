/**
 * Admin Orchestration — Event Hooks
 *
 * GET  /api/v1/admin/orchestration/hooks     — list all hooks
 * POST /api/v1/admin/orchestration/hooks     — create a new hook
 *
 * Authentication: Admin role required.
 */

import type { Prisma } from '@prisma/client';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse, paginatedResponse } from '@/lib/api/responses';
import { ValidationError } from '@/lib/api/errors';
import { getRouteLogger } from '@/lib/api/context';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { invalidateHookCache } from '@/lib/orchestration/hooks/registry';
import { toSafeHook } from '@/lib/orchestration/hooks/serialize';
import {
  HOOK_EVENT_TYPES,
  RESERVED_HEADER_ERROR,
  hasReservedHookHeader,
} from '@/lib/orchestration/hooks/types';
import { isSafeProviderUrl } from '@/lib/security/safe-url';
import { z } from 'zod';

const createHookSchema = z.object({
  name: z.string().min(1).max(200),
  eventType: z.enum(HOOK_EVENT_TYPES),
  action: z.object({
    type: z.literal('webhook'),
    url: z
      .string()
      .url()
      .refine((url) => isSafeProviderUrl(url), 'URL is not allowed (private or internal address)'),
    headers: z
      .record(z.string(), z.string())
      .refine((h) => !hasReservedHookHeader(h), RESERVED_HEADER_ERROR)
      .optional(),
  }),
  filter: z.record(z.string(), z.unknown()).nullable().optional(),
  isEnabled: z.boolean().optional().default(true),
});

export const GET = withAdminAuth(async (request, _session) => {
  const log = await getRouteLogger(request);
  const { searchParams } = new URL(request.url);
  const page = Math.max(1, Number(searchParams.get('page') ?? 1));
  const limit = Math.min(100, Math.max(1, Number(searchParams.get('limit') ?? 20)));
  const eventType = searchParams.get('eventType');

  const where = eventType ? { eventType } : {};

  const [hooks, total] = await Promise.all([
    prisma.aiEventHook.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.aiEventHook.count({ where }),
  ]);

  log.info('Event hooks listed', { count: hooks.length, total });
  return paginatedResponse(hooks.map(toSafeHook), { page, limit, total });
});

export const POST = withAdminAuth(async (request, session) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);
  const body: unknown = await request.json();

  const parsed = createHookSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError('Invalid hook configuration', {
      fields: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    });
  }

  const { name, eventType, action, filter, isEnabled } = parsed.data;

  const hook = await prisma.aiEventHook.create({
    data: {
      name,
      eventType,
      action: action as unknown as Prisma.InputJsonValue,
      filter: (filter ?? undefined) as Prisma.InputJsonValue | undefined,
      isEnabled,
      createdBy: session.user.id,
    },
  });

  invalidateHookCache();
  log.info('Event hook created', { hookId: hook.id, eventType });

  return successResponse(toSafeHook(hook), undefined, { status: 201 });
});
