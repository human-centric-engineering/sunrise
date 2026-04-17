/**
 * Webhook Dispatcher
 *
 * Dispatches outbound webhook notifications for key orchestration events.
 * Queries active webhook subscriptions matching the event type and POSTs
 * the payload to each URL with HMAC-SHA256 signature verification.
 *
 * All dispatches are fire-and-forget with a 5s timeout — failures are
 * logged but never thrown.
 */

import { createHmac } from 'crypto';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';

const DISPATCH_TIMEOUT_MS = 5000;

/**
 * Dispatch a webhook event to all active subscribers for the given event type.
 *
 * This is fire-and-forget: errors are logged but never thrown, so callers
 * do not need to handle failures.
 */
export async function dispatchWebhookEvent(
  eventType: string,
  payload: Record<string, unknown>
): Promise<void> {
  try {
    const subscriptions = await prisma.aiWebhookSubscription.findMany({
      where: {
        isActive: true,
        events: { has: eventType },
      },
    });

    if (subscriptions.length === 0) return;

    const body = JSON.stringify({
      event: eventType,
      timestamp: new Date().toISOString(),
      data: payload,
    });

    const results = await Promise.allSettled(
      subscriptions.map(async (sub) => {
        const signature = createHmac('sha256', sub.secret).update(body).digest('hex');

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), DISPATCH_TIMEOUT_MS);

        try {
          const res = await fetch(sub.url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Webhook-Signature': signature,
              'X-Webhook-Event': eventType,
            },
            body,
            signal: controller.signal,
          });

          if (!res.ok) {
            logger.warn('Webhook delivery failed', {
              subscriptionId: sub.id,
              url: sub.url,
              eventType,
              statusCode: res.status,
            });
          }
        } finally {
          clearTimeout(timeout);
        }
      })
    );

    const failures = results.filter((r) => r.status === 'rejected');
    if (failures.length > 0) {
      logger.warn('Webhook dispatch failures', {
        eventType,
        total: subscriptions.length,
        failed: failures.length,
      });
    }
  } catch (err) {
    logger.error('Webhook dispatch error', {
      eventType,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
