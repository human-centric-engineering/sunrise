/**
 * Webhook Dispatcher
 *
 * Dispatches outbound webhook notifications for key orchestration events.
 * Queries active webhook subscriptions matching the event type and POSTs
 * the payload to each URL with HMAC-SHA256 signature verification.
 *
 * Delivery tracking: each dispatch creates an `AiWebhookDelivery` record
 * so admins can audit delivery history and manually retry failures.
 *
 * Retry strategy: 3 attempts with exponential backoff (10s, 60s, 300s).
 * Uses in-process `setTimeout`-based delayed retry — suitable for
 * single-server deployments. Future multi-server deployments can swap
 * to a Redis-backed queue without changing the public API.
 */

import { createHmac } from 'crypto';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';

const DISPATCH_TIMEOUT_MS = 5000;

/** Maximum delivery attempts (initial + retries). */
const MAX_ATTEMPTS = 3;

/** Backoff delays in milliseconds: 10s, 60s, 5min. */
const RETRY_DELAYS_MS = [10_000, 60_000, 300_000];

/**
 * Dispatch a webhook event to all active subscribers for the given event type.
 *
 * Creates a delivery record for each subscription, attempts delivery, and
 * schedules retries on failure. Errors are logged but never thrown.
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

    await Promise.allSettled(
      subscriptions.map(async (sub) => {
        // Create delivery record
        const delivery = await prisma.aiWebhookDelivery.create({
          data: {
            subscriptionId: sub.id,
            eventType,
            payload: {
              event: eventType,
              data: payload,
            } as unknown as import('@prisma/client').Prisma.InputJsonValue,
            status: 'pending',
          },
        });

        await attemptDelivery(delivery.id, sub.url, sub.secret, body);
      })
    );
  } catch (err) {
    logger.error('Webhook dispatch error', {
      eventType,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Retry a specific delivery. Used by the manual retry admin endpoint.
 */
export async function retryDelivery(deliveryId: string): Promise<boolean> {
  const delivery = await prisma.aiWebhookDelivery.findUnique({
    where: { id: deliveryId },
    include: { subscription: true },
  });

  if (!delivery) return false;

  // Reset status for retry
  await prisma.aiWebhookDelivery.update({
    where: { id: deliveryId },
    data: { status: 'pending', attempts: 0, lastError: null, nextRetryAt: null },
  });

  const body = JSON.stringify({
    event: delivery.eventType,
    timestamp: new Date().toISOString(),
    data: delivery.payload,
  });

  // Fire-and-forget — the attempt will update the delivery record
  void attemptDelivery(deliveryId, delivery.subscription.url, delivery.subscription.secret, body);

  return true;
}

/**
 * Process pending retries. Called on a timer or cron tick.
 * Picks up deliveries whose `nextRetryAt` has passed.
 */
export async function processPendingRetries(): Promise<number> {
  const pending = await prisma.aiWebhookDelivery.findMany({
    where: {
      status: 'failed',
      nextRetryAt: { lte: new Date() },
      attempts: { lt: MAX_ATTEMPTS },
    },
    include: { subscription: true },
    take: 50, // batch size to avoid overload
  });

  if (pending.length === 0) return 0;

  await Promise.allSettled(
    pending.map(async (delivery) => {
      const body = JSON.stringify({
        event: delivery.eventType,
        timestamp: new Date().toISOString(),
        data: delivery.payload,
      });

      await attemptDelivery(
        delivery.id,
        delivery.subscription.url,
        delivery.subscription.secret,
        body
      );
    })
  );

  return pending.length;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function attemptDelivery(
  deliveryId: string,
  url: string,
  secret: string,
  body: string
): Promise<void> {
  const now = new Date();
  let statusCode: number | undefined;
  let error: string | undefined;

  try {
    const signature = createHmac('sha256', secret).update(body).digest('hex');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DISPATCH_TIMEOUT_MS);

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Signature': signature,
          'X-Webhook-Event': (() => {
            const parsed = JSON.parse(body) as Record<string, unknown>;
            const event = parsed.event;
            return typeof event === 'string' ? event : '';
          })(),
        },
        body,
        signal: controller.signal,
      });

      statusCode = res.status;

      if (res.ok) {
        await prisma.aiWebhookDelivery.update({
          where: { id: deliveryId },
          data: {
            status: 'delivered',
            attempts: { increment: 1 },
            lastAttemptAt: now,
            lastResponseCode: statusCode,
            lastError: null,
            nextRetryAt: null,
          },
        });
        return;
      }

      error = `HTTP ${res.status}`;
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  // Delivery failed — update record and maybe schedule retry
  const delivery = await prisma.aiWebhookDelivery.findUnique({
    where: { id: deliveryId },
  });

  if (!delivery) return;

  const newAttempts = delivery.attempts + 1;
  const exhausted = newAttempts >= MAX_ATTEMPTS;

  const retryDelay = RETRY_DELAYS_MS[newAttempts - 1];
  const nextRetryAt = exhausted || !retryDelay ? null : new Date(Date.now() + retryDelay);

  await prisma.aiWebhookDelivery.update({
    where: { id: deliveryId },
    data: {
      status: exhausted ? 'exhausted' : 'failed',
      attempts: newAttempts,
      lastAttemptAt: now,
      lastResponseCode: statusCode ?? null,
      lastError: error ?? null,
      nextRetryAt,
    },
  });

  if (!exhausted && nextRetryAt) {
    // Schedule in-process retry via setTimeout
    const delay = retryDelay ?? RETRY_DELAYS_MS[0];
    scheduleRetry(deliveryId, url, delivery.subscriptionId, body, delay);
  }

  logger.warn('Webhook delivery failed', {
    deliveryId,
    url,
    attempt: newAttempts,
    maxAttempts: MAX_ATTEMPTS,
    exhausted,
    error,
    statusCode,
  });
}

/**
 * Schedule an in-process retry via setTimeout.
 *
 * The timeout is unref'd so it doesn't prevent Node from exiting.
 * If the process restarts before the retry fires, `processPendingRetries()`
 * will pick it up on the next tick.
 */
function scheduleRetry(
  deliveryId: string,
  _url: string,
  subscriptionId: string,
  body: string,
  delayMs: number
): void {
  const timer = setTimeout(
    () =>
      void (async () => {
        try {
          const sub = await prisma.aiWebhookSubscription.findUnique({
            where: { id: subscriptionId },
          });
          if (!sub || !sub.isActive) {
            // Subscription deactivated — mark delivery as exhausted
            await prisma.aiWebhookDelivery.update({
              where: { id: deliveryId },
              data: { status: 'exhausted', nextRetryAt: null },
            });
            return;
          }
          await attemptDelivery(deliveryId, sub.url, sub.secret, body);
        } catch (err) {
          logger.error('Webhook scheduled retry error', {
            deliveryId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      })(),
    delayMs
  );

  // Unref so the timer doesn't keep the process alive
  if (typeof timer === 'object' && 'unref' in timer) {
    timer.unref();
  }
}
