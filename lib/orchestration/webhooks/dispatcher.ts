/**
 * Webhook Dispatcher
 *
 * Dispatches outbound webhook notifications for key orchestration events.
 * Queries active webhook subscriptions matching the event type and POSTs
 * the payload to each URL with HMAC-SHA256 signature verification.
 *
 * Delivery tracking: each dispatch creates an `AiWebhookDelivery` record
 * so admins can audit delivery history and manually retry failures. The
 * record carries where it was sent and outlives its subscription (§109
 * t-739): see `destination.ts` for the shape and why.
 *
 * Retry strategy: configured per-subscription via `maxAttempts` +
 * `retryBackoffMs`. Defaults match the historical hardcoded values
 * (3 attempts, 10s/60s backoff). Uses in-process `setTimeout`-based
 * delayed retry — suitable for single-server deployments. Future
 * multi-server deployments can swap to a Redis-backed queue without
 * changing the public API.
 */

import { createHash, createHmac } from 'crypto';
import type { AiWebhookSubscription, Prisma } from '@prisma/client';
import { render } from '@react-email/render';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { keepRunningAfterResponse } from '@/lib/api/after-response';
import { withTimeout } from '@/lib/utils/with-timeout';
import { loggableUrl } from '@/lib/logging/redact-path';
import { checkSafeProviderUrl } from '@/lib/security/safe-url';
import {
  describeOutboundFailure,
  isUnsafeAddressRefusal,
  withOutboundDispatcher,
} from '@/lib/security/safe-dispatcher';
import { getResendClient, getDefaultSender, isEmailEnabled } from '@/lib/email/client';
import EventNotification from '@/emails/event-notification';
import { matchesEntityScope } from '@/lib/orchestration/webhooks/event-entity-keys';
import { noteMaintenanceWork } from '@/lib/orchestration/maintenance/idle-gate';
import {
  AWAITING_RETRY_STATUSES,
  DISPATCH_TIMEOUT_MS,
  checkFailureUncounted,
  claimArmedRetry,
  isArmedRetry,
  logSettledInFlight,
  notRetried,
} from '@/lib/orchestration/webhooks/not-retried';
import {
  ERASED_DESTINATION,
  destinationUpdate,
  normaliseAddress,
  subscriptionDestination,
  type DeliveryLike,
} from '@/lib/orchestration/webhooks/destination';
import {
  decideDeliveryUnderLocks,
  resolveFanOutSubjects,
  settleStoppedDelivery,
} from '@/lib/privacy/stale-sends';
import type { PayloadSubjects } from '@/lib/privacy/delivery-payloads';

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

/**
 * Subset of `AiWebhookSubscription` that the dispatcher actually reads.
 * Lets callers pass a Prisma row or a hand-rolled fixture without
 * coupling to the full Prisma type.
 */
interface SubscriptionLike {
  id: string;
  channel: string;
  url: string | null;
  secret: string | null;
  emailAddress: string | null;
  maxAttempts?: number | null;
  retryBackoffMs?: number[] | null;
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
 * Best-effort subject line for an email notification. Uses the friendly
 * event title plus any human-readable identifier in the payload so the
 * recipient's inbox shows something actionable.
 */
function buildEmailSubject(eventType: string, data: Record<string, unknown>): string {
  const titles: Record<string, string> = {
    budget_exceeded: 'Budget exceeded',
    workflow_failed: 'Workflow failed',
    approval_required: 'Approval required',
    circuit_breaker_opened: 'Provider circuit breaker opened',
    agent_updated: 'Agent updated',
    execution_crashed: 'Workflow execution crashed',
  };
  const base = titles[eventType] ?? `Sunrise event: ${eventType}`;
  const subject =
    typeof data.agentName === 'string'
      ? `${base} · ${data.agentName}`
      : typeof data.workflowName === 'string'
        ? `${base} · ${data.workflowName}`
        : typeof data.providerSlug === 'string'
          ? `${base} · ${data.providerSlug}`
          : base;
  return `[Sunrise] ${subject}`;
}

/**
 * Dispatch a webhook event to all active subscribers for the given event type.
 *
 * Creates a delivery record for each subscription, attempts delivery, and
 * schedules retries on failure. Errors are logged but never thrown.
 *
 * Kept alive past the response (t-903): the dispatch registers itself with
 * `keepRunningAfterResponse`, so a caller that does not await it is not frozen
 * before the delivery rows are written. Awaiting it is unchanged.
 */
export function dispatchWebhookEvent(
  eventType: string,
  payload: Record<string, unknown>
): Promise<void> {
  const dispatch = dispatchToSubscriptions(eventType, payload);
  keepRunningAfterResponse(dispatch, 'Webhook dispatch', { eventType });
  return dispatch;
}

async function dispatchToSubscriptions(
  eventType: string,
  payload: Record<string, unknown>
): Promise<void> {
  try {
    await deliverToSubscribers(eventType, payload, await readSubscribers(eventType, payload));
  } catch (err) {
    logger.error('Webhook dispatch error', {
      eventType,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * The subscriptions an event goes to, and when they were read: the copy its
 * deliveries are built from, which an erasure can overtake (t-886).
 */
export interface Subscribers {
  takenAt: Date;
  subscriptions: AiWebhookSubscription[];
}

/**
 * Read the subscriptions `eventType` goes to. The first half of a dispatch,
 * apart from {@link deliverToSubscribers} so the erasure smoke can put an
 * erasure between them.
 */
export async function readSubscribers(
  eventType: string,
  payload: Record<string, unknown>
): Promise<Subscribers> {
  // Before the read, and so before anything the copy holds: the event's
  // payload was built just before this call, which COPY_CLOCK_SKEW_MS covers.
  const takenAt = new Date();
  const subscriptions = await prisma.aiWebhookSubscription.findMany({
    where: {
      isActive: true,
      events: { has: eventType },
    },
  });
  // Dimension-specific entity scoping: filter out subscriptions whose
  // agent/workflow filters exclude this event. Done in JS (not SQL)
  // because the admin-scoped subs list is small and the rules are
  // dimension-specific — see event-entity-keys.ts for the contract.
  return {
    takenAt,
    subscriptions: subscriptions.filter((sub) => matchesEntityScope(eventType, payload, sub)),
  };
}

/** Create a delivery for each of `subscribers` and attempt it: a dispatch's second half. */
export async function deliverToSubscribers(
  eventType: string,
  payload: Record<string, unknown>,
  { takenAt, subscriptions: matched }: Subscribers
): Promise<void> {
  if (matched.length === 0) return;

  const body = JSON.stringify({
    event: eventType,
    timestamp: new Date().toISOString(),
    data: payload,
  });
  const stored = { event: eventType, data: payload };
  // Who the payload names, once for every subscription (t-926).
  const subjects = resolveFanOutSubjects(
    eventType,
    stored as unknown as Prisma.JsonValue,
    'Webhook'
  );

  await Promise.allSettled(
    matched.map(async (sub) => {
      // Create delivery record
      const delivery = await prisma.aiWebhookDelivery.create({
        data: {
          subscriptionId: sub.id,
          eventType,
          payload: stored as unknown as Prisma.InputJsonValue,
          status: 'pending',
          ...subscriptionDestination(sub),
        },
      });

      await attemptDelivery(delivery, sub, body, resolveRetryPolicy(sub), takenAt, await subjects);
    })
  );
  // Settled within the dispatch even when every create failed and nothing
  // awaited it.
  await subjects;
}

/**
 * Retry a specific delivery. Used by the manual retry admin endpoint.
 *
 * By default the outbound HTTP attempt is fire-and-forget so the single-row
 * retry endpoint can return immediately (the receiver's response time isn't
 * in the request budget). Bulk replay opts into `awaitDelivery: true` so
 * its chunk-by-chunk `Promise.all` actually gates outbound HTTPs and the
 * stated concurrency cap holds.
 *
 * Returns `false`, sending nothing, when the delivery does not exist, its
 * subscription was deleted, an erasure stopped it (`stoppedByErasure`,
 * t-793, t-809), or it changed between the read and the reset.
 */
export async function retryDelivery(
  deliveryId: string,
  options?: { awaitDelivery?: boolean }
): Promise<boolean> {
  // Before the read: the subscription is this attempt's copy (t-886).
  const takenAt = new Date();
  const delivery = await prisma.aiWebhookDelivery.findUnique({
    where: { id: deliveryId },
    include: { subscription: true },
  });

  if (!delivery) return false;
  // The subscription was deleted: the row is kept as the record of where the
  // event went, and there is nowhere current to send it. Left untouched, so
  // its last real error stays on it.
  const subscription = delivery.subscription;
  if (!subscription) return false;
  // Stopped by an erasure: what it would send is about the erased person, or
  // goes to their address (t-793). Refused, and left as the record.
  if (delivery.stoppedByErasure) return false;

  // Reset status for retry, only if the row is as it was read. An erasure that
  // committed in between has redacted it or stopped it, and is not undone; a
  // timer or the tick that claimed it meanwhile sends it instead. The reset
  // returns the row as it wrote it, and that payload is the one sent: never
  // the copy read above, which an erasure may have redacted since.
  const [current] = await prisma.aiWebhookDelivery.updateManyAndReturn({
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
      // A new send, so its email gets a new idempotency key (t-822).
      sendGeneration: { increment: 1 },
      lastError: null,
      nextRetryAt: null,
      lastAttemptAt: null,
      lastResponseCode: null,
    },
  });
  if (!current) return false;

  const storedPayload = toJsonRecord(current.payload);
  const body = JSON.stringify({
    ...storedPayload,
    timestamp: new Date().toISOString(),
  });

  const attempt = attemptDelivery(
    current,
    subscription,
    body,
    resolveRetryPolicy(subscription),
    takenAt
  );

  if (options?.awaitDelivery) {
    await attempt;
  } else {
    // In the background — the attempt will update the delivery record. Kept
    // alive past the retry route's response (t-903).
    keepRunningAfterResponse(attempt, 'Webhook delivery retry', { deliveryId: current.id });
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
  // Before the read: each row's subscription is its attempt's copy (t-886).
  const takenAt = new Date();
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
      if (!delivery.subscription || !delivery.subscription.isActive) {
        // Conditional: an erasure that stopped the row since it was read keeps
        // its mark, which a manual retry reads (t-793).
        await prisma.aiWebhookDelivery.updateMany({
          where: { id: delivery.id, status: { in: [...AWAITING_RETRY_STATUSES] } },
          data: {
            status: 'exhausted',
            nextRetryAt: null,
            lastError: delivery.subscription
              ? 'Subscription deactivated'
              : notRetried(delivery.lastError, SUBSCRIPTION_DELETED),
          },
        });
        return;
      }

      // Claimed, so an in-process timer firing for the same row now does not
      // send it as well (t-793).
      if (!delivery.nextRetryAt) return;
      // The claim returns the row as it wrote it; its payload is the one sent,
      // as an erasure may have redacted the copy read above.
      const [claimed] = await prisma.aiWebhookDelivery.updateManyAndReturn(
        claimArmedRetry(delivery.id, delivery.nextRetryAt)
      );
      if (!claimed) return;

      const storedPayload = toJsonRecord(claimed.payload);
      const body = JSON.stringify({
        ...storedPayload,
        timestamp: new Date().toISOString(),
      });

      await attemptDelivery(
        claimed,
        delivery.subscription,
        body,
        resolveRetryPolicy(delivery.subscription),
        takenAt
      );
    })
  );

  return pending.length;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Why a retry stopped when its subscription was deleted in the meantime. */
const SUBSCRIPTION_DELETED = 'subscription deleted';

/**
 * An attempt finished after its row stopped awaiting a send (t-793): its
 * outcome is not written over the stop, but the row still records that an
 * attempt went out — when, and what came back. Neither the status, the
 * `lastError` that marks an erasure's stop, nor the destination is touched:
 * an erasure may have redacted the destination, and writing the
 * subscription's current one back could restore an erased address.
 */
async function recordSettledAttempt(
  deliveryId: string,
  at: Date,
  outcome: DeliveryOutcome,
  kind: 'delivered' | 'failed'
): Promise<void> {
  // Not onto a row another attempt delivered: it already records a send.
  await prisma.aiWebhookDelivery.updateMany({
    where: { id: deliveryId, status: { not: 'delivered' } },
    data: {
      attempts: { increment: 1 },
      lastAttemptAt: at,
      // Only a code it has: an email send or a network failure has none, and
      // must not null the one the settling write recorded.
      ...(outcome.statusCode !== undefined ? { lastResponseCode: outcome.statusCode } : {}),
    },
  });
  logSettledInFlight('Webhook', deliveryId, kind);
}

/**
 * Outcome shape returned by each per-channel adapter.
 *
 * `terminal: true` on a failure means the row should be marked exhausted
 * immediately regardless of attempt count — config-level failures like a
 * missing HMAC secret or unconfigured Resend can't be fixed by retrying.
 * The adapters never write the audit row themselves; `attemptDelivery`
 * owns every write so the state machine has a single source of truth.
 */
type DeliveryOutcome =
  | { delivered: true; statusCode?: number }
  | {
      delivered: false;
      error: string;
      statusCode?: number;
      terminal?: boolean;
      /**
       * Nothing was sent: the erasure check could not run (t-886). Retried,
       * but not counted against the policy's attempts — a backup import or a
       * busy pool is not the receiver failing, and must not exhaust the row.
       * For the row's first `UNCOUNTED_CHECK_WINDOW_MS`; after that it counts.
       */
      uncounted?: boolean;
    };

/** What an attempt reads off its delivery row. */
type AttemptRecord = DeliveryLike & {
  createdAt: Date;
  sendGeneration: number;
  eventType: string;
  payload: Prisma.JsonValue;
  lastError: string | null;
};

/**
 * One attempt at a delivery. `takenAt` is when the copy it sends from was
 * read — the subscription, and the event its payload came from — which an
 * erasure since may have overtaken (t-886, {@link sendUnlessErased}).
 * `subjects`, on an event's first attempts, is who its payload names, resolved
 * once for the whole fan-out (t-926); a retry leaves it out.
 */
async function attemptDelivery(
  record: AttemptRecord,
  sub: SubscriptionLike,
  body: string,
  policy: RetryPolicy,
  takenAt: Date,
  subjects?: PayloadSubjects
): Promise<void> {
  const deliveryId = record.id;
  const now = new Date();
  // Where this attempt goes, recorded in the same write as its outcome. A
  // retry after the subscription was edited moves the old destination into
  // the row's history rather than overwriting it.
  const recordDestination = destinationUpdate(record, subscriptionDestination(sub), now);

  const outcome = await sendUnlessErased(record, sub, body, takenAt, subjects);
  // Left out: recorded as stopped, in the decision's transaction.
  if (outcome === null) return;

  if (outcome.delivered) {
    // Written only to a row still waiting to send: one an erasure stopped
    // while this attempt was in flight stays stopped (t-793).
    const settled = await prisma.aiWebhookDelivery.updateMany({
      where: { id: deliveryId, status: { in: [...AWAITING_RETRY_STATUSES] } },
      data: {
        status: 'delivered',
        attempts: { increment: 1 },
        lastAttemptAt: now,
        lastResponseCode: outcome.statusCode ?? null,
        lastError: null,
        nextRetryAt: null,
        ...recordDestination,
      },
    });
    if (settled.count === 0) await recordSettledAttempt(deliveryId, now, outcome, 'delivered');
    return;
  }

  // Delivery failed — update record and maybe schedule retry
  const delivery = await prisma.aiWebhookDelivery.findUnique({
    where: { id: deliveryId },
  });

  if (!delivery) return;

  const uncounted = outcome.uncounted === true && checkFailureUncounted(delivery.createdAt);
  const newAttempts = delivery.attempts + (uncounted ? 0 : 1);
  // `terminal` forces exhausted regardless of attempt count.
  const exhausted = outcome.terminal === true || newAttempts >= policy.maxAttempts;

  // After attempt N fails, the next delay is policy.retryBackoffMs[N-1].
  // If the array is shorter than maxAttempts-1, fall back to the last
  // configured delay so we never trip an out-of-bounds undefined.
  const backoffIndex = Math.min(Math.max(newAttempts, 1) - 1, policy.retryBackoffMs.length - 1);
  const retryDelay = backoffIndex >= 0 ? policy.retryBackoffMs[backoffIndex] : undefined;
  const nextRetryAt = exhausted || !retryDelay ? null : new Date(Date.now() + retryDelay);

  // Conditional for the same reason as the delivered write: one an erasure
  // stopped, before the read above or after it, is left stopped. Matching
  // nothing, it arms no timer.
  const written = await prisma.aiWebhookDelivery.updateMany({
    where: { id: deliveryId, status: { in: [...AWAITING_RETRY_STATUSES] } },
    data: {
      status: exhausted ? 'exhausted' : 'failed',
      attempts: newAttempts,
      lastAttemptAt: now,
      lastResponseCode: outcome.statusCode ?? null,
      lastError: outcome.error,
      nextRetryAt,
      ...recordDestination,
    },
  });
  if (written.count === 0) {
    await recordSettledAttempt(deliveryId, now, outcome, 'failed');
    return;
  }

  if (!exhausted && nextRetryAt && retryDelay) {
    scheduleRetry(deliveryId, sub.id, retryDelay, nextRetryAt);
    // The in-process timer above is the normal retry path; the maintenance tick
    // drains anything it loses. Tell the tick's idle gate a row is now waiting,
    // so it does not skip past it (#442).
    noteMaintenanceWork('webhook-delivery-retry');
  }

  logger.warn('Webhook delivery failed', {
    deliveryId,
    channel: sub.channel,
    destination: sub.channel === 'email' ? sub.emailAddress : loggableUrl(sub.url),
    attempt: newAttempts,
    maxAttempts: policy.maxAttempts,
    exhausted,
    terminal: outcome.terminal === true,
    error: outcome.error,
    statusCode: outcome.statusCode,
  });
}

/**
 * Send the attempt, unless the copy it was built from names a person erased
 * since that copy was taken — the oldest of `takenAt`, the row's creation and
 * the start of the run it names (§122 t-886, `decideDeliveryUnderLocks`): its
 * email address, or someone its payload is about. Null when it was left out.
 *
 * Left out, the row is settled as erasure settles one it stops (t-793):
 * `exhausted`, `stoppedByErasure`, so no retry or replay sends it, with the
 * address taken off and the payload redacted. A payload that names the erased
 * person only as an admin acting on configuration is sent without who acted,
 * as erasure leaves such a row. The decision and that write commit together,
 * under the locks held across the send.
 */
async function sendUnlessErased(
  record: AttemptRecord,
  sub: SubscriptionLike,
  body: string,
  takenAt: Date,
  subjects: PayloadSubjects | undefined
): Promise<DeliveryOutcome | null> {
  const email = sub.channel === 'email';
  const address = email && sub.emailAddress ? normaliseAddress(sub.emailAddress) : null;
  try {
    return await decideDeliveryUnderLocks(
      record,
      address,
      takenAt,
      // An email reaches the person: sent under the locks. A webhook post is
      // sent once the decision has committed (owner ruling, 2026-10-22).
      {
        sendTimeoutMs: DISPATCH_TIMEOUT_MS[email ? 'email' : 'webhook'],
        holdAcrossSend: email,
        subjects,
      },
      async (tx, decision) => {
        if (decision.kind === 'stop') {
          await settleStoppedDelivery(
            tx,
            'webhook',
            record,
            decision,
            decision.recipientErased && record.destination === address
              ? { destination: ERASED_DESTINATION, destinationFingerprint: null }
              : {}
          );
          // Never the address or the person: they are what was erased.
          logger.warn('Webhook delivery left out: it names a person erased since it was read', {
            deliveryId: record.id,
            reason: decision.reason,
          });
        } else if (decision.payload !== null) {
          await tx.aiWebhookDelivery.updateMany({
            where: { id: record.id },
            data: { payload: decision.payload },
          });
        }
      },
      (decision) => {
        const sendBody =
          decision.payload === null
            ? body
            : JSON.stringify({
                ...toJsonRecord(JSON.parse(body)),
                ...toJsonRecord(decision.payload),
              });
        return email
          ? attemptEmailDelivery(record, sub, sendBody)
          : attemptWebhookDelivery(sub, sendBody);
      }
    );
  } catch (err) {
    // The check could not run — a lock held past its wait, or the database
    // gone — so nothing was sent; or, for an email, its transaction failed to
    // commit after the send, and its idempotency key keeps the retry from
    // reaching the inbox twice. Retried either way, uncounted.
    return {
      delivered: false,
      uncounted: true,
      error: `Could not check for an erasure before sending: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * HMAC-signed POST to a webhook subscriber. Returns the structured
 * outcome that `attemptDelivery` uses to drive the shared retry / audit
 * write — adapters never write the audit row themselves.
 *
 * ## Why there is no destination allowlist here
 *
 * Decided deliberately, and recorded here because this is where the question
 * occurs to people. Sunrise does **not** restrict *which* third parties a
 * webhook may reach. An admin configuring a subscriber URL is exercising the
 * feature; honouring it is the point. An allowlist administered by that same
 * admin is ceremony — they would add whatever they were about to use. An
 * allowlist administered by someone *else* is a separation-of-duties product
 * feature (real, and a genuine ask in regulated sectors), which belongs to a
 * fork building a product, not to the template.
 *
 * What *is* refused is a destination that is not a third party at all: cloud
 * metadata endpoints and the deployment's own private network. A subscription
 * pointing there is not an operator expressing intent — it is a mistake or an
 * attack, and honouring it turns this server into a proxy into its own network.
 *
 * **This is tenancy groundwork, and the threat model is the one being built
 * toward.** Today an admin is the platform operator, so pointing a webhook at
 * the box's own metadata reaches infrastructure they already own. Under
 * multi-tenancy an ORG admin is not the platform operator, and the identical
 * request crosses a real isolation boundary into the platform's network. The
 * guard is written for that reader.
 *
 * The check runs **at the point of use**, just below, and additionally on the
 * write paths (create and update schemas, the backup importer, the `/test`
 * route), which fail fast and tell an operator while they can still fix it.
 *
 * Write-path checks alone were tried and were not enough. Guarding writes means
 * guarding a list of state transitions, and two successive cuts of that list
 * were each walked around by the transition they had missed — a lone
 * `PATCH { secret }`, because `/test` requires no `isActive`; then an
 * email-channel round trip, because the whole check sat inside a
 * `nextChannel === 'webhook'` branch. The point-of-use check ends that class:
 * it does not care how the row came to look like this.
 *
 * Under multi-tenancy the *allowlist* question reopens, because "which third
 * parties see our data" becomes an org-level concern rather than an operator
 * one — that work is scoped on the `f-mt-external` feature. The other half of
 * that question, where a given delivery actually went, is answered by the
 * delivery row itself (`destination.ts`, §109 t-739).
 */
async function attemptWebhookDelivery(
  sub: SubscriptionLike,
  body: string
): Promise<DeliveryOutcome> {
  // Refuse to sign with an empty HMAC key: signatures would be forgeable
  // by anyone who knows the URL. Terminal — retrying won't conjure a
  // secret, only admin action will.
  if (!sub.secret) {
    return {
      delivered: false,
      terminal: true,
      error: 'Subscription has no signing secret',
    };
  }

  if (!sub.url) {
    return { delivered: false, terminal: true, error: 'Webhook subscription has no URL' };
  }

  // ── The destination check, at the point of use ──
  //
  // NOT a destination allowlist — see the docblock above for why Sunrise does
  // not restrict WHICH third parties a webhook may reach. This refuses a
  // destination that is not a third party at all: the deployment's own private
  // network and cloud metadata endpoints.
  //
  // Here, rather than on the write paths, because "guard every write" turned out
  // to mean guarding a growing list of state transitions — create, update,
  // import, activate, set-a-secret, flip-the-channel — and each cut of that list
  // was walked around by the transition it had missed. A check at the one place
  // the request is actually made cannot be walked around by any sequence of
  // patches, because it does not care how the row came to look like this.
  //
  // The write-path refines stay: they fail fast and tell an operator at the
  // moment they can fix it. This is what makes the guarantee true rather than
  // conventional. It is not a DNS-rebinding defence — `checkSafeProviderUrl`
  // resolves nothing — but rows that never passed ANY write check exist: every
  // release before this one imported backup bundles without validating them.
  //
  // Terminal: no number of retries will change the URL, only admin action.
  const targetCheck = checkSafeProviderUrl(sub.url);
  if (!targetCheck.ok) {
    logger.warn('Webhook target refused; not delivering', {
      subscriptionId: sub.id,
      reason: targetCheck.reason,
    });
    return {
      delivered: false,
      terminal: true,
      error: `Destination is not allowed: ${targetCheck.message}`,
    };
  }

  try {
    const signature = createHmac('sha256', sub.secret).update(body).digest('hex');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DISPATCH_TIMEOUT_MS.webhook);

    try {
      // Pinned to a checked address when acting for a customer org (§111
      // t-811): the guard above reads the URL's text, not where it resolves.
      const res = await fetch(
        sub.url,
        withOutboundDispatcher({
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
          // Refuse redirects rather than follow them (#534). `fetch` defaults to
          // 'follow', and `sub.url` is validated by `isSafeProviderUrl` only in
          // the Zod refine at create/update — never again here. So a redirect is
          // an unvalidated second target that this request would POST the payload
          // AND its `X-Webhook-Signature` header to, reaching private space the
          // guard would have rejected. Erroring is also what GitHub and Stripe do
          // for outbound webhooks: an endpoint that moved should be re-pointed,
          // not chased. Non-terminal, so delivery retries as normal.
          redirect: 'error',
        })
      );

      if (res.ok) {
        return { delivered: true, statusCode: res.status };
      }
      return { delivered: false, error: `HTTP ${res.status}`, statusCode: res.status };
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    // undici renders a refused redirect, a DNS failure and a connection reset
    // all as a bare "fetch failed"; the reason lives on `cause`. A host the
    // pinned dispatcher refused (§111 t-811) is terminal, as the URL check
    // above is: no retry changes where a name resolves to an admin's benefit.
    return {
      delivered: false,
      ...(isUnsafeAddressRefusal(err) ? { terminal: true } : {}),
      error: describeOutboundFailure(err),
    };
  }
}

/**
 * Render the `EventNotification` template and send it via Resend.
 * The body parameter is the same JSON string used for webhook delivery
 * (`{ event, timestamp, data }`) — we parse it and pass the fields
 * into the template as props.
 *
 * The send carries a Resend idempotency key (t-822): a timed-out attempt that
 * Resend in fact accepted is not sent again by the automatic retry. The key
 * names the row's `sendGeneration`, so a manual retry or DLQ replay (which
 * bump it) sends again, and the address, so a retry after the subscription's
 * address was edited is a send to the new one. Resend refuses a reused key
 * whose request differs, so the email shows the row's `createdAt`, not the
 * body's per-attempt timestamp. Resend keeps a key for 24 hours, so a retry
 * a policy schedules more than 24 hours after the first attempt sends again.
 */
async function attemptEmailDelivery(
  record: AttemptRecord,
  sub: SubscriptionLike,
  body: string
): Promise<DeliveryOutcome> {
  if (!sub.emailAddress) {
    return {
      delivered: false,
      terminal: true,
      error: 'Email subscription has no destination address',
    };
  }
  if (!isEmailEnabled()) {
    // No Resend key configured — terminal because the receiver retry
    // loop can't fix a missing env var; only admin action can.
    return {
      delivered: false,
      terminal: true,
      error: 'Email is not configured (RESEND_API_KEY / EMAIL_FROM missing)',
    };
  }

  let event: string;
  let data: Record<string, unknown>;
  const timestamp = record.createdAt.toISOString();
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    event = typeof parsed.event === 'string' ? parsed.event : 'unknown';
    data = toJsonRecord(parsed.data);
  } catch (err) {
    return {
      delivered: false,
      error: `Failed to parse stored payload: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const resend = getResendClient();
  if (!resend) {
    return { delivered: false, error: 'Resend client unavailable' };
  }

  const to = sub.emailAddress;
  const idempotencyKey = emailIdempotencyKey(record, to);
  try {
    // Bounded, render and send together, so the attempt ends well inside the
    // retry claim's lease and no second sender claims the row while it is
    // still out (t-808). The signal stops the SDK's request; the race ends the
    // attempt even if something ignores it. Expiry is retriable, like any
    // other failed send.
    const result = await withTimeout(DISPATCH_TIMEOUT_MS.email, 'Email send', async (signal) => {
      const html = await render(EventNotification({ event, timestamp, data }));
      const subject = buildEmailSubject(event, data);
      return resend.emails.send(
        { from: getDefaultSender(), to, subject, html },
        { signal, idempotencyKey }
      );
    });

    // Resend returns `{ data: { id }, error: null }` on success.
    if (result.error) {
      return { delivered: false, error: result.error.message ?? 'Resend rejected the email' };
    }
    return { delivered: true };
  } catch (err) {
    return { delivered: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The Resend idempotency key for one send of a delivery to `to`. The address
 * goes in as a hash: the key is stored by Resend and shown in its dashboard.
 */
function emailIdempotencyKey(record: AttemptRecord, to: string): string {
  const addressHash = createHash('sha256').update(to.trim().toLowerCase()).digest('hex');
  return `webhook-delivery/${record.id}/${record.sendGeneration}/${addressHash.slice(0, 16)}`;
}

/**
 * Schedule an in-process retry via setTimeout.
 *
 * Re-reads the delivery and subscription from the DB so the retry uses
 * a fresh timestamp (for HMAC freshness) and the current subscription
 * URL/secret (in case they were updated between attempts). The attempt
 * records the destination it used, so an edited URL is on the row.
 *
 * The timeout is unref'd so it doesn't prevent Node from exiting.
 * If the process restarts before the retry fires, `processPendingRetries()`
 * will pick it up on the next tick.
 */
function scheduleRetry(
  deliveryId: string,
  subscriptionId: string,
  delayMs: number,
  armedFor: Date
): void {
  const timer = setTimeout(
    () =>
      void (async () => {
        try {
          // Before the reads: the subscription is this attempt's copy (t-886).
          const takenAt = new Date();
          const [delivery, sub] = await Promise.all([
            prisma.aiWebhookDelivery.findUnique({ where: { id: deliveryId } }),
            prisma.aiWebhookSubscription.findUnique({ where: { id: subscriptionId } }),
          ]);
          // No longer the retry this timer was armed for: stopped by an
          // erasure, delivered, or retried by hand or by the tick in the
          // meantime. See `isArmedRetry`.
          if (delivery && !isArmedRetry(delivery, armedFor)) return;
          if (!delivery || !sub || !sub.isActive) {
            if (delivery) {
              // Conditional: an erasure that stopped the row since it was read
              // keeps its mark, which a manual retry reads (t-793).
              await prisma.aiWebhookDelivery.updateMany({
                where: { id: deliveryId, status: { in: [...AWAITING_RETRY_STATUSES] } },
                data: {
                  status: 'exhausted',
                  nextRetryAt: null,
                  lastError: sub
                    ? 'Subscription deactivated'
                    : notRetried(delivery.lastError, SUBSCRIPTION_DELETED),
                },
              });
            }
            return;
          }
          // Claimed, so the maintenance tick or a manual retry racing this
          // timer does not send the row as well (t-793).
          // The claim returns the row as it wrote it; its payload is the one
          // sent, as an erasure may have redacted the copy read above.
          const [claimed] = await prisma.aiWebhookDelivery.updateManyAndReturn(
            claimArmedRetry(deliveryId, armedFor)
          );
          if (!claimed) return;
          const storedPayload = toJsonRecord(claimed.payload);
          const body = JSON.stringify({
            ...storedPayload,
            timestamp: new Date().toISOString(),
          });
          await attemptDelivery(claimed, sub, body, resolveRetryPolicy(sub), takenAt);
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
