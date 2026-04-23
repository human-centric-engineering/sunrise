/**
 * Admin Orchestration — Event Hook Detail
 *
 * GET    /api/v1/admin/orchestration/hooks/:id  — get hook details
 * PATCH  /api/v1/admin/orchestration/hooks/:id  — update hook
 * DELETE /api/v1/admin/orchestration/hooks/:id  — delete hook
 *
 * Authentication: Admin role required.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
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
import { cuidSchema } from '@/lib/validations/common';
import { z } from 'zod';

const updateHookSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  eventType: z.enum(HOOK_EVENT_TYPES).optional(),
  action: z
    .object({
      type: z.literal('webhook'),
      url: z
        .string()
        .url()
        .refine(
          (url) => isSafeProviderUrl(url),
          'URL is not allowed (private or internal address)'
        ),
      headers: z
        .record(z.string(), z.string())
        .refine((h) => !hasReservedHookHeader(h), RESERVED_HEADER_ERROR)
        .optional(),
    })
    .optional(),
  filter: z.record(z.string(), z.unknown()).nullable().optional(),
  isEnabled: z.boolean().optional(),
});

function resolveHookId(rawId: string): string {
  const parsed = cuidSchema.safeParse(rawId);
  if (!parsed.success) {
    throw new ValidationError('Invalid hook id', { id: ['Must be a valid CUID'] });
  }
  return parsed.data;
}

export const GET = withAdminAuth<{ id: string }>(async (request, _session, { params }) => {
  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const id = resolveHookId(rawId);

  const hook = await prisma.aiEventHook.findUnique({ where: { id } });
  if (!hook) throw new NotFoundError(`Hook ${id} not found`);

  log.info('Event hook fetched', { hookId: id });
  return successResponse(toSafeHook(hook));
});

export const PATCH = withAdminAuth<{ id: string }>(async (request, _session, { params }) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const id = resolveHookId(rawId);

  const existing = await prisma.aiEventHook.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError(`Hook ${id} not found`);

  const body: unknown = await request.json();
  const parsed = updateHookSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError('Invalid hook update', {
      fields: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    });
  }

  const data: Record<string, unknown> = {};
  if (parsed.data.name !== undefined) data.name = parsed.data.name;
  if (parsed.data.eventType !== undefined) data.eventType = parsed.data.eventType;
  if (parsed.data.action !== undefined) data.action = parsed.data.action as Record<string, unknown>;
  if (parsed.data.filter !== undefined) data.filter = parsed.data.filter;
  if (parsed.data.isEnabled !== undefined) data.isEnabled = parsed.data.isEnabled;

  const updated = await prisma.aiEventHook.update({ where: { id }, data });

  invalidateHookCache();
  log.info('Event hook updated', { hookId: id });
  return successResponse(toSafeHook(updated));
});

export const DELETE = withAdminAuth<{ id: string }>(async (request, _session, { params }) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const id = resolveHookId(rawId);

  const existing = await prisma.aiEventHook.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError(`Hook ${id} not found`);

  await prisma.aiEventHook.delete({ where: { id } });

  invalidateHookCache();
  log.info('Event hook deleted', { hookId: id });
  return successResponse({ deleted: true });
});
