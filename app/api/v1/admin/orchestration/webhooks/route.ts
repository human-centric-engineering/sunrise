/**
 * Admin Orchestration — Webhook subscriptions
 *
 * GET  /api/v1/admin/orchestration/webhooks — list subscriptions
 * POST /api/v1/admin/orchestration/webhooks — create subscription
 *
 * Authentication: Admin role required.
 */

import type { Prisma } from '@prisma/client';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse, paginatedResponse } from '@/lib/api/responses';
import { validateRequestBody, validateQueryParams } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { createWebhookSchema, listWebhooksQuerySchema } from '@/lib/validations/orchestration';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';

export const GET = withAdminAuth(async (request, session) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);
  const { searchParams } = new URL(request.url);
  const { page, limit, isActive } = validateQueryParams(searchParams, listWebhooksQuerySchema);
  const skip = (page - 1) * limit;

  const where: Prisma.AiWebhookSubscriptionWhereInput = {
    createdBy: session.user.id,
  };
  if (isActive !== undefined) where.isActive = isActive;

  const [webhooks, total] = await Promise.all([
    prisma.aiWebhookSubscription.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
      select: {
        id: true,
        url: true,
        events: true,
        isActive: true,
        description: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { deliveries: true } },
      },
    }),
    prisma.aiWebhookSubscription.count({ where }),
  ]);

  log.info('Webhooks listed', { count: webhooks.length, total });

  return paginatedResponse(webhooks, { page, limit, total });
});

export const POST = withAdminAuth(async (request, session) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);
  const body = await validateRequestBody(request, createWebhookSchema);

  const webhook = await prisma.aiWebhookSubscription.create({
    data: {
      url: body.url,
      secret: body.secret,
      events: body.events,
      description: body.description,
      isActive: body.isActive ?? true,
      createdBy: session.user.id,
    },
    select: {
      id: true,
      url: true,
      events: true,
      isActive: true,
      description: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  log.info('Webhook created', {
    webhookId: webhook.id,
    url: webhook.url,
    events: webhook.events,
    adminId: session.user.id,
  });

  logAdminAction({
    userId: session.user.id,
    action: 'webhook_subscription.create',
    entityType: 'webhook_subscription',
    entityId: webhook.id,
    entityName: webhook.url,
    metadata: { events: webhook.events },
    clientIp: clientIP,
  });

  return successResponse(webhook, undefined, { status: 201 });
});
