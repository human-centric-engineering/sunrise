/**
 * Cancel an org's subscriptions at the payment provider before it is erased
 * (§139 t-1094).
 *
 * Erasing an org deletes its billing records, and with them the platform's
 * only link to its customer at the provider. Without this the provider would
 * go on charging a card for an org that no longer exists. So `eraseOrg()`
 * calls {@link cancelOrgSubscriptionsAtProvider} before it deletes anything,
 * and a failure here stops the erasure: nothing is deleted, and erasing
 * again retries.
 *
 * Every customer of the org is found: the stored reference, and any whose
 * metadata names the org (`findCustomerRefs`), which covers a customer whose
 * reference was never stored. Every `live` subscription of each is
 * cancelled, not only the stored one, so an `unpaid` or paused one ends too.
 * One that has already ended, or that the provider no longer has, counts as
 * cancelled, so a lapsed org's erasure is not stuck.
 *
 * **Known gap:** the provider's customer search can lag a new customer by
 * about a minute, so a checkout started just before erasure may not be
 * found. Its webhook then names an org that no longer exists and is dropped,
 * and the subscription has to be cancelled by hand. The search's result is
 * logged so the gap can be checked.
 *
 * @see .context/billing/billing.md#privacy
 */

import { APIError } from '@/lib/api/errors';
import { billingProvider } from '@/lib/billing/config';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { runAsOrg } from '@/lib/tenancy/context';

/**
 * Erasure refused because the org may still be paying and billing is off, so
 * there is no provider to cancel it with. A 409 through the route's envelope.
 */
export class BillingErasureError extends APIError {
  constructor(message: string) {
    super(message, 'BILLING_NOT_CANCELLED', 409, { reason: 'billing_not_cancelled' });
    this.name = 'BillingErasureError';
  }
}

/** What was cancelled. `null` when billing is off and the org holds nothing to cancel. */
export interface ProviderCancellation {
  provider: string;
  customers: string[];
  cancelled: string[];
}

/**
 * Cancel every live subscription of every customer of the org.
 *
 * @throws {BillingErasureError} when billing is off (or on with another
 *   provider) and the org's record holds a subscription that has not ended,
 *   or has ended and can still be charged or resumed
 * @throws whatever the provider throws on any other refusal, so the erasure
 *   stops and can be retried
 */
export async function cancelOrgSubscriptionsAtProvider(
  orgId: string
): Promise<ProviderCancellation | null> {
  const record = await runAsOrg(orgId, () =>
    prisma.orgBillingSubscription.findUnique({
      where: { orgId },
      select: {
        provider: true,
        customerRef: true,
        subscriptionRef: true,
        status: true,
        providerLive: true,
      },
    })
  );
  const provider = await billingProvider();
  // Not ended, or ended and still chargeable (unpaid, paused): either may
  // still be paying, or be resumed (review round 1).
  const holdsLive =
    record !== null &&
    record.subscriptionRef !== null &&
    (record.status !== 'ENDED' || record.providerLive);

  if (!provider || (record?.provider && record.provider !== provider.key)) {
    if (holdsLive) {
      throw new BillingErasureError(
        `This organisation has a subscription at ${record.provider ?? 'a payment provider'} that has not ended, and that provider is not switched on here, so it cannot be cancelled. Switch billing back on (BILLING_PROVIDER and its keys) and erase the organisation again, so its subscription is cancelled first.`
      );
    }
    if (record?.customerRef) {
      logger.warn(
        'billing: erasing an org with a customer at a provider that is not switched on; its subscriptions were not checked',
        { orgId, provider: record.provider }
      );
    }
    return null;
  }

  const found = await provider.findCustomerRefs(orgId);
  const stored = record?.provider === provider.key ? record.customerRef : null;
  const customers = [...new Set([...(stored ? [stored] : []), ...found])];
  logger.info('billing: customers found for org erasure', {
    orgId,
    provider: provider.key,
    stored,
    foundBySearch: found,
  });

  const cancelled: string[] = [];
  for (const customerRef of customers) {
    for (const subscription of await provider.listLiveSubscriptions(customerRef)) {
      await provider.cancelSubscription(subscription.ref);
      cancelled.push(subscription.ref);
    }
  }
  if (cancelled.length > 0) {
    logger.info('billing: cancelled subscriptions before org erasure', {
      orgId,
      provider: provider.key,
      cancelled,
    });
  }
  return { provider: provider.key, customers, cancelled };
}
