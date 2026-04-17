/**
 * Admin Orchestration — Webhook subscription detail
 *
 * GET    /api/v1/admin/orchestration/webhooks/:id — get subscription
 * PATCH  /api/v1/admin/orchestration/webhooks/:id — update subscription
 * DELETE /api/v1/admin/orchestration/webhooks/:id — delete subscription
 *
 * Authentication: Admin role required.
 * Scoped to the calling user's own subscriptions.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { NotFoundError } from '@/lib/api/errors';
import { validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { cuidSchema } from '@/lib/validations/common';
import { updateWebhookSchema } from '@/lib/validations/orchestration';
import { ValidationError } from '@/lib/api/errors';

const SAFE_SELECT = {
  id: true,
  url: true,
  events: true,
  isActive: true,
  description: true,
  createdAt: true,
  updatedAt: true,
} as const;

export const GET = withAdminAuth<{ id: string }>(async (_request, session, { params }) => {
  const { id: rawId } = await params;
  const parsed = cuidSchema.safeParse(rawId);
  if (!parsed.success)
    throw new ValidationError('Invalid webhook id', { id: ['Must be a valid CUID'] });

  const webhook = await prisma.aiWebhookSubscription.findFirst({
    where: { id: parsed.data, createdBy: session.user.id },
    select: SAFE_SELECT,
  });
  if (!webhook) throw new NotFoundError('Webhook not found');

  return successResponse(webhook);
});

export const PATCH = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const parsed = cuidSchema.safeParse(rawId);
  if (!parsed.success)
    throw new ValidationError('Invalid webhook id', { id: ['Must be a valid CUID'] });

  const existing = await prisma.aiWebhookSubscription.findFirst({
    where: { id: parsed.data, createdBy: session.user.id },
  });
  if (!existing) throw new NotFoundError('Webhook not found');

  const body = await validateRequestBody(request, updateWebhookSchema);

  const webhook = await prisma.aiWebhookSubscription.update({
    where: { id: parsed.data },
    data: body,
    select: SAFE_SELECT,
  });

  log.info('Webhook updated', {
    webhookId: parsed.data,
    adminId: session.user.id,
  });

  return successResponse(webhook);
});

export const DELETE = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const parsed = cuidSchema.safeParse(rawId);
  if (!parsed.success)
    throw new ValidationError('Invalid webhook id', { id: ['Must be a valid CUID'] });

  const existing = await prisma.aiWebhookSubscription.findFirst({
    where: { id: parsed.data, createdBy: session.user.id },
  });
  if (!existing) throw new NotFoundError('Webhook not found');

  await prisma.aiWebhookSubscription.delete({ where: { id: parsed.data } });

  log.info('Webhook deleted', {
    webhookId: parsed.data,
    adminId: session.user.id,
  });

  return successResponse({ deleted: true });
});
