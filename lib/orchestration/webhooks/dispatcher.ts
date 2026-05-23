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
 * Retry strategy: configured per-subscription via `maxAttempts` +
 * `retryBackoffMs`. Defaults match the historical hardcoded values
 * (3 attempts, 10s/60s backoff). Uses in-process `setTimeout`-based
 * delayed retry — suitable for single-server deployments. Future
 * multi-server deployments can swap to a Redis-backed queue without
 * changing the public API.
 */

import { createHmac } from 'crypto';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';

const DISPATCH_TIMEOUT_MS = 5000;

/** Safely extract a JSON object from a Prisma Json field, falling back to empty object. */
function toJsonRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

/**
 * Fallback retry policy used when a subscription row is missing the new
 * `maxAttempts` / `retryBackoffMs` columns (defensive — Prisma defaults
 * mean this should never happen in practice).
 */
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_BACKOFF_MS = [10_000, 60_000, 300_000];

interface RetryPolicy {
  maxAttempts: number;
  retryBackoffMs: number[];
}

function resolveRetryPolicy(sub: {
  maxAttempts?: number | null;
  retryBackoffMs?: number[] | null;
}): RetryPolicy {
  return {
    maxAttempts: sub.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    retryBackoffMs:
      sub.retryBackoffMs && sub.retryBackoffMs.length > 0
        ? sub.retryBackoffMs
        : DEFAULT_RETRY_BACKOFF_MS,
  };
}

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

        await attemptDelivery(delivery.id, sub.url, sub.secret, body, resolveRetryPolicy(sub));
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
 *
 * By default the outbound HTTP attempt is fire-and-forget so the single-row
 * retry endpoint can return immediately (the receiver's response time isn't
 * in the request budget). Bulk replay opts into `awaitDelivery: true` so
 * its chunk-by-chunk `Promise.all` actually gates outbound HTTPs and the
 * stated concurrency cap holds.
 */
export async function retryDelivery(
  deliveryId: string,
  options?: { awaitDelivery?: boolean }
): Promise<boolean> {
  const delivery = await prisma.aiWebhookDelivery.findUnique({
    where: { id: deliveryId },
    include: { subscription: true },
  });

  if (!delivery) return false;

  // Reset status for retry
  await prisma.aiWebhookDelivery.update({
    where: { id: deliveryId },
    data: {
      status: 'pending',
      attempts: 0,
      lastError: null,
      nextRetryAt: null,
      lastAttemptAt: null,
      lastResponseCode: null,
    },
  });

  const storedPayload = toJsonRecord(delivery.payload);
  const body = JSON.stringify({
    ...storedPayload,
    timestamp: new Date().toISOString(),
  });

  const attempt = attemptDelivery(
    deliveryId,
    delivery.subscription.url,
    delivery.subscription.secret,
    body,
    resolveRetryPolicy(delivery.subscription)
  );

  if (options?.awaitDelivery) {
    await attempt;
  } else {
    // Fire-and-forget — the attempt will update the delivery record
    void attempt;
  }

  return true;
}

/**
 * Process pending retries. Called on a timer or cron tick.
 * Picks up deliveries whose `nextRetryAt` has passed.
 */
export async function processPendingRetries(): Promise<number> {
  // `status='failed'` already implies attempts < maxAttempts — the dispatcher
  // transitions to `exhausted` the moment the cap is hit, so no extra
  // `attempts < N` filter is needed (which would have been per-subscription
  // and not expressible as a single SQL predicate anyway).
  const pending = await prisma.aiWebhookDelivery.findMany({
    where: {
      status: 'failed',
      nextRetryAt: { lte: new Date() },
    },
    include: { subscription: true },
    take: 50, // batch size to avoid overload
  });

  if (pending.length === 0) return 0;

  await Promise.allSettled(
    pending.map(async (delivery) => {
      if (!delivery.subscription.isActive) {
        await prisma.aiWebhookDelivery.update({
          where: { id: delivery.id },
          data: { status: 'exhausted', nextRetryAt: null, lastError: 'Subscription deactivated' },
        });
        return;
      }

      const storedPayload = toJsonRecord(delivery.payload);
      const body = JSON.stringify({
        ...storedPayload,
        timestamp: new Date().toISOString(),
      });

      await attemptDelivery(
        delivery.id,
        delivery.subscription.url,
        delivery.subscription.secret,
        body,
        resolveRetryPolicy(delivery.subscription)
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
  body: string,
  policy: RetryPolicy
): Promise<void> {
  const now = new Date();
  let statusCode: number | undefined;
  let error: string | undefined;

  // Refuse to sign with an empty HMAC key: signatures would be forgeable by anyone who knows the URL.
  // Mark the delivery exhausted so it does not get retried until an admin sets a secret.
  if (!secret) {
    await prisma.aiWebhookDelivery.update({
      where: { id: deliveryId },
      data: {
        status: 'exhausted',
        attempts: { increment: 1 },
        lastAttemptAt: now,
        lastError: 'Subscription has no signing secret',
        nextRetryAt: null,
      },
    });
    logger.warn('Webhook delivery skipped: subscription has no signing secret', {
      deliveryId,
      url,
    });
    return;
  }

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
            const parsed = toJsonRecord(JSON.parse(body));
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
  const exhausted = newAttempts >= policy.maxAttempts;

  // After attempt N fails, the next delay is policy.retryBackoffMs[N-1].
  // If the array is shorter than maxAttempts-1, fall back to the last
  // configured delay so we never trip an out-of-bounds undefined.
  const backoffIndex = Math.min(newAttempts - 1, policy.retryBackoffMs.length - 1);
  const retryDelay = backoffIndex >= 0 ? policy.retryBackoffMs[backoffIndex] : undefined;
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

  if (!exhausted && nextRetryAt && retryDelay) {
    scheduleRetry(deliveryId, delivery.subscriptionId, retryDelay);
  }

  logger.warn('Webhook delivery failed', {
    deliveryId,
    url,
    attempt: newAttempts,
    maxAttempts: policy.maxAttempts,
    exhausted,
    error,
    statusCode,
  });
}

/**
 * Schedule an in-process retry via setTimeout.
 *
 * Re-reads the delivery and subscription from the DB so the retry uses
 * a fresh timestamp (for HMAC freshness) and the current subscription
 * URL/secret (in case they were updated between attempts).
 *
 * The timeout is unref'd so it doesn't prevent Node from exiting.
 * If the process restarts before the retry fires, `processPendingRetries()`
 * will pick it up on the next tick.
 */
function scheduleRetry(deliveryId: string, subscriptionId: string, delayMs: number): void {
  const timer = setTimeout(
    () =>
      void (async () => {
        try {
          const [delivery, sub] = await Promise.all([
            prisma.aiWebhookDelivery.findUnique({ where: { id: deliveryId } }),
            prisma.aiWebhookSubscription.findUnique({ where: { id: subscriptionId } }),
          ]);
          if (!delivery || !sub || !sub.isActive) {
            if (delivery) {
              await prisma.aiWebhookDelivery.update({
                where: { id: deliveryId },
                data: { status: 'exhausted', nextRetryAt: null },
              });
            }
            return;
          }
          const storedPayload = toJsonRecord(delivery.payload);
          const body = JSON.stringify({
            ...storedPayload,
            timestamp: new Date().toISOString(),
          });
          await attemptDelivery(deliveryId, sub.url, sub.secret, body, resolveRetryPolicy(sub));
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
