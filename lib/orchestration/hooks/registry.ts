/**
 * Event Hook Registry & Dispatcher
 *
 * Loads enabled hooks from the database, caches them by event type,
 * and dispatches events to matching hooks.
 *
 * Hooks send JSON HTTP POST requests with any admin-supplied custom
 * headers. When the hook has a `secret` set, the body is signed with
 * HMAC-SHA256 and `X-Sunrise-Signature` / `X-Sunrise-Timestamp` headers
 * are added (see `./signing.ts`). Each webhook dispatch creates an
 * `AiEventHookDelivery` record so admins can audit delivery history and
 * manually retry failures. Retries follow the same backoff strategy as
 * outbound webhooks (10s, 60s, 300s; 3 attempts total).
 *
 * Dispatch is fire-and-forget — failures are logged and persisted to the
 * delivery table but never propagate to the caller.
 */

import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import {
  HookEventPayloadSchema,
  WebhookActionSchema,
  type HookAction,
  type HookEventPayload,
  type HookEventType,
  type HookFilter,
  type WebhookAction,
} from '@/lib/orchestration/hooks/types';
import {
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  signHookPayload,
} from '@/lib/orchestration/hooks/signing';

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
  secret: string | null;
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
    select: { id: true, eventType: true, action: true, filter: true, secret: true },
  });

  const byType = new Map<string, CachedHook[]>();

  for (const hook of hooks) {
    const parsedAction = WebhookActionSchema.safeParse(hook.action);
    if (!parsedAction.success) {
      logger.warn('Hook skipped: invalid action shape', {
        hookId: hook.id,
        issues: parsedAction.error.issues,
      });
      continue;
    }

    const cached: CachedHook = {
      id: hook.id,
      eventType: hook.eventType,
      action: parsedAction.data,
      filter: hook.filter as HookFilter | null,
      secret: hook.secret,
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
      void dispatchWebhook(hook.id, hook.action, hook.secret, payload);
    }
  }
}

async function dispatchWebhook(
  hookId: string,
  action: WebhookAction,
  secret: string | null,
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
    await attemptDelivery(delivery.id, action.url, action.headers ?? null, secret, payload);
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
 *
 * When `secret` is non-null, adds `X-Sunrise-Signature` +
 * `X-Sunrise-Timestamp` headers. The timestamp is fresh on each
 * attempt so consumers that reject stale signatures still accept
 * retries.
 */
async function attemptDelivery(
  deliveryId: string,
  url: string,
  customHeaders: Record<string, string> | null,
  secret: string | null,
  payload: HookEventPayload
): Promise<void> {
  const now = new Date();
  let statusCode: number | undefined;
  let error: string | undefined;

  try {
    const body = JSON.stringify(payload);
    const signingHeaders: Record<string, string> = {};
    if (secret) {
      const { timestamp, signature } = signHookPayload(secret, body);
      signingHeaders[TIMESTAMP_HEADER] = timestamp;
      signingHeaders[SIGNATURE_HEADER] = signature;
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Hook-Event': payload.eventType,
        ...signingHeaders,
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
 * Validate a stored delivery's `hook.action` and `payload` JSON before
 * re-dispatching. If either fails validation the delivery is marked
 * `exhausted` (malformed rows are not retriable) and `null` is returned.
 */
async function parseDeliveryForDispatch(delivery: {
  id: string;
  hook: { action: Prisma.JsonValue; secret: string | null };
  payload: Prisma.JsonValue;
}): Promise<{
  action: WebhookAction;
  payload: HookEventPayload;
  secret: string | null;
} | null> {
  const actionParsed = WebhookActionSchema.safeParse(delivery.hook.action);
  const payloadParsed = HookEventPayloadSchema.safeParse(delivery.payload);
  if (actionParsed.success && payloadParsed.success) {
    return {
      action: actionParsed.data,
      payload: payloadParsed.data,
      secret: delivery.hook.secret,
    };
  }

  const lastError = !actionParsed.success ? 'invalid_action' : 'invalid_payload';
  await prisma.aiEventHookDelivery.update({
    where: { id: delivery.id },
    data: { status: 'exhausted', nextRetryAt: null, lastError },
  });
  logger.warn('Hook delivery abandoned: invalid action or payload', {
    deliveryId: delivery.id,
    lastError,
  });
  return null;
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

          const parsed = await parseDeliveryForDispatch(delivery);
          if (!parsed) return;

          await attemptDelivery(
            deliveryId,
            parsed.action.url,
            parsed.action.headers ?? null,
            parsed.secret,
            parsed.payload
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

      const parsed = await parseDeliveryForDispatch(delivery);
      if (!parsed) return;

      await attemptDelivery(
        delivery.id,
        parsed.action.url,
        parsed.action.headers ?? null,
        parsed.secret,
        parsed.payload
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

  const parsed = await parseDeliveryForDispatch(delivery);
  if (!parsed) return false;

  await prisma.aiEventHookDelivery.update({
    where: { id: deliveryId },
    data: { status: 'pending', attempts: 0, lastError: null, nextRetryAt: null },
  });

  void attemptDelivery(
    deliveryId,
    parsed.action.url,
    parsed.action.headers ?? null,
    parsed.secret,
    parsed.payload
  );
  return true;
}
