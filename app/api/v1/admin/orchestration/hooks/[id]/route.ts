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
import { validateRequestBody } from '@/lib/api/validation';
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
import { logAdminAction, computeChanges } from '@/lib/orchestration/audit/admin-audit-logger';
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
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const id = resolveHookId(rawId);

  const hook = await prisma.aiEventHook.findUnique({ where: { id } });
  if (!hook) throw new NotFoundError(`Hook ${id} not found`);

  log.info('Event hook fetched', { hookId: id });
  return successResponse(toSafeHook(hook));
});

export const PATCH = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const id = resolveHookId(rawId);

  const existing = await prisma.aiEventHook.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError(`Hook ${id} not found`);

  const validated = await validateRequestBody(request, updateHookSchema);

  const data: Record<string, unknown> = {};
  if (validated.name !== undefined) data.name = validated.name;
  if (validated.eventType !== undefined) data.eventType = validated.eventType;
  if (validated.action !== undefined) data.action = validated.action as Record<string, unknown>;
  if (validated.filter !== undefined) data.filter = validated.filter;
  if (validated.isEnabled !== undefined) data.isEnabled = validated.isEnabled;

  const updated = await prisma.aiEventHook.update({ where: { id }, data });

  invalidateHookCache();
  log.info('Event hook updated', { hookId: id });

  logAdminAction({
    userId: session.user.id,
    action: 'hook.update',
    entityType: 'hook',
    entityId: id,
    entityName: updated.name,
    changes: computeChanges(
      existing as unknown as Record<string, unknown>,
      updated as unknown as Record<string, unknown>
    ),
    clientIp: getClientIP(request),
  });

  return successResponse(toSafeHook(updated));
});

export const DELETE = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
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

  logAdminAction({
    userId: session.user.id,
    action: 'hook.delete',
    entityType: 'hook',
    entityId: id,
    entityName: existing.name,
    clientIp: getClientIP(request),
  });

  return successResponse({ deleted: true });
});
