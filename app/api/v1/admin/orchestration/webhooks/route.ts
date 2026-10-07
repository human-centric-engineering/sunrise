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
import { loggableUrl } from '@/lib/logging/redact-path';
import { getClientIP } from '@/lib/security/ip';
import { createWebhookSchema, listWebhooksQuerySchema } from '@/lib/validations/orchestration';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';

export const GET = withAdminAuth(async (request, session) => {
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
        channel: true,
        url: true,
        emailAddress: true,
        events: true,
        agentIds: true,
        workflowIds: true,
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

  const log = await getRouteLogger(request);
  const body = await validateRequestBody(request, createWebhookSchema);

  // The Zod schema is a discriminated-ish union: `webhook` branches
  // carry url + secret, `email` branches carry emailAddress. Pull each
  // channel's fields off the body with a type narrow rather than
  // destructuring through a union shape.
  const createData: Prisma.AiWebhookSubscriptionUncheckedCreateInput = {
    channel: body.channel,
    events: body.events,
    description: body.description,
    isActive: body.isActive ?? true,
    maxAttempts: body.maxAttempts,
    retryBackoffMs: body.retryBackoffMs,
    agentIds: body.agentIds ?? [],
    workflowIds: body.workflowIds ?? [],
    createdBy: session.user.id,
  };
  if (body.channel === 'webhook') {
    createData.url = body.url;
    createData.secret = body.secret;
  } else {
    createData.emailAddress = body.emailAddress;
  }

  const webhook = await prisma.aiWebhookSubscription.create({
    data: createData,
    select: {
      id: true,
      channel: true,
      url: true,
      emailAddress: true,
      events: true,
      agentIds: true,
      workflowIds: true,
      isActive: true,
      description: true,
      maxAttempts: true,
      retryBackoffMs: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  log.info('Webhook created', {
    webhookId: webhook.id,
    channel: webhook.channel,
    destination: webhook.channel === 'webhook' ? loggableUrl(webhook.url) : webhook.emailAddress,
    events: webhook.events,
    adminId: session.user.id,
  });

  logAdminAction({
    userId: session.user.id,
    action: 'webhook_subscription.create',
    entityType: 'webhook_subscription',
    entityId: webhook.id,
    entityName: (webhook.channel === 'webhook' ? webhook.url : webhook.emailAddress) ?? webhook.id,
    metadata: { channel: webhook.channel, events: webhook.events },
    clientIp: clientIP,
  });

  return successResponse(webhook, undefined, { status: 201 });
});
