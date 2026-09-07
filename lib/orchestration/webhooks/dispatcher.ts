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
import { render } from '@react-email/render';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { describeFetchFailure } from '@/lib/errors/fetch-error';
import { checkSafeProviderUrl } from '@/lib/security/safe-url';
import { getResendClient, getDefaultSender, isEmailEnabled } from '@/lib/email/client';
import EventNotification from '@/emails/event-notification';
import { matchesEntityScope } from '@/lib/orchestration/webhooks/event-entity-keys';
import { noteMaintenanceWork } from '@/lib/orchestration/maintenance/idle-gate';

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

    // Dimension-specific entity scoping: filter out subscriptions whose
    // agent/workflow filters exclude this event. Done in JS (not SQL)
    // because the admin-scoped subs list is small and the rules are
    // dimension-specific — see event-entity-keys.ts for the contract.
    const matched = subscriptions.filter((sub) => matchesEntityScope(eventType, payload, sub));

    if (matched.length === 0) return;

    const body = JSON.stringify({
      event: eventType,
      timestamp: new Date().toISOString(),
      data: payload,
    });

    await Promise.allSettled(
      matched.map(async (sub) => {
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

        await attemptDelivery(delivery.id, sub, body, resolveRetryPolicy(sub));
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
    delivery.subscription,
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
        delivery.subscription,
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
  | { delivered: false; error: string; statusCode?: number; terminal?: boolean };

async function attemptDelivery(
  deliveryId: string,
  sub: SubscriptionLike,
  body: string,
  policy: RetryPolicy
): Promise<void> {
  const now = new Date();

  const outcome: DeliveryOutcome =
    sub.channel === 'email'
      ? await attemptEmailDelivery(sub, body)
      : await attemptWebhookDelivery(sub, body);

  if (outcome.delivered) {
    await prisma.aiWebhookDelivery.update({
      where: { id: deliveryId },
      data: {
        status: 'delivered',
        attempts: { increment: 1 },
        lastAttemptAt: now,
        lastResponseCode: outcome.statusCode ?? null,
        lastError: null,
        nextRetryAt: null,
      },
    });
    return;
  }

  // Delivery failed — update record and maybe schedule retry
  const delivery = await prisma.aiWebhookDelivery.findUnique({
    where: { id: deliveryId },
  });

  if (!delivery) return;

  const newAttempts = delivery.attempts + 1;
  // `terminal` forces exhausted regardless of attempt count.
  const exhausted = outcome.terminal === true || newAttempts >= policy.maxAttempts;

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
      lastResponseCode: outcome.statusCode ?? null,
      lastError: outcome.error,
      nextRetryAt,
    },
  });

  if (!exhausted && nextRetryAt && retryDelay) {
    scheduleRetry(deliveryId, delivery.subscriptionId, retryDelay);
    // The in-process timer above is the normal retry path; the maintenance tick
    // drains anything it loses. Tell the tick's idle gate a row is now waiting,
    // so it does not skip past it (#442).
    noteMaintenanceWork('webhook-delivery-retry');
  }

  logger.warn('Webhook delivery failed', {
    deliveryId,
    channel: sub.channel,
    destination: sub.channel === 'email' ? sub.emailAddress : sub.url,
    attempt: newAttempts,
    maxAttempts: policy.maxAttempts,
    exhausted,
    terminal: outcome.terminal === true,
    error: outcome.error,
    statusCode: outcome.statusCode,
  });
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
 * one — that work is scoped on the `f-mt-external` feature, along with
 * recording the destination on the delivery row (today it is only reachable by
 * joining to a subscription that may since have been edited or deleted).
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
    const timeout = setTimeout(() => controller.abort(), DISPATCH_TIMEOUT_MS);

    try {
      const res = await fetch(sub.url, {
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
      });

      if (res.ok) {
        return { delivered: true, statusCode: res.status };
      }
      return { delivered: false, error: `HTTP ${res.status}`, statusCode: res.status };
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    // undici renders a refused redirect, a DNS failure and a connection reset
    // all as a bare "fetch failed"; the reason lives on `cause`.
    return { delivered: false, error: describeFetchFailure(err) };
  }
}

/**
 * Render the `EventNotification` template and send it via Resend.
 * The body parameter is the same JSON string used for webhook delivery
 * (`{ event, timestamp, data }`) — we parse it and pass the fields
 * into the template as props.
 */
async function attemptEmailDelivery(sub: SubscriptionLike, body: string): Promise<DeliveryOutcome> {
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
  let timestamp: string;
  let data: Record<string, unknown>;
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    event = typeof parsed.event === 'string' ? parsed.event : 'unknown';
    timestamp = typeof parsed.timestamp === 'string' ? parsed.timestamp : new Date().toISOString();
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

  try {
    const html = await render(EventNotification({ event, timestamp, data }));
    const subject = buildEmailSubject(event, data);

    const result = await resend.emails.send({
      from: getDefaultSender(),
      to: sub.emailAddress,
      subject,
      html,
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
          await attemptDelivery(deliveryId, sub, body, resolveRetryPolicy(sub));
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
