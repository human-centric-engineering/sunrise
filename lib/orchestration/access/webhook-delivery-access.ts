/**
 * Webhook delivery access authorization (§109 t-739).
 *
 * Single source of truth for "which webhook deliveries may this admin see?" —
 * the dead-letter list, its stats, bulk replay, retry and discard.
 *
 * Webhook subscriptions are scoped to the admin who created them, and a
 * delivery is owned **through** its subscription. An admin may see a delivery
 * iff
 *
 *   1. its subscription is theirs (`subscription.createdBy === adminUserId`), OR
 *   2. it has **no** subscription (`subscriptionId IS NULL`) and the
 *      authorization policy permits them an unattributed read
 *      (`session.unattributedReads.webhookDelivery`).
 *
 * Never another admin's delivery. "Belongs to nobody" is a third case, not a
 * softer way of saying "belongs to someone else" — see
 * `lib/auth/orphan-reads.ts`.
 *
 * **Why a null owner happens here.** `AiWebhookDelivery.subscriptionId` is
 * `onDelete: SetNull`: deleting a subscription, or erasing the admin who
 * created it (its `createdBy` cascades), keeps the delivery as the record of
 * where an event went and drops the link. Left owner-only, those rows would be
 * invisible to everyone and deletable by nobody. The default policy admits
 * platform admins; a fork narrows it by registering a policy, not by editing
 * these routes.
 *
 * **`'orphan'`, the `SetNull` vocabulary** (as for datasets and experiments): a
 * delivery is never *born* without a subscription, so a null can only mean the
 * subscription went away.
 *
 * Event-hook deliveries have no equivalent: hooks are admin-global (every
 * admin reads every hook's deliveries), so there is no owner clause for an
 * orphan to fall outside of.
 *
 * @see `.context/auth/authorization.md` — the roster of access helpers
 * @see `.context/admin/orchestration-webhooks.md#where-a-delivery-went`
 */

import type { Prisma } from '@prisma/client';
import type { AuthenticatedSession } from '@/lib/auth/guards';

/** Why an admin may see a webhook delivery. */
export type WebhookDeliveryAccessBasis = 'owner' | 'orphan';

/** The subset of a delivery row this module needs. */
export interface WebhookDeliveryOwner {
  subscription: { createdBy: string } | null;
}

/**
 * Prisma `where` fragment selecting the deliveries this admin may see.
 *
 * Synchronous: the guard resolved `session.unattributedReads` before the handler
 * ran. Compose with `AND` when adding filters, so a caller-supplied filter
 * cannot flatten the visibility clause — on the widened branch the fragment's
 * key is `OR`, exactly the key a spread of further filters would replace:
 *
 * ```ts
 * const where = { AND: [webhookDeliveryVisibilityWhere(session), filters] };
 * ```
 */
export function webhookDeliveryVisibilityWhere(
  session: AuthenticatedSession
): Prisma.AiWebhookDeliveryWhereInput {
  const mine = { subscription: { createdBy: session.user.id } };

  return session.unattributedReads.webhookDelivery
    ? { OR: [mine, { subscriptionId: null }] }
    : mine;
}

/**
 * Why the admin may see this delivery, or `null` when they may not.
 *
 * Unlike `experimentAccessBasis`, this **does** re-ask the record: the retry and
 * discard routes fetch a delivery by id and then decide, so a null subscription
 * there is a fact about the column, not proof the policy said yes.
 */
export function webhookDeliveryAccessBasis(
  delivery: WebhookDeliveryOwner | null | undefined,
  session: AuthenticatedSession
): WebhookDeliveryAccessBasis | null {
  if (!delivery) return null;
  if (delivery.subscription === null) {
    return session.unattributedReads.webhookDelivery ? 'orphan' : null;
  }
  return delivery.subscription.createdBy === session.user.id ? 'owner' : null;
}
