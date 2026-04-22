/**
 * Event Hook Registry & Dispatcher
 *
 * Loads enabled hooks from the database, caches them by event type,
 * and dispatches events to matching hooks. Webhook hooks send plain
 * JSON HTTP POST requests with any admin-supplied custom headers —
 * payloads are not currently HMAC-signed. Internal hooks call
 * registered TypeScript handler functions.
 *
 * All dispatch is fire-and-forget — failures are logged but never
 * propagate to the caller.
 */

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import type {
  HookAction,
  HookEventPayload,
  HookEventType,
  HookFilter,
  InternalHandler,
  WebhookAction,
} from '@/lib/orchestration/hooks/types';

/** Cache TTL — reload hooks from DB every 60 seconds */
const CACHE_TTL_MS = 60_000;

interface CachedHook {
  id: string;
  eventType: string;
  action: HookAction;
  filter: HookFilter | null;
}

let hookCache: Map<string, CachedHook[]> | null = null;
let cacheLoadedAt = 0;

/** Registered internal handlers keyed by handler name */
const internalHandlers = new Map<string, InternalHandler>();

/**
 * Register an internal handler that can be referenced by event hooks.
 *
 * Call this at startup for any in-process hook handlers (e.g.,
 * analytics logging, cache invalidation).
 */
export function registerInternalHandler(name: string, handler: InternalHandler): void {
  internalHandlers.set(name, handler);
}

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
    } else if (hook.action.type === 'internal') {
      void dispatchInternal(hook.id, hook.action.handler, payload);
    }
  }
}

async function dispatchWebhook(
  hookId: string,
  action: WebhookAction,
  payload: HookEventPayload
): Promise<void> {
  try {
    const body = JSON.stringify(payload);
    const response = await fetch(action.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(action.headers ?? {}),
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      logger.warn('Hook webhook failed', {
        hookId,
        url: action.url,
        status: response.status,
      });
    }
  } catch (err: unknown) {
    logger.warn('Hook webhook error', {
      hookId,
      url: action.url,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function dispatchInternal(
  hookId: string,
  handlerName: string,
  payload: HookEventPayload
): Promise<void> {
  const handler = internalHandlers.get(handlerName);
  if (!handler) {
    logger.warn('Hook internal handler not found', { hookId, handler: handlerName });
    return;
  }

  try {
    await handler(payload);
  } catch (err: unknown) {
    logger.warn('Hook internal handler error', {
      hookId,
      handler: handlerName,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
