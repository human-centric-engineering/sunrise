/**
 * Event Hook Registry & Dispatcher
 *
 * Loads enabled hooks from the database, caches them by event type,
 * and dispatches events to matching hooks.
 *
 * Hooks send plain JSON HTTP POST requests with any admin-supplied
 * custom headers — payloads are not currently HMAC-signed. Each webhook
 * dispatch creates an `AiEventHookDelivery` record so admins can audit
 * delivery history and manually retry failures. Retries follow the same
 * backoff strategy as outbound webhooks (10s, 60s, 300s; 3 attempts total).
 *
 * Dispatch is fire-and-forget — failures are logged and persisted to the
 * delivery table but never propagate to the caller.
 */

import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import type {
  HookAction,
  HookEventPayload,
  HookEventType,
  HookFilter,
  WebhookAction,
} from '@/lib/orchestration/hooks/types';

/** Cache TTL — reload hooks from DB every 60 seconds */
const CACHE_TTL_MS = 60_000;

/** Outbound HTTP timeout for webhook delivery */
const DISPATCH_TIMEOUT_MS = 10_000;

/** Maximum delivery attempts (initial + retries). */
const MAX_ATTEMPTS = 3;

/** Backoff delays in milliseconds: 10s, 60s, 5min. */
const RETRY_DELAYS_MS = [10_000, 60_000, 300_000];

interface CachedHook {
  id: string;
  eventType: string;
  action: HookAction;
  filter: HookFilter | null;
}

let hookCache: Map<string, CachedHook[]> | null = null;
let cacheLoadedAt = 0;

/**
 * Load enabled hooks from the database, grouped by event type.
 * Results are cached for CACHE_TTL_MS.
 */
async function loadHooks(): Promise<Map<string, CachedHook[]>> {
  const now = Date.now();
  if (hookCache && now - cacheLoadedAt < CACHE_TTL_MS) {
    return hookCache;
  }

  const hooks = await prisma.aiEventHook.findMany({
    where: { isEnabled: true },
    select: { id: true, eventType: true, action: true, filter: true },
  });

  const byType = new Map<string, CachedHook[]>();

  for (const hook of hooks) {
    const action = hook.action as unknown;
    if (!action || typeof action !== 'object' || !('type' in (action as Record<string, unknown>))) {
      continue;
    }

    const cached: CachedHook = {
      id: hook.id,
      eventType: hook.eventType,
      action: action as HookAction,
      filter: hook.filter as HookFilter | null,
    };

    const list = byType.get(hook.eventType) ?? [];
    list.push(cached);
    byType.set(hook.eventType, list);
  }

  hookCache = byType;
  cacheLoadedAt = now;
  return byType;
}

/** Invalidate the hook cache (e.g., after CRUD operations). */
export function invalidateHookCache(): void {
  hookCache = null;
  cacheLoadedAt = 0;
}

/**
 * Check whether an event payload matches a hook's filter criteria.
 * If no filter is set, the hook matches all events of its type.
 */
function matchesFilter(filter: HookFilter | null, payload: HookEventPayload): boolean {
  if (!filter) return true;

  for (const [key, value] of Object.entries(filter)) {
    if (value === undefined || value === null) continue;
    if (payload.data[key] !== value) {
      return false;
    }
  }
  return true;
}

/**
 * Emit a hook event. All matching enabled hooks are dispatched
 * asynchronously — this function returns immediately.
 *
 * @param eventType - The event type to emit
 * @param data - Event-specific payload data
 */
export function emitHookEvent(eventType: HookEventType, data: Record<string, unknown>): void {
  const payload: HookEventPayload = {
    eventType,
    timestamp: new Date().toISOString(),
    data,
  };

  void dispatchToHooks(payload).catch((err: unknown) => {
    logger.warn('Hook dispatch error', {
      eventType,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

async function dispatchToHooks(payload: HookEventPayload): Promise<void> {
  const byType = await loadHooks();
  const hooks = byType.get(payload.eventType) ?? [];

  for (const hook of hooks) {
    if (!matchesFilter(hook.filter, payload)) continue;

    if (hook.action.type === 'webhook') {
      void dispatchWebhook(hook.id, hook.action, payload);
    }
  }
}

async function dispatchWebhook(
  hookId: string,
  action: WebhookAction,
  payload: HookEventPayload
): Promise<void> {
  try {
    const delivery = await prisma.aiEventHookDelivery.create({
      data: {
        hookId,
        eventType: payload.eventType,
        payload: payload as unknown as Prisma.InputJsonValue,
        status: 'pending',
      },
    });
    await attemptDelivery(delivery.id, action.url, action.headers ?? null, payload);
  } catch (err: unknown) {
    logger.warn('Hook webhook dispatch setup failed', {
      hookId,
      url: action.url,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Attempt a single webhook delivery, updating the `AiEventHookDelivery`
 * record with the outcome. On failure, schedules an in-process retry
 * via setTimeout (up to MAX_ATTEMPTS total).
 */
async function attemptDelivery(
  deliveryId: string,
  url: string,
  customHeaders: Record<string, string> | null,
  payload: HookEventPayload
): Promise<void> {
  const now = new Date();
  let statusCode: number | undefined;
  let error: string | undefined;

  try {
    const body = JSON.stringify(payload);
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Hook-Event': payload.eventType,
        ...(customHeaders ?? {}),
      },
      body,
      signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
    });

    statusCode = res.status;

    if (res.ok) {
      await prisma.aiEventHookDelivery.update({
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
  } catch (err: unknown) {
    error = err instanceof Error ? err.message : String(err);
  }

  // Delivery failed — update record and maybe schedule retry
  const delivery = await prisma.aiEventHookDelivery.findUnique({
    where: { id: deliveryId },
  });
  if (!delivery) return;

  const newAttempts = delivery.attempts + 1;
  const exhausted = newAttempts >= MAX_ATTEMPTS;
  const retryDelay = RETRY_DELAYS_MS[newAttempts - 1];
  const nextRetryAt = exhausted || !retryDelay ? null : new Date(Date.now() + retryDelay);

  await prisma.aiEventHookDelivery.update({
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
    scheduleRetry(deliveryId, retryDelay ?? RETRY_DELAYS_MS[0]);
  }

  logger.warn('Hook webhook delivery failed', {
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
 * The timeout is unref'd so it doesn't prevent Node from exiting. If the
 * process restarts before the retry fires, `processPendingHookRetries()`
 * picks it up on the next maintenance tick.
 */
function scheduleRetry(deliveryId: string, delayMs: number): void {
  const timer = setTimeout(
    () =>
      void (async () => {
        try {
          const delivery = await prisma.aiEventHookDelivery.findUnique({
            where: { id: deliveryId },
            include: { hook: true },
          });
          if (!delivery || !delivery.hook.isEnabled) {
            if (delivery) {
              await prisma.aiEventHookDelivery.update({
                where: { id: deliveryId },
                data: { status: 'exhausted', nextRetryAt: null },
              });
            }
            return;
          }

          const action = delivery.hook.action as unknown;
          if (
            !action ||
            typeof action !== 'object' ||
            (action as Record<string, unknown>).type !== 'webhook'
          ) {
            return;
          }
          const webhookAction = action as WebhookAction;

          await attemptDelivery(
            deliveryId,
            webhookAction.url,
            webhookAction.headers ?? null,
            delivery.payload as unknown as HookEventPayload
          );
        } catch (err: unknown) {
          logger.error('Hook scheduled retry error', {
            deliveryId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      })(),
    delayMs
  );

  if (typeof timer === 'object' && 'unref' in timer) {
    timer.unref();
  }
}

/**
 * Process pending hook-delivery retries. Called on a maintenance tick.
 * Picks up deliveries whose `nextRetryAt` has passed.
 */
export async function processPendingHookRetries(): Promise<number> {
  const pending = await prisma.aiEventHookDelivery.findMany({
    where: {
      status: 'failed',
      nextRetryAt: { lte: new Date() },
      attempts: { lt: MAX_ATTEMPTS },
    },
    include: { hook: true },
    take: 50,
  });

  if (pending.length === 0) return 0;

  await Promise.allSettled(
    pending.map(async (delivery) => {
      if (!delivery.hook.isEnabled) {
        await prisma.aiEventHookDelivery.update({
          where: { id: delivery.id },
          data: { status: 'exhausted', nextRetryAt: null },
        });
        return;
      }

      const action = delivery.hook.action as unknown;
      if (
        !action ||
        typeof action !== 'object' ||
        (action as Record<string, unknown>).type !== 'webhook'
      ) {
        return;
      }
      const webhookAction = action as WebhookAction;

      await attemptDelivery(
        delivery.id,
        webhookAction.url,
        webhookAction.headers ?? null,
        delivery.payload as unknown as HookEventPayload
      );
    })
  );

  return pending.length;
}

/**
 * Manually retry a specific hook delivery. Resets the attempt counter so
 * admin-initiated retries get a fresh set of retry attempts.
 *
 * Returns `false` if the delivery does not exist or its hook is disabled
 * or no longer a webhook action.
 */
export async function retryHookDelivery(deliveryId: string): Promise<boolean> {
  const delivery = await prisma.aiEventHookDelivery.findUnique({
    where: { id: deliveryId },
    include: { hook: true },
  });
  if (!delivery) return false;
  if (!delivery.hook.isEnabled) return false;

  const action = delivery.hook.action as unknown;
  if (
    !action ||
    typeof action !== 'object' ||
    (action as Record<string, unknown>).type !== 'webhook'
  ) {
    return false;
  }
  const webhookAction = action as WebhookAction;

  await prisma.aiEventHookDelivery.update({
    where: { id: deliveryId },
    data: { status: 'pending', attempts: 0, lastError: null, nextRetryAt: null },
  });

  void attemptDelivery(
    deliveryId,
    webhookAction.url,
    webhookAction.headers ?? null,
    delivery.payload as unknown as HookEventPayload
  );
  return true;
}
