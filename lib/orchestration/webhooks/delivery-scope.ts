/**
 * Which webhook deliveries an admin's delivery and dead-letter routes reach.
 *
 * Subscriptions are scoped to the admin who created them, and so are their
 * deliveries. A delivery whose subscription was deleted has no creator left to
 * scope by (§109 t-739: the row now outlives its subscription), so it would
 * otherwise vanish from every list. It is shown to every admin instead: it is a
 * record of where the org's data went, not anyone's configuration. At
 * `TENANCY_MODE=multi`, row isolation still confines it to its own org.
 *
 * Platform-agnostic: no Next.js imports.
 */

import type { Prisma } from '@prisma/client';

/** The `where` fragment that limits deliveries to those `userId` may see. */
export function webhookDeliveriesVisibleTo(userId: string): Prisma.AiWebhookDeliveryWhereInput {
  return { OR: [{ subscription: { createdBy: userId } }, { subscriptionId: null }] };
}

/** The same rule, for one row already read with its parent's `createdBy`. */
export function isWebhookDeliveryVisibleTo(
  delivery: { subscription: { createdBy: string } | null },
  userId: string
): boolean {
  return delivery.subscription === null || delivery.subscription.createdBy === userId;
}
