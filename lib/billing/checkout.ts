/**
 * Checkout and the customer portal for an org (§139 t-1094).
 *
 * Both hand back a URL on the provider's own pages, so card details never
 * reach the platform. Which plan the org ends up on is decided by the
 * webhook from the subscription the provider holds, never by the checkout.
 *
 * **One subscription per org.** A checkout takes the org's billing lock (the
 * one the webhook and a hand assignment take) and lists every live
 * subscription of the org's customer at the provider, not only the stored
 * one, whose webhook may not have landed: an `active` or `past_due` one is
 * refused, and the owner is sent to the portal; an `incomplete` one, or one
 * that has ended and can still be resumed or charged (paused, unpaid), is
 * cancelled once the new checkout exists; one that has ended for good, or
 * none, does not stop it. The adapter also closes the customer's other open
 * checkout pages, so two tabs cannot both be paid. So the org never has two
 * live subscriptions.
 *
 * Who may call these is the routes' business: an org OWNER, acting in the org.
 *
 * @see .context/billing/billing.md#webhooks — "One subscription per org"
 */

import { Prisma } from '@prisma/client';

import { getPublicUrl } from '@/lib/api/server-fetch';
import { billingProvider } from '@/lib/billing/config';
import { planOf } from '@/lib/billing/plans';
import { BillingPriceMissingError } from '@/lib/billing/provider';
import { lockOrgBilling } from '@/lib/billing/subscriptions';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { runAsOrg } from '@/lib/tenancy/context';

/**
 * Where the provider sends the owner back to: the billing page of the
 * org-admin console (t-1095).
 */
export const ORG_BILLING_PAGE_PATH = '/admin/billing';

/** Why a checkout or portal was refused. Nothing was created at the provider. */
export type BillingCheckoutErrorCode =
  | 'BILLING_OFF'
  | 'UNKNOWN_PLAN'
  | 'NOT_PURCHASABLE'
  | 'PRICE_MISSING'
  | 'ALREADY_SUBSCRIBED'
  | 'NO_CUSTOMER'
  | 'ORG_NOT_FOUND';

export class BillingCheckoutError extends Error {
  constructor(
    readonly code: BillingCheckoutErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'BillingCheckoutError';
  }
}

/** The lock is held across the provider's calls, so the timeout is well above a few. */
const CHECKOUT_TRANSACTION = {
  isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
  maxWait: 10_000,
  timeout: 60_000,
} as const;

function billingPage(query: string): string {
  return `${getPublicUrl().replace(/\/+$/, '')}${ORG_BILLING_PAGE_PATH}${query}`;
}

/**
 * Start a hosted checkout for `planKey`. Creates the org's customer at the
 * provider on first use and stores its reference.
 *
 * @throws {BillingCheckoutError}
 */
export async function startCheckout(orgId: string, planKey: string): Promise<{ url: string }> {
  const provider = await billingProvider();
  if (!provider) throw new BillingCheckoutError('BILLING_OFF', 'Billing is not switched on');
  const plan = planOf(planKey);
  if (!plan) throw new BillingCheckoutError('UNKNOWN_PLAN', `No plan has the key ${planKey}`);
  const priceLookupKey = plan.priceLookupKey;
  if (priceLookupKey === null) {
    throw new BillingCheckoutError(
      'NOT_PURCHASABLE',
      `The ${plan.label} plan has no price, so it cannot be bought. Platform staff assign it.`
    );
  }
  // `Org` is a system model, so this read needs no tenant scope.
  const org = await prisma.org.findUnique({ where: { id: orgId }, select: { name: true } });
  if (!org) throw new BillingCheckoutError('ORG_NOT_FOUND', 'Organisation not found');

  return runAsOrg(orgId, () =>
    prisma.$transaction(async (tx) => {
      if (!(await lockOrgBilling(tx, orgId))) {
        throw new BillingCheckoutError('ORG_NOT_FOUND', 'Organisation not found');
      }
      const record = await tx.orgBillingSubscription.findUnique({
        where: { orgId },
        select: { provider: true, customerRef: true },
      });
      const sameProvider = record?.provider === provider.key;

      const customerRef = sameProvider ? record.customerRef : null;

      // Every live subscription of the customer, not only the stored one: a
      // subscription whose webhook has not landed yet is not stored, and a
      // second checkout over it would leave the org paying twice (review
      // round 1). The stored status is the neutral one, so ask the provider.
      const live = customerRef === null ? [] : await provider.listLiveSubscriptions(customerRef);
      if (live.some((s) => s.status === 'active' || s.status === 'past_due')) {
        throw new BillingCheckoutError(
          'ALREADY_SUBSCRIBED',
          'This organisation already has a subscription. Change its plan in the billing portal.'
        );
      }

      let checkout: { url: string; customerRef: string };
      try {
        checkout = await provider.createCheckout({
          orgId,
          orgName: org.name,
          customerRef,
          priceLookupKey,
          successUrl: billingPage('?checkout=success'),
          cancelUrl: billingPage('?checkout=cancelled'),
        });
      } catch (error) {
        if (error instanceof BillingPriceMissingError) {
          logger.error('billing: the plan’s price is not set up at the provider', {
            provider: provider.key,
            planKey,
            priceLookupKey,
          });
          throw new BillingCheckoutError(
            'PRICE_MISSING',
            `The ${plan.label} plan cannot be bought yet: its price is not set up at the payment provider. Ask platform staff to set it up.`
          );
        }
        throw error;
      }

      // An unfinished first payment, or a paused or unpaid subscription, is
      // replaced so the org never has two live subscriptions. Only once the
      // new checkout exists: cancelled first, a checkout that then failed
      // would have cost the org its paused trial for nothing (review round 1).
      for (const replaced of live) {
        await provider.cancelSubscription(replaced.ref);
        logger.info('billing: cancelled an unfinished subscription to start a new checkout', {
          provider: provider.key,
          orgId,
          subscriptionRef: replaced.ref,
          providerStatus: replaced.providerStatus,
        });
      }

      if (!sameProvider || record.customerRef !== checkout.customerRef) {
        if (record?.customerRef && record.customerRef !== checkout.customerRef) {
          logger.warn('billing: the organisation’s customer reference is replaced', {
            orgId,
            from: { provider: record.provider, customerRef: record.customerRef },
            to: { provider: provider.key, customerRef: checkout.customerRef },
          });
        }
        const link = { provider: provider.key, customerRef: checkout.customerRef };
        await tx.orgBillingSubscription.upsert({
          where: { orgId },
          create: { orgId, ...link },
          update: link,
        });
      }
      return { url: checkout.url };
    }, CHECKOUT_TRANSACTION)
  );
}

/**
 * Open the provider's customer portal for the org.
 *
 * @throws {BillingCheckoutError} `BILLING_OFF`, or `NO_CUSTOMER` when the org
 *   has never been through a checkout with this provider.
 */
export async function openBillingPortal(orgId: string): Promise<{ url: string }> {
  const provider = await billingProvider();
  if (!provider) throw new BillingCheckoutError('BILLING_OFF', 'Billing is not switched on');
  const record = await runAsOrg(orgId, () =>
    prisma.orgBillingSubscription.findUnique({
      where: { orgId },
      select: { provider: true, customerRef: true },
    })
  );
  if (record?.provider !== provider.key || record.customerRef === null) {
    throw new BillingCheckoutError(
      'NO_CUSTOMER',
      'This organisation has not subscribed yet, so there is no billing portal to open.'
    );
  }
  return provider.openPortal({
    customerRef: record.customerRef,
    returnUrl: billingPage(''),
  });
}
