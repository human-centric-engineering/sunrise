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
import { auditableSubscriptionName } from '@/lib/orchestration/webhooks/destination';
import { getClientIP } from '@/lib/security/ip';
import { createWebhookSchema, listWebhooksQuerySchema } from '@/lib/validations/orchestration';
import { subscriptionVersion } from '@/lib/orchestration/config-versions';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { webhookSubscriptionVisibilityWhere } from '@/lib/orchestration/access/webhook-subscription-access';

export const GET = withAdminAuth(
  async (request, session) => {
    const log = await getRouteLogger(request);
    const { searchParams } = new URL(request.url);
    const { page, limit, isActive } = validateQueryParams(searchParams, listWebhooksQuerySchema);
    const skip = (page - 1) * limit;

    // The caller's own subscriptions, plus those whose creator was erased
    // where the policy permits it (t-782). `AND`, so the filter cannot
    // flatten the visibility clause.
    const where: Prisma.AiWebhookSubscriptionWhereInput = {
      AND: [
        webhookSubscriptionVisibilityWhere(session),
        ...(isActive !== undefined ? [{ isActive }] : []),
      ],
    };

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
          // Null once the creator is erased (t-782): the list marks it.
          createdBy: true,
          createdAt: true,
          updatedAt: true,
          _count: { select: { deliveries: true } },
          // The rest of what the version covers (§122 t-899).
          maxAttempts: true,
          retryBackoffMs: true,
        },
      }),
      prisma.aiWebhookSubscription.count({ where }),
    ]);

    log.info('Webhooks listed', { count: webhooks.length, total });

    // Each row's version, for a save from the list (the active toggle) to
    // send as If-Match (§122 t-899).
    const rows = webhooks.map((row) => ({ ...row, version: subscriptionVersion(row) }));
    return paginatedResponse(rows, { page, limit, total });
  },
  {
    tier: 'org',
    ownership: {
      decidedBy: 'self',
      because:
        "Subscriptions are scoped to the admin who created them (one whose creator was erased only where the policy permits that orphan) and deliveries through their subscription (an orphaned delivery only where the policy permits it), keyed on the caller's id. Never another member's.",
    },
  }
);

export const POST = withAdminAuth(
  async (request, session) => {
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

    // A create is new intent, not a copy of anything stored, so an address an
    // admin types is saved even if its owner was once erased (§122 t-899).
    const webhook = await prisma.aiWebhookSubscription
      .create({
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
      })
      .then((row) => ({ ...row, version: subscriptionVersion(row) }));

    log.info('Webhook created', {
      webhookId: webhook.id,
      channel: webhook.channel,
      // A webhook's reduced URL; never an email subscriber's address (t-785).
      ...(webhook.channel === 'webhook' && { destination: loggableUrl(webhook.url) }),
      events: webhook.events,
      adminId: session.user.id,
    });

    logAdminAction({
      userId: session.user.id,
      action: 'webhook_subscription.create',
      entityType: 'webhook_subscription',
      entityId: webhook.id,
      entityName: auditableSubscriptionName(webhook),
      metadata: { channel: webhook.channel, events: webhook.events },
      clientIp: clientIP,
    });

    return successResponse(webhook, undefined, { status: 201 });
  },
  {
    tier: 'org',
    ownership: {
      decidedBy: 'self',
      because:
        "Subscriptions are scoped to the admin who created them (one whose creator was erased only where the policy permits that orphan) and deliveries through their subscription (an orphaned delivery only where the policy permits it), keyed on the caller's id. Never another member's.",
    },
  }
);
