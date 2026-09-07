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
import { checkSafeProviderUrl } from '@/lib/security/safe-url';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { NotFoundError } from '@/lib/api/errors';
import { validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { getClientIP } from '@/lib/security/ip';
import { cuidSchema } from '@/lib/validations/common';
import { updateWebhookSchema } from '@/lib/validations/orchestration';
import { ValidationError } from '@/lib/api/errors';
import { logAdminAction, computeChanges } from '@/lib/orchestration/audit/admin-audit-logger';

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
  maxAttempts: true,
  retryBackoffMs: true,
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
  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const parsed = cuidSchema.safeParse(rawId);
  if (!parsed.success)
    throw new ValidationError('Invalid webhook id', { id: ['Must be a valid CUID'] });

  const existing = await prisma.aiWebhookSubscription.findFirst({
    where: { id: parsed.data, createdBy: session.user.id },
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
    // Revalidate the DESTINATION, not just its presence.
    //
    // `updateWebhookSchema.url` is `.optional()`, so its `isSafeProviderUrl`
    // refine only runs when the patch actually carries a url. A patch that
    // merely sets `{ isActive: true, secret: '…' }` therefore activated a stored
    // url that nothing had ever checked — and the backup importer wrote exactly
    // such rows, inactive and secret-less, telling the admin to do precisely
    // that. Import a bundle naming `169.254.169.254`, follow the importer's own
    // instruction, and every subscribed event POSTs to cloud metadata.
    //
    // Checked here rather than only at import so rows written before the
    // importer's refine existed cannot be activated either.
    // Derived from the RESULTING ROW, not from the request body.
    //
    // Two earlier cuts of this were wrong in opposite directions. Checking every
    // webhook-channel patch blocked `PATCH { isActive: false }` — the one action
    // an operator needs when they find a bad row already live — leaving DELETE
    // as the only remedy. Checking only `body.isActive === true || 'url' in body`
    // then asked "does this request activate?" when the question is "can the row
    // emit to `nextUrl` once this patch lands?". Two things make it emit that
    // such a predicate never sees:
    //
    //   - a SECRET. `POST /webhooks/:id/test` fetches the stored url and gates
    //     only on a non-empty secret — `isActive` is not required. So
    //     `PATCH { secret }` alone armed an unsafe destination.
    //   - a CHANNEL flip. This whole branch is skipped while the row sits on
    //     `email`, so: flip to email, activate, flip back to webhook with a
    //     secret. Three patches, none carrying `isActive: true` or a `url`, and
    //     the row dispatches live to an address nothing ever checked.
    //
    // Both need a row whose stored url is unsafe — which is exactly the case
    // this guard exists for: bundles imported before the importer validated
    // destinations, whose own warning tells the operator to set a secret and
    // re-enable. Editing `description` on a row that is already active and
    // unsafe is now refused; deactivate first. That is the right trade.
    const nextIsActive = body.isActive ?? existing.isActive;
    const settingSecret = 'secret' in body && !!body.secret;
    if (nextIsActive || settingSecret || 'url' in body) {
      const urlCheck = checkSafeProviderUrl(nextUrl);
      if (!urlCheck.ok) {
        throw new ValidationError('URL is not allowed (private or internal address)', {
          url: [urlCheck.message],
        });
      }
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

  const webhook = await prisma.aiWebhookSubscription.update({
    where: { id: parsed.data },
    data: body,
    select: SAFE_SELECT,
  });

  log.info('Webhook updated', {
    webhookId: parsed.data,
    adminId: session.user.id,
  });

  logAdminAction({
    userId: session.user.id,
    action: 'webhook_subscription.update',
    entityType: 'webhook_subscription',
    entityId: parsed.data,
    entityName: (webhook.channel === 'webhook' ? webhook.url : webhook.emailAddress) ?? webhook.id,
    changes: computeChanges(existing, webhook, { ignoreKeys: ['updatedAt', 'createdAt'] }),
    clientIp: getClientIP(request),
  });

  return successResponse(webhook);
});

export const DELETE = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
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

  logAdminAction({
    userId: session.user.id,
    action: 'webhook_subscription.delete',
    entityType: 'webhook_subscription',
    entityId: parsed.data,
    entityName:
      (existing.channel === 'webhook' ? existing.url : existing.emailAddress) ?? parsed.data,
    clientIp: getClientIP(request),
  });

  return successResponse({ deleted: true });
});
