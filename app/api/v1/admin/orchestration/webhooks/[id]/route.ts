/**
 * Admin Orchestration — Webhook subscription detail
 *
 * GET    /api/v1/admin/orchestration/webhooks/:id — get subscription
 * PATCH  /api/v1/admin/orchestration/webhooks/:id — update subscription
 * DELETE /api/v1/admin/orchestration/webhooks/:id — delete subscription
 *
 * Authentication: Admin role required.
 * Scoped to the calling user's own subscriptions, plus those whose creator was
 * erased where the authorization policy permits it (t-782).
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { NotFoundError } from '@/lib/api/errors';
import { validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { getClientIP } from '@/lib/security/ip';
import { cuidSchema } from '@/lib/validations/common';
import { updateWebhookSchema } from '@/lib/validations/orchestration';
import { ValidationError } from '@/lib/api/errors';
import { refuseErasedSubjects, WRITER_TRANSACTION_OPTIONS } from '@/lib/privacy/erased-subjects';
import { logAdminAction, computeChanges } from '@/lib/orchestration/audit/admin-audit-logger';
import { webhookSubscriptionVisibilityWhere } from '@/lib/orchestration/access/webhook-subscription-access';
import {
  auditableSubscriptionChanges,
  auditableSubscriptionName,
} from '@/lib/orchestration/webhooks/destination';

const SAFE_SELECT = {
  id: true,
  channel: true,
  url: true,
  emailAddress: true,
  events: true,
  agentIds: true,
  workflowIds: true,
  isActive: true,
  description: true,
  // Null once the creator is erased (t-782).
  createdBy: true,
  maxAttempts: true,
  retryBackoffMs: true,
  createdAt: true,
  updatedAt: true,
} as const;

export const GET = withAdminAuth<{ id: string }>(
  async (_request, session, { params }) => {
    const { id: rawId } = await params;
    const parsed = cuidSchema.safeParse(rawId);
    if (!parsed.success)
      throw new ValidationError('Invalid webhook id', { id: ['Must be a valid CUID'] });

    const webhook = await prisma.aiWebhookSubscription.findFirst({
      where: { AND: [webhookSubscriptionVisibilityWhere(session), { id: parsed.data }] },
      select: SAFE_SELECT,
    });
    if (!webhook) throw new NotFoundError('Webhook not found');

    return successResponse(webhook);
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

export const PATCH = withAdminAuth<{ id: string }>(
  async (request, session, { params }) => {
    const log = await getRouteLogger(request);
    const { id: rawId } = await params;
    const parsed = cuidSchema.safeParse(rawId);
    if (!parsed.success)
      throw new ValidationError('Invalid webhook id', { id: ['Must be a valid CUID'] });

    const existing = await prisma.aiWebhookSubscription.findFirst({
      where: { AND: [webhookSubscriptionVisibilityWhere(session), { id: parsed.data }] },
      select: SAFE_SELECT,
    });
    if (!existing) throw new NotFoundError('Webhook not found');

    const body = await validateRequestBody(request, updateWebhookSchema);

    // The Zod union allows any subset of channel-specific fields on PATCH.
    // Coherence check: if the patch flips the row's channel, the new
    // channel's destination must be present (either in the patch or
    // already on the row).
    const nextChannel = body.channel ?? existing.channel;
    if (nextChannel === 'webhook') {
      const nextUrl = 'url' in body ? body.url : existing.url;
      if (!nextUrl) {
        throw new ValidationError('Webhook channel requires a url', { url: ['url is required'] });
      }
      // Secret is allowed to remain unchanged on PATCH (existing flow:
      // empty `secret` = keep current). Only enforce presence on a fresh
      // channel switch from email → webhook where no secret was ever set.
      if (existing.channel !== 'webhook' && !('secret' in body)) {
        throw new ValidationError('Switching to webhook channel requires a secret', {
          secret: ['secret is required when changing channel to webhook'],
        });
      }
    } else if (nextChannel === 'email') {
      const nextEmail = 'emailAddress' in body ? body.emailAddress : existing.emailAddress;
      if (!nextEmail) {
        throw new ValidationError('Email channel requires an emailAddress', {
          emailAddress: ['emailAddress is required'],
        });
      }
    }

    // The edit form sends the address it loaded on every save, so a page
    // opened before a person was erased would restore their address and
    // re-activate the subscription erasure switched off (t-805). Refused under
    // the lock erasure takes.
    const webhook = await prisma.$transaction(async (tx) => {
      if ('emailAddress' in body && body.emailAddress) {
        await refuseErasedSubjects(tx, { addresses: [body.emailAddress] }, 'emailAddress');
      }
      // An email subscription kept without a new address relies on the one
      // it has — which an erasure may have cleared since `existing` was read
      // (review round 2). Conditional on the row still having one, so a stale
      // `{ isActive: true }` cannot re-activate what erasure switched off.
      if (nextChannel === 'email' && !('emailAddress' in body)) {
        const { count } = await tx.aiWebhookSubscription.updateMany({
          where: { id: parsed.data, emailAddress: { not: null } },
          data: body,
        });
        if (count === 0) {
          throw new ValidationError('Email channel requires an emailAddress', {
            emailAddress: ['This subscription has no address any more. Set one to save.'],
          });
        }
        return tx.aiWebhookSubscription.findUniqueOrThrow({
          where: { id: parsed.data },
          select: SAFE_SELECT,
        });
      }
      return tx.aiWebhookSubscription.update({
        where: { id: parsed.data },
        data: body,
        select: SAFE_SELECT,
      });
    }, WRITER_TRANSACTION_OPTIONS);

    log.info('Webhook updated', {
      webhookId: parsed.data,
      adminId: session.user.id,
    });

    logAdminAction({
      userId: session.user.id,
      action: 'webhook_subscription.update',
      entityType: 'webhook_subscription',
      entityId: parsed.data,
      entityName: auditableSubscriptionName(webhook),
      changes: auditableSubscriptionChanges(
        computeChanges(existing, webhook, { ignoreKeys: ['updatedAt', 'createdAt'] })
      ),
      clientIp: getClientIP(request),
    });

    return successResponse(webhook);
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

export const DELETE = withAdminAuth<{ id: string }>(
  async (request, session, { params }) => {
    const log = await getRouteLogger(request);
    const { id: rawId } = await params;
    const parsed = cuidSchema.safeParse(rawId);
    if (!parsed.success)
      throw new ValidationError('Invalid webhook id', { id: ['Must be a valid CUID'] });

    const existing = await prisma.aiWebhookSubscription.findFirst({
      where: { AND: [webhookSubscriptionVisibilityWhere(session), { id: parsed.data }] },
    });
    if (!existing) throw new NotFoundError('Webhook not found');

    await prisma.aiWebhookSubscription.delete({ where: { id: parsed.data } });

    log.info('Webhook deleted', {
      webhookId: parsed.data,
      adminId: session.user.id,
    });

    logAdminAction({
      userId: session.user.id,
      action: 'webhook_subscription.delete',
      entityType: 'webhook_subscription',
      entityId: parsed.data,
      entityName: auditableSubscriptionName(existing),
      clientIp: getClientIP(request),
    });

    return successResponse({ deleted: true });
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
