/**
 * An org's billing as its own admins see it (§139 t-1095): the plan it is on,
 * the subscription's state and period, usage against each limit, the plans
 * it could buy, and what this viewer may do about it. One read, so the
 * console's billing page makes one call (`GET /api/v1/orgs/[id]/billing`).
 *
 * It decides nothing new. Whether the viewer may buy or open the portal is
 * {@link assertMayChangeBilling}'s answer, asked here rather than restated,
 * and the checkout and portal routes ask it again when they are called.
 *
 * @see .context/billing/billing.md#the-billing-page
 */

import type { BillingSubscriptionStatus } from '@prisma/client';

import { ConflictError, ForbiddenError } from '@/lib/api/errors';
import type { AuthenticatedSession } from '@/lib/auth/guards';
import { billingProviderState } from '@/lib/billing/config';
import { assertMayChangeBilling } from '@/lib/billing/org-access';
import { planOf, registeredPlans } from '@/lib/billing/plans';
import { loadOrgSubscription, type OrgSubscriptionView } from '@/lib/billing/subscriptions';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { loadOrgMeterUsage, type MeterUsage } from '@/lib/tenancy/meters';

/** A plan as the billing page shows it. */
export interface OrgBillingPlan {
  key: string;
  label: string;
  description: string;
  /** The plan the org is on. */
  current: boolean;
}

/** One meter's usage against its limit, as the billing page shows it. */
export type OrgBillingUsage = Pick<
  MeterUsage,
  'key' | 'label' | 'description' | 'period' | 'limit' | 'used' | 'countFailed'
>;

/** What `GET /api/v1/orgs/[id]/billing` answers. */
export interface OrgBilling {
  orgId: string;
  /**
   * The plan the org is on, or `null` for none. Its label is the app's, or
   * `null` for a key the app no longer registers (the key is kept).
   */
  plan: { key: string; label: string | null; description: string } | null;
  /**
   * The subscription's state; `null` when there is none to show: no record,
   * or one naming no plan that the provider has never written to (a checkout
   * that was abandoned, or a plan staff removed).
   */
  subscription: {
    status: BillingSubscriptionStatus;
    /** Paid through the provider and not yet ended: change it in the portal. */
    providerManaged: boolean;
    /**
     * That subscription is at a provider other than this install's, so this
     * install's portal cannot open it and its checkout refuses until it ends.
     */
    elsewhere: boolean;
    /** Platform staff put the org on it by hand: no provider subscription is behind it. */
    assignedByHand: boolean;
    /** Ends when the current period does (cancelled in the portal). */
    cancelAtPeriodEnd: boolean;
    periodStart: Date | null;
    periodEnd: Date | null;
  } | null;
  /** Every meter's usage and limit; `null` when the counts could not be read. */
  usage: OrgBillingUsage[] | null;
  /** The plans with a price, which an owner can buy. */
  plans: OrgBillingPlan[];
  /** This viewer may start a checkout and open the portal: the org's OWNER, acting in it. */
  mayChange: boolean;
  /**
   * The org has a customer at this install's provider and a subscription to
   * show, so the portal has something to open.
   */
  portalAvailable: boolean;
  /**
   * The org's customer is at a provider this install no longer uses, so its
   * payments and invoices cannot be managed here, live subscription or not.
   */
  customerElsewhere: boolean;
  /** The install org, which is the vendor's own and is never billed. */
  installOrg: boolean;
}

/**
 * Whether {@link assertMayChangeBilling} lets this session change the org's
 * billing. Only its refusals mean no; anything else it throws is a fault, and
 * is thrown on rather than shown as a read-only page.
 */
function mayChangeBilling(session: AuthenticatedSession, orgId: string): boolean {
  try {
    assertMayChangeBilling(session, orgId);
    return true;
  } catch (error) {
    if (error instanceof ForbiddenError || error instanceof ConflictError) return false;
    throw error;
  }
}

/**
 * The org's usage, or `null` when it could not be read. A failed count is the
 * usage card's to report: the plan, its status and the portal still show.
 */
async function loadUsage(orgId: string): Promise<Awaited<ReturnType<typeof loadOrgMeterUsage>>> {
  try {
    return await loadOrgMeterUsage(orgId);
  } catch (error) {
    logger.error("billing: could not read the org's usage for its billing page", {
      orgId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Whether the record has a subscription state worth showing. A record that
 * names no plan and that the provider has never written to holds only a
 * customer: a first checkout abandoned (`startCheckout()` links the customer
 * before payment) or a plan staff removed (`assignPlan(null)`). Its status is
 * the schema's default, not anything that happened.
 */
function hasSubscriptionToShow(record: OrgSubscriptionView | null): record is OrgSubscriptionView {
  return record !== null && (record.planKey !== null || record.providerStatus !== null);
}

/**
 * Whether platform staff put the org on its plan. Every provider write
 * records the provider's word for the state, and `assignPlan()` clears it and
 * writes `ACTIVE`. A checkout's customer link clears it too but leaves the
 * status, so a plan the webhook set when a subscription lapsed (status
 * `ENDED`) is not mistaken for one staff assigned.
 */
function isAssignedByHand(record: OrgSubscriptionView): boolean {
  return (
    record.planKey !== null &&
    record.providerStatus === null &&
    record.status === 'ACTIVE' &&
    !record.providerManaged
  );
}

/**
 * The org's billing for this viewer, or `null` when there is no such org.
 * Call only while billing is on: the route answers `billing_off` before this.
 */
export async function loadOrgBilling(
  orgId: string,
  session: AuthenticatedSession
): Promise<OrgBilling | null> {
  // `Org` is a system model, so this read needs no tenant scope.
  const org = await prisma.org.findUnique({ where: { id: orgId }, select: { id: true } });
  if (!org) return null;

  const [record, usage] = await Promise.all([loadOrgSubscription(orgId), loadUsage(orgId)]);
  const state = billingProviderState();
  const planKey = record?.planKey ?? null;
  const current = planKey === null ? undefined : planOf(planKey);

  return {
    orgId,
    plan:
      planKey === null
        ? null
        : {
            key: planKey,
            label: current?.label ?? null,
            description: current?.description ?? '',
          },
    subscription: hasSubscriptionToShow(record)
      ? {
          status: record.status,
          providerManaged: record.providerManaged,
          elsewhere: record.providerManaged && record.provider !== state.providerKey,
          assignedByHand: isAssignedByHand(record),
          cancelAtPeriodEnd: record.cancelAtPeriodEnd,
          periodStart: record.periodStart,
          periodEnd: record.periodEnd,
        }
      : null,
    usage:
      usage?.meters.map((meter) => ({
        key: meter.key,
        label: meter.label,
        description: meter.description,
        period: meter.period,
        limit: meter.limit,
        used: meter.used,
        countFailed: meter.countFailed,
      })) ?? null,
    plans: registeredPlans()
      .filter((plan) => plan.priceLookupKey !== null)
      .map((plan) => ({
        key: plan.key,
        label: plan.label,
        description: plan.description,
        current: plan.key === planKey,
      })),
    mayChange: mayChangeBilling(session, orgId),
    // A customer alone is not enough: a first checkout links one before any
    // payment, and its portal would hold nothing.
    portalAvailable:
      state.on &&
      hasSubscriptionToShow(record) &&
      record.hasCustomer &&
      record.provider === state.providerKey,
    customerElsewhere:
      record !== null && record.hasCustomer && record.provider !== state.providerKey,
    installOrg: orgId === INSTALL_ORG_ID,
  };
}
