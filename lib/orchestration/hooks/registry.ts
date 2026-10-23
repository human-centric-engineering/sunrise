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
 * manually retry failures. The record carries where it was sent and outlives
 * its hook (§109 t-739; see `webhooks/destination.ts`). Retries follow the
 * same backoff strategy as outbound webhooks (10s, 60s, 300s; 3 attempts
 * total).
 *
 * Dispatch is fire-and-forget — failures are logged and persisted to the
 * delivery table but never propagate to the caller.
 *
 * Tenancy posture: org-keyed — `hookCacheByOrg`, because `eventType` is a
 * label two orgs share (lib/tenancy/process-state.ts).
 */

import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { keepRunningAfterResponse } from '@/lib/api/after-response';
import { loggableUrl } from '@/lib/logging/redact-path';
import { describeFetchFailure } from '@/lib/errors/fetch-error';
import {
  HookEventPayloadSchema,
  WebhookActionSchema,
  type HookAction,
  type HookEventPayload,
  type HookEventType,
  type HookFilter,
  HookFilterSchema,
  type WebhookAction,
} from '@/lib/orchestration/hooks/types';
import {
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  signHookPayload,
} from '@/lib/orchestration/hooks/signing';
import { noteMaintenanceWork } from '@/lib/orchestration/maintenance/idle-gate';
import {
  AWAITING_RETRY_STATUSES,
  DISPATCH_TIMEOUT_MS,
  SUBJECT_ERASED,
  checkFailureUncounted,
  claimArmedRetry,
  isArmedRetry,
  logSettledInFlight,
  notRetried,
} from '@/lib/orchestration/webhooks/not-retried';
import {
  describeDestination,
  destinationUpdate,
  type DeliveryLike,
} from '@/lib/orchestration/webhooks/destination';
import {
  decideDeliveryUnderLocks,
  resolveFanOutSubjects,
  settleStoppedDelivery,
} from '@/lib/privacy/stale-sends';
import type { PayloadSubjects } from '@/lib/privacy/delivery-payloads';
import { requireTenantContext } from '@/lib/tenancy/context';

/** Cache TTL — reload hooks from DB every 60 seconds */
const CACHE_TTL_MS = 60_000;

/** Maximum delivery attempts (initial + retries). */
const MAX_ATTEMPTS = 3;

/** Backoff delays in milliseconds: 10s, 60s, 5min. */
const RETRY_DELAYS_MS = [10_000, 60_000, 300_000];

/** Why a retry stopped when its hook was deleted in the meantime. */
const HOOK_DELETED = 'hook deleted';

interface CachedHook {
  id: string;
  eventType: string;
  action: HookAction;
  filter: HookFilter | null;
  secret: string | null;
}

interface OrgHookCache {
  byType: Map<string, CachedHook[]>;
  loadedAt: number;
}

/**
 * The hook cache, **per org** (§108 t-712).
 *
 * `AiEventHook` is tenant-owned and `eventType` is a label two orgs both use,
 * so one process-wide map keyed by event type served whichever org refreshed
 * it last to every org for the next minute: org B's `conversation.started`
 * would POST its payload to org A's URL, signed with org A's secret, while B's
 * own hooks never fired. Keyed by org the entries cannot cross, and the
 * delivery row each dispatch writes lands against a hook the emitting org can
 * see.
 *
 * **There is no `'system'` partition, deliberately.** Under `runAsSystem` the
 * data layer sets `app.bypass_rls`, so the `findMany` below would return
 * EVERY org's hooks — and one such entry, cached under a shared sentinel key,
 * would fan a single event out to every org's webhook URL, each signed with
 * that org's secret. That is the defect this module just fixed, reintroduced
 * through the back door. So a null-org scope is refused rather than keyed
 * (§108 t-712, review round 1). Nothing emits under `runAsSystem` today; this
 * is what keeps that true.
 *
 * Partitions older than the TTL are dropped on the next refresh, so the map
 * does not accumulate one entry per org that has ever emitted — each holds
 * every enabled hook's action, filter and secret, and stale ones are of no
 * use to anybody.
 */
const hookCacheByOrg = new Map<string, OrgHookCache>();

/**
 * Load the calling org's enabled hooks from the database, grouped by event
 * type. Results are cached per org for CACHE_TTL_MS.
 *
 * Two call stacks are refused rather than served, and `emitHookEvent` —
 * fire-and-forget — logs each: one that entered no context at all (`multi`
 * only; at `single` the context resolves to the install org, so there is one
 * partition and the behaviour is unchanged), and one running as the system
 * scope, which has no org to name. Both are the same answer: **an event that
 * cannot say whose it is cannot say whose hooks to fire**, and reading wide
 * is never the fallback.
 */
async function loadHooks(): Promise<Map<string, CachedHook[]>> {
  const { orgId } = requireTenantContext();
  if (orgId === null) {
    throw new Error(
      'Hook dispatch has no org: this call stack runs as the system scope, which sees every ' +
        "org's hooks. Emit the event inside runAsOrg — see lib/tenancy/process-state.ts."
    );
  }
  const now = Date.now();
  const cached = hookCacheByOrg.get(orgId);
  if (cached && now - cached.loadedAt < CACHE_TTL_MS) {
    return cached.byType;
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

    let filter: HookFilter | null = null;
    if (hook.filter) {
      const parsedFilter = HookFilterSchema.safeParse(hook.filter);
      if (!parsedFilter.success) {
        logger.warn('Hook skipped: invalid filter shape', {
          hookId: hook.id,
          issues: parsedFilter.error.issues,
        });
        continue;
      }
      filter = parsedFilter.data;
    }

    const cached: CachedHook = {
      id: hook.id,
      eventType: hook.eventType,
      action: parsedAction.data,
      filter,
      secret: hook.secret,
    };

    const list = byType.get(hook.eventType) ?? [];
    list.push(cached);
    byType.set(hook.eventType, list);
  }

  // Drop every partition the TTL has expired, this one included, before
  // writing the fresh entry. One org's refresh is the natural moment to
  // collect the orgs that have stopped emitting.
  for (const [key, entry] of hookCacheByOrg) {
    if (now - entry.loadedAt >= CACHE_TTL_MS) hookCacheByOrg.delete(key);
  }
  hookCacheByOrg.set(orgId, { byType, loadedAt: now });
  return byType;
}

/**
 * Invalidate the hook cache (e.g., after CRUD operations).
 *
 * Clears **every** org's partition, not just the caller's. An admin route
 * editing a hook runs inside one org, but the cost of dropping the others is a
 * single re-read each and the cost of getting the partitioning wrong is a hook
 * that keeps firing after it was disabled.
 */
export function invalidateHookCache(): void {
  hookCacheByOrg.clear();
}

/**
 * Check whether an event payload matches a hook's filter criteria.
 * If no filter is set, the hook matches all events of its type.
 */
function matchesFilter(filter: HookFilter | null, payload: HookEventPayload): boolean {
  if (!filter) return true;
  if (!payload.data) return false;

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
 * asynchronously — this function returns immediately. The dispatch, and each
 * hook's first delivery attempt, is kept alive past the response (t-903).
 * In-process retries are not; the tick's `processPendingHookRetries` sends them.
 *
 * @param eventType - The event type to emit
 * @param data - Event-specific payload data
 */
export function emitHookEvent(eventType: HookEventType, data: Record<string, unknown>): void {
  // The moment the event's copy was taken, which an erasure may overtake
  // before a delivery goes (t-886). `data` was built just before this call,
  // which COPY_CLOCK_SKEW_MS covers.
  const takenAt = new Date();
  const payload: HookEventPayload = {
    eventType,
    timestamp: new Date().toISOString(),
    data,
  };

  keepRunningAfterResponse(
    dispatchToHooks(payload, takenAt).catch((err: unknown) => {
      logger.warn('Hook dispatch error', {
        eventType,
        error: err instanceof Error ? err.message : String(err),
      });
    }),
    'Hook dispatch',
    { eventType }
  );
}

async function dispatchToHooks(payload: HookEventPayload, takenAt: Date): Promise<void> {
  const byType = await loadHooks();
  const hooks = byType.get(payload.eventType) ?? [];

  const matched = hooks.filter(
    (hook): hook is CachedHook & { action: WebhookAction } =>
      matchesFilter(hook.filter, payload) && hook.action.type === 'webhook'
  );
  if (matched.length === 0) return;
  // Who the payload names, once for every hook (t-926); a retry resolves it
  // from the row it claimed.
  const subjects = resolveFanOutSubjects(
    payload.eventType,
    payload as unknown as Prisma.JsonValue,
    'Hook'
  );
  // Settles once every first attempt has, so the hold `emitHookEvent` takes
  // covers the deliveries too. Retries run on their own timers, and the tick
  // picks them up if the process is gone (`processPendingHookRetries`).
  await Promise.allSettled(
    matched.map((hook) =>
      dispatchWebhook(hook.id, hook.action, hook.secret, payload, takenAt, subjects)
    )
  );
  // Settled within the dispatch even when every create failed and nothing
  // awaited it.
  await subjects;
}

async function dispatchWebhook(
  hookId: string,
  action: WebhookAction,
  secret: string | null,
  payload: HookEventPayload,
  takenAt: Date,
  subjects: Promise<PayloadSubjects | undefined>
): Promise<void> {
  try {
    const delivery = await prisma.aiEventHookDelivery.create({
      data: {
        hookId,
        eventType: payload.eventType,
        payload: payload as unknown as Prisma.InputJsonValue,
        status: 'pending',
        ...describeDestination('webhook', action.url),
      },
    });
    await attemptDelivery(
      delivery,
      action.url,
      action.headers ?? null,
      secret,
      payload,
      takenAt,
      await subjects
    );
  } catch (err: unknown) {
    logger.warn('Hook webhook dispatch setup failed', {
      hookId,
      url: loggableUrl(action.url),
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
 *
 * The URL this attempt uses is recorded in the same write as its outcome. A
 * retry after the hook was edited moves the old destination into the row's
 * history rather than overwriting it.
 *
 * `takenAt` is when the copy the payload came from was taken, which an erasure
 * since may have overtaken (t-886, {@link sendUnlessErased}). `subjects`, on an
 * event's first attempts, is who the payload names, resolved once for the
 * whole fan-out (t-926); a retry leaves it out.
 */
async function attemptDelivery(
  record: AttemptRecord,
  url: string,
  customHeaders: Record<string, string> | null,
  secret: string | null,
  payload: HookEventPayload,
  takenAt: Date,
  subjects?: PayloadSubjects
): Promise<void> {
  const deliveryId = record.id;
  const now = new Date();
  const recordDestination = destinationUpdate(record, describeDestination('webhook', url), now);

  const posted = await sendUnlessErased(record, payload, takenAt, subjects, (toSend) =>
    postHook(url, customHeaders, secret, toSend)
  );
  // Left out: recorded as stopped, in the decision's transaction.
  if (posted === null) return;
  const { statusCode } = posted;

  if (posted.ok) {
    // Written only to a row still waiting to send: one an erasure stopped
    // while this attempt was in flight stays stopped (t-793).
    const settled = await prisma.aiEventHookDelivery.updateMany({
      where: { id: deliveryId, status: { in: [...AWAITING_RETRY_STATUSES] } },
      data: {
        status: 'delivered',
        attempts: { increment: 1 },
        lastAttemptAt: now,
        lastResponseCode: statusCode ?? null,
        lastError: null,
        nextRetryAt: null,
        ...recordDestination,
      },
    });
    if (settled.count === 0) {
      await recordSettledAttempt(deliveryId, now, statusCode, 'delivered');
    }
    return;
  }
  const { error } = posted;

  // Delivery failed — update record and maybe schedule retry
  const delivery = await prisma.aiEventHookDelivery.findUnique({
    where: { id: deliveryId },
  });
  if (!delivery) return;

  const uncounted = posted.uncounted === true && checkFailureUncounted(delivery.createdAt);
  const newAttempts = delivery.attempts + (uncounted ? 0 : 1);
  const exhausted = newAttempts >= MAX_ATTEMPTS;
  const retryDelay = RETRY_DELAYS_MS[Math.max(newAttempts, 1) - 1];
  const nextRetryAt = exhausted || !retryDelay ? null : new Date(Date.now() + retryDelay);

  // Conditional for the same reason as the delivered write: one an erasure
  // stopped, before the read above or after it, is left stopped. Matching
  // nothing, it arms no timer.
  const written = await prisma.aiEventHookDelivery.updateMany({
    where: { id: deliveryId, status: { in: [...AWAITING_RETRY_STATUSES] } },
    data: {
      status: exhausted ? 'exhausted' : 'failed',
      attempts: newAttempts,
      lastAttemptAt: now,
      lastResponseCode: statusCode ?? null,
      lastError: error,
      nextRetryAt,
      ...recordDestination,
    },
  });
  if (written.count === 0) {
    await recordSettledAttempt(deliveryId, now, statusCode, 'failed');
    return;
  }

  if (!exhausted && nextRetryAt) {
    scheduleRetry(deliveryId, retryDelay ?? RETRY_DELAYS_MS[0], nextRetryAt);
    // The in-process timer above is the normal retry path; the maintenance tick
    // drains anything it loses. Tell the tick's idle gate a row is now waiting,
    // so it does not skip past it (#442).
    noteMaintenanceWork('hook-delivery-retry');
  }

  logger.warn('Hook webhook delivery failed', {
    deliveryId,
    url: loggableUrl(url),
    attempt: newAttempts,
    maxAttempts: MAX_ATTEMPTS,
    exhausted,
    error,
    statusCode,
  });
}

/** What an attempt reads off its delivery row. */
type AttemptRecord = DeliveryLike & {
  createdAt: Date;
  eventType: string;
  payload: Prisma.JsonValue;
  lastError: string | null;
};

/** How one POST to a hook went. */
type HookPostResult =
  | { ok: true; statusCode: number }
  /** `uncounted`: nothing was posted, as the dispatcher's outcome (t-886). */
  | { ok: false; statusCode?: number; error: string; uncounted?: boolean };

/** POST `payload` to the hook, signed when it has a secret. Never throws. */
async function postHook(
  url: string,
  customHeaders: Record<string, string> | null,
  secret: string | null,
  payload: HookEventPayload
): Promise<HookPostResult> {
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
        ...(customHeaders ?? {}),
        ...signingHeaders,
      },
      body,
      signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS.hook),
      // Refuse redirects rather than follow them (#534). `fetch` defaults to
      // 'follow'. The hook URL itself IS re-checked at dispatch — `loadHooks`
      // and `parseDeliveryForDispatch` both re-parse the stored action through
      // `WebhookActionSchema`, which carries the `isSafeProviderUrl` refine — but
      // a redirect TARGET is a second address no schema ever saw
      // that this request would POST the event payload AND its HMAC signature
      // headers to. Erroring is also what GitHub and Stripe do for outbound
      // webhooks: an endpoint that moved should be re-pointed, not chased.
      // The failure surfaces as a normal delivery error and is retried.
      redirect: 'error',
    });

    return res.ok
      ? { ok: true, statusCode: res.status }
      : { ok: false, statusCode: res.status, error: `HTTP ${res.status}` };
  } catch (err: unknown) {
    // undici renders a refused redirect, a DNS failure and a connection reset
    // all as a bare "fetch failed"; the reason lives on `cause`.
    return { ok: false, error: describeFetchFailure(err) };
  }
}

/**
 * Post the attempt, unless its payload is about a person erased since its
 * copy was taken — the oldest of `takenAt`, the row's creation and the start of
 * the run it names (§122 t-886, `decideDeliveryUnderLocks`). Null when it was
 * left out.
 *
 * Left out, the row is settled as erasure settles one it stops (t-793):
 * `exhausted`, `stoppedByErasure`, so no retry or replay sends it, with the
 * payload redacted. One that names the erased person only as an admin acting
 * on configuration is posted without who acted, as erasure leaves such a row.
 * The decision and that write commit together, under the locks held across
 * the post. The row's payload is what is checked: the copy it was created
 * from, or the one a retry's claim just returned.
 */
async function sendUnlessErased(
  record: AttemptRecord,
  payload: HookEventPayload,
  takenAt: Date,
  subjects: PayloadSubjects | undefined,
  post: (payload: HookEventPayload) => Promise<HookPostResult>
): Promise<HookPostResult | null> {
  try {
    const decided = await decideDeliveryUnderLocks(
      record,
      null,
      takenAt,
      // Posted once the decision has committed: no connection is held across
      // the receiver's response (owner ruling, 2026-10-22).
      { sendTimeoutMs: DISPATCH_TIMEOUT_MS.hook, holdAcrossSend: false, subjects },
      async (tx, decision) => {
        const redacted = decision.payload;
        if (decision.kind === 'send' && redacted === null) return;
        // Redaction only removes keys from `data`, so the result still parses;
        // one that somehow did not is stopped rather than sent unredacted.
        if (
          decision.kind === 'stop' ||
          redacted === null ||
          !HookEventPayloadSchema.safeParse(redacted).success
        ) {
          await settleStoppedDelivery(tx, 'hook', record, {
            reason: SUBJECT_ERASED,
            payload: redacted,
          });
          // Never the person: they are what was erased.
          logger.warn('Hook delivery left out: it names a person erased since its event', {
            deliveryId: record.id,
          });
          return;
        }
        await tx.aiEventHookDelivery.updateMany({
          where: { id: record.id },
          data: { payload: redacted },
        });
      },
      (decision) => {
        if (decision.payload === null) return post(payload);
        const sendable = HookEventPayloadSchema.safeParse(decision.payload);
        // One that did not parse was stopped under the locks above: not posted.
        return sendable.success ? post(sendable.data) : Promise.resolve(null);
      }
    );
    return decided;
  } catch (err) {
    // The check could not run — a lock held past its wait, or the database
    // gone — so nothing was sent; or the transaction failed to commit after
    // the post, whose receiver may then get it again. Retried as any failed
    // post is.
    return {
      ok: false,
      uncounted: true,
      error: `Could not check for an erasure before sending: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Validate a stored delivery's `hook.action` and `payload` JSON before
 * re-dispatching. If either fails validation the delivery is marked
 * `exhausted` (malformed rows are not retriable) and `null` is returned.
 */
async function parseDeliveryForDispatch(delivery: {
  id: string;
  lastError: string | null;
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
  // Only over the `lastError` it read: an erasure that marked the row since
  // keeps its mark, which a manual retry reads (t-793).
  await prisma.aiEventHookDelivery.updateMany({
    where: { id: delivery.id, lastError: delivery.lastError },
    data: { status: 'exhausted', nextRetryAt: null, lastError },
  });
  logger.warn('Hook delivery abandoned: invalid action or payload', {
    deliveryId: delivery.id,
    lastError,
  });
  return null;
}

/**
 * An attempt finished after its row stopped awaiting a send (t-793): its
 * outcome is not written over the stop, but the row still records that an
 * attempt went out — when, and what came back. Neither the status, the
 * `lastError` that marks an erasure's stop, nor the destination is touched.
 */
async function recordSettledAttempt(
  deliveryId: string,
  at: Date,
  statusCode: number | undefined,
  kind: 'delivered' | 'failed'
): Promise<void> {
  // Not onto a row another attempt delivered: it already records a send.
  await prisma.aiEventHookDelivery.updateMany({
    where: { id: deliveryId, status: { not: 'delivered' } },
    data: {
      attempts: { increment: 1 },
      lastAttemptAt: at,
      // Only a code it has: a network failure has none, and must not null the
      // one the settling write recorded.
      ...(statusCode !== undefined ? { lastResponseCode: statusCode } : {}),
    },
  });
  logSettledInFlight('Hook', deliveryId, kind);
}

/**
 * The payload of a row a claim or a reset has just written and returned, ready
 * to send. One that no longer parses is settled, as parseDeliveryForDispatch
 * settles a malformed row, rather than left claimed or `pending`, which
 * nothing would send (t-793).
 */
async function sendablePayload(row: {
  id: string;
  status: string;
  payload: Prisma.JsonValue;
}): Promise<HookEventPayload | null> {
  const parsed = HookEventPayloadSchema.safeParse(row.payload);
  if (parsed.success) return parsed.data;
  await prisma.aiEventHookDelivery.updateMany({
    where: { id: row.id, status: row.status },
    data: { status: 'exhausted', nextRetryAt: null, lastError: 'invalid_payload' },
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
function scheduleRetry(deliveryId: string, delayMs: number, armedFor: Date): void {
  const timer = setTimeout(
    () =>
      void (async () => {
        try {
          // Before the read: the row and its hook are this attempt's copy (t-886).
          const takenAt = new Date();
          const delivery = await prisma.aiEventHookDelivery.findUnique({
            where: { id: deliveryId },
            include: { hook: true },
          });
          // No longer the retry this timer was armed for: stopped by an
          // erasure, delivered, or retried by hand or by the tick in the
          // meantime. See `isArmedRetry`.
          if (delivery && !isArmedRetry(delivery, armedFor)) return;
          if (!delivery || !delivery.hook || !delivery.hook.isEnabled) {
            if (delivery) {
              // Conditional: an erasure that stopped the row since it was read
              // keeps its mark, which a manual retry reads (t-793).
              await prisma.aiEventHookDelivery.updateMany({
                where: { id: deliveryId, status: { in: [...AWAITING_RETRY_STATUSES] } },
                data: {
                  status: 'exhausted',
                  nextRetryAt: null,
                  ...(delivery.hook
                    ? {}
                    : { lastError: notRetried(delivery.lastError, HOOK_DELETED) }),
                },
              });
            }
            return;
          }

          const parsed = await parseDeliveryForDispatch({ ...delivery, hook: delivery.hook });
          if (!parsed) return;
          // Claimed, so the maintenance tick or a manual retry racing this
          // timer does not send the row as well (t-793).
          // The claim returns the row as it wrote it; its payload is the one
          // sent, as an erasure may have redacted the copy read above.
          const [claimed] = await prisma.aiEventHookDelivery.updateManyAndReturn(
            claimArmedRetry(deliveryId, armedFor)
          );
          if (!claimed) return;
          const payload = await sendablePayload(claimed);
          if (!payload) return;

          await attemptDelivery(
            claimed,
            parsed.action.url,
            parsed.action.headers ?? null,
            parsed.secret,
            payload,
            takenAt
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
  // Before the read: each row and its hook are its attempt's copy (t-886).
  const takenAt = new Date();
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
      if (!delivery.hook || !delivery.hook.isEnabled) {
        // Conditional: an erasure that stopped the row since it was read keeps
        // its mark, which a manual retry reads (t-793).
        await prisma.aiEventHookDelivery.updateMany({
          where: { id: delivery.id, status: { in: [...AWAITING_RETRY_STATUSES] } },
          data: {
            status: 'exhausted',
            nextRetryAt: null,
            ...(delivery.hook ? {} : { lastError: notRetried(delivery.lastError, HOOK_DELETED) }),
          },
        });
        return;
      }

      const parsed = await parseDeliveryForDispatch({ ...delivery, hook: delivery.hook });
      if (!parsed) return;
      // Claimed, so an in-process timer firing for the same row now does not
      // send it as well (t-793).
      if (!delivery.nextRetryAt) return;
      // The claim returns the row as it wrote it; its payload is the one sent,
      // as an erasure may have redacted the copy read above.
      const [claimed] = await prisma.aiEventHookDelivery.updateManyAndReturn(
        claimArmedRetry(delivery.id, delivery.nextRetryAt)
      );
      if (!claimed) return;
      const payload = await sendablePayload(claimed);
      if (!payload) return;

      await attemptDelivery(
        claimed,
        parsed.action.url,
        parsed.action.headers ?? null,
        parsed.secret,
        payload,
        takenAt
      );
    })
  );

  return pending.length;
}

/**
 * Manually retry a specific hook delivery. Resets the attempt counter so
 * admin-initiated retries get a fresh set of retry attempts.
 *
 * Returns `false` if the delivery does not exist, its hook was deleted
 * (the row is kept as the record and left untouched) or is disabled, the
 * hook is no longer a webhook action, an erasure stopped it
 * (`stoppedByErasure`, t-793, t-809), or it changed between the read and the
 * reset.
 */
export async function retryHookDelivery(deliveryId: string): Promise<boolean> {
  // Before the read: the row and its hook are this attempt's copy (t-886).
  const takenAt = new Date();
  const delivery = await prisma.aiEventHookDelivery.findUnique({
    where: { id: deliveryId },
    include: { hook: true },
  });
  if (!delivery || !delivery.hook) return false;
  if (!delivery.hook.isEnabled) return false;
  // Stopped by an erasure: what it would send is about the erased person
  // (t-793). Refused, and left as the record.
  if (delivery.stoppedByErasure) return false;

  const parsed = await parseDeliveryForDispatch({ ...delivery, hook: delivery.hook });
  if (!parsed) return false;

  // Reset only if the row is as it was read. An erasure that committed in
  // between has redacted it or stopped it, and is not undone; a timer or the
  // tick that claimed it meanwhile sends it instead. The reset returns the row
  // as it wrote it, and that payload is the one sent.
  const [current] = await prisma.aiEventHookDelivery.updateManyAndReturn({
    where: {
      id: deliveryId,
      status: delivery.status,
      lastError: delivery.lastError,
      nextRetryAt: delivery.nextRetryAt,
      stoppedByErasure: false,
    },
    data: {
      status: 'pending',
      attempts: 0,
      lastError: null,
      nextRetryAt: null,
      lastAttemptAt: null,
      lastResponseCode: null,
    },
  });
  if (!current) return false;
  const payload = await sendablePayload(current);
  if (!payload) return false;

  keepRunningAfterResponse(
    attemptDelivery(
      current,
      parsed.action.url,
      parsed.action.headers ?? null,
      parsed.secret,
      payload,
      takenAt
    ),
    'Hook delivery retry',
    { deliveryId: current.id }
  );
  return true;
}
