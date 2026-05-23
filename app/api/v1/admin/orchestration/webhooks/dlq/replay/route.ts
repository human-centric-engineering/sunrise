/**
 * Webhook Dead Letter Queue — Bulk Replay
 *
 * POST /api/v1/admin/orchestration/webhooks/dlq/replay
 *
 * Re-dispatches a batch of exhausted deliveries. Two body shapes:
 *   { deliveryIds: string[] }            // explicit selection from the UI
 *   { subscriptionId, before? }          // replay everything for one
 *                                        // subscription, optionally
 *                                        // capped by createdAt < before
 *
 * Internally loops `retryDelivery()` with a concurrency cap so we don't
 * stampede the receiver — even if the operator hit "replay all" on a
 * thousand-row backlog, we trickle them through.
 *
 * Authentication: Admin only. Every targeted delivery must belong to
 * one of the caller's subscriptions; mismatches are skipped silently
 * so a partial selection doesn't 403 the whole batch.
 */

import { z } from 'zod';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { ValidationError } from '@/lib/api/errors';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { cuidSchema } from '@/lib/validations/common';
import { retryDelivery } from '@/lib/orchestration/webhooks/dispatcher';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';

/** Cap concurrent in-flight retries so a large batch doesn't burst on the receiver. */
const REPLAY_CONCURRENCY = 5;
/** Hard cap on a single batch — operators can paginate beyond this. */
const REPLAY_MAX_ROWS = 500;

const bodySchema = z.union([
  z.object({
    deliveryIds: z.array(cuidSchema).min(1).max(REPLAY_MAX_ROWS),
  }),
  z.object({
    subscriptionId: cuidSchema,
    before: z.coerce.date().optional(),
  }),
]);

export const POST = withAdminAuth(async (request, session) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const raw = (await request.json().catch(() => null)) as unknown;
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError('Invalid replay request body', {
      fields: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    });
  }
  const body = parsed.data;

  const ids = await resolveTargetIds(body, session.user.id);

  const replayed: string[] = [];
  const skipped: string[] = [];

  for (let i = 0; i < ids.length; i += REPLAY_CONCURRENCY) {
    const slice = ids.slice(i, i + REPLAY_CONCURRENCY);
    // `awaitDelivery: true` so the chunked `Promise.all` actually gates the
    // outbound HTTP — without it, retryDelivery resolves after the DB reset
    // and the receiver still gets the whole batch in parallel.
    const results = await Promise.all(
      slice.map(async (id) => {
        const ok = await retryDelivery(id, { awaitDelivery: true });
        return { id, ok };
      })
    );
    for (const { id, ok } of results) (ok ? replayed : skipped).push(id);
  }

  logAdminAction({
    userId: session.user.id,
    action: 'webhook_delivery.replay_batch',
    entityType: 'webhook_subscription',
    entityId: 'subscriptionId' in body ? body.subscriptionId : 'multi',
    metadata: { replayed: replayed.length, skipped: skipped.length },
    clientIp: clientIP,
  });

  return successResponse({
    replayed: replayed.length,
    skipped: skipped.length,
    deliveryIds: replayed,
  });
});

async function resolveTargetIds(
  body: { deliveryIds: string[] } | { subscriptionId: string; before?: Date },
  userId: string
): Promise<string[]> {
  if ('deliveryIds' in body) {
    // Ownership filter — only return rows whose parent subscription the
    // caller owns. Mismatches just drop from the set; we don't 403 the
    // whole batch over one stale ID.
    const owned = await prisma.aiWebhookDelivery.findMany({
      where: {
        id: { in: body.deliveryIds },
        subscription: { createdBy: userId },
      },
      select: { id: true },
    });
    return owned.map((d) => d.id);
  }

  const subscription = await prisma.aiWebhookSubscription.findFirst({
    where: { id: body.subscriptionId, createdBy: userId },
    select: { id: true },
  });
  if (!subscription) return [];

  const rows = await prisma.aiWebhookDelivery.findMany({
    where: {
      subscriptionId: body.subscriptionId,
      status: 'exhausted',
      ...(body.before ? { createdAt: { lt: body.before } } : {}),
    },
    select: { id: true },
    take: REPLAY_MAX_ROWS,
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((r) => r.id);
}
