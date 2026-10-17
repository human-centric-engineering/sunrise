/**
 * Webhook subscription access authorization (t-782).
 *
 * Single source of truth for "which webhook subscriptions may this admin see
 * and manage?" — the list, the detail, edit, delete, the test send, the
 * per-subscription delivery history and the DLQ's replay-by-subscription.
 *
 * Subscriptions are scoped to the admin who created them. An admin may see a
 * subscription iff
 *
 *   1. it is theirs (`createdBy === adminUserId`), OR
 *   2. it has **no** creator (`createdBy IS NULL`) and the authorization policy
 *      permits them an unattributed read
 *      (`session.unattributedReads.webhookSubscription`).
 *
 * Never another admin's subscription. "Belongs to nobody" is a third case, not
 * a softer way of saying "belongs to someone else" — see
 * `lib/auth/orphan-reads.ts`.
 *
 * **Why a null creator happens here.** `AiWebhookSubscription.createdBy` is
 * `onDelete: SetNull`: erasing the admin who set up an integration must not
 * silently stop it (a CRM feed, an escalation pager), so the subscription
 * outlives its creator and keeps delivering. Left owner-only, it would then be
 * invisible to everyone and unmanageable by anyone — running, with nobody able
 * to switch it off. The default policy admits platform admins; a fork that
 * wants an org's own admins to inherit their departed colleague's integrations
 * widens it by registering a policy, not by editing these routes.
 *
 * **`'orphan'`, the `SetNull` vocabulary** (as for datasets, experiments and
 * webhook deliveries): a subscription is never *born* without a creator — the
 * create route stamps the caller — so a null can only mean the creator was
 * erased.
 *
 * @see `.context/auth/authorization.md` — the roster of access helpers
 * @see `.context/admin/orchestration-webhooks.md`
 */

import type { Prisma } from '@prisma/client';
import type { AuthenticatedSession } from '@/lib/auth/guards';

/** Why an admin may see a webhook subscription. */
export type WebhookSubscriptionAccessBasis = 'owner' | 'orphan';

/** The subset of a subscription row this module needs. */
export interface WebhookSubscriptionOwner {
  createdBy: string | null;
}

/**
 * Prisma `where` fragment selecting the subscriptions this admin may see.
 *
 * Synchronous: the guard resolved `session.unattributedReads` before the
 * handler ran. Compose with `AND` when adding filters, so a caller-supplied
 * filter cannot flatten the visibility clause — on the widened branch the
 * fragment's key is `OR`, exactly the key a spread of further filters would
 * replace:
 *
 * ```ts
 * const where = { AND: [webhookSubscriptionVisibilityWhere(session), { id }] };
 * ```
 */
export function webhookSubscriptionVisibilityWhere(
  session: AuthenticatedSession
): Prisma.AiWebhookSubscriptionWhereInput {
  const mine = { createdBy: session.user.id };

  return session.unattributedReads.webhookSubscription ? { OR: [mine, { createdBy: null }] } : mine;
}

/**
 * Why the admin may see this subscription, or `null` when they may not.
 *
 * Re-asks the record, as `webhookDeliveryAccessBasis` does: a caller that
 * fetched a row by id and then decides must not read a null creator as proof
 * the policy said yes.
 */
export function webhookSubscriptionAccessBasis(
  subscription: WebhookSubscriptionOwner | null | undefined,
  session: AuthenticatedSession
): WebhookSubscriptionAccessBasis | null {
  if (!subscription) return null;
  if (subscription.createdBy === null) {
    return session.unattributedReads.webhookSubscription ? 'orphan' : null;
  }
  return subscription.createdBy === session.user.id ? 'owner' : null;
}
