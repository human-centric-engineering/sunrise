/**
 * The org's subscription record, and platform staff assigning a plan by hand
 * (§139 t-1093).
 *
 * `OrgBillingSubscription` says which plan an org is on. Staff assign one
 * here; t-1094's webhook will be the second writer, for a plan paid through a
 * provider. A plan assigned by hand has no provider subscription behind it,
 * which is how a plan is given away or invoiced offline.
 *
 * **Staff do not override a provider.** While the org's record holds a
 * provider subscription that has not ended, its plan follows that
 * subscription; a hand assignment is refused with `PROVIDER_MANAGED`, and the
 * plan is changed at the provider. Once it has ended, staff may assign one;
 * the provider and customer references are kept, so a later erasure still
 * finds the customer.
 *
 * **Order of writes.** The record is written with `planAppliedAt` cleared,
 * then the plan is applied, then `planAppliedAt` is set. A failure between
 * leaves the record naming the plan with `planAppliedAt` null, which the
 * admin page shows, and assigning it again finishes the write. Re-assigning
 * a plan that is fully applied writes nothing at all.
 *
 * Every read and write of the record runs as the org (`runAsOrg`), since the
 * table is tenant-owned and the caller is usually a platform admin acting
 * from the install org.
 *
 * @see lib/billing/plans.ts · lib/billing/apply-plan.ts
 * @see .context/billing/billing.md
 */

import type { BillingSubscriptionStatus } from '@prisma/client';

import { applyPlan, type PlanApplied } from '@/lib/billing/apply-plan';
import { billingPlansEnabled, planOf } from '@/lib/billing/plans';
import { prisma } from '@/lib/db/client';
import { runAsOrg } from '@/lib/tenancy/context';

/** The org's subscription record, as the platform reads it. */
export interface OrgSubscriptionView {
  planKey: string | null;
  /** The provider holding the subscription; `null` when assigned by hand. */
  provider: string | null;
  /** Whether a provider subscription that has not ended decides the plan. */
  providerManaged: boolean;
  status: BillingSubscriptionStatus;
  periodStart: Date | null;
  periodEnd: Date | null;
  /** When the plan was last written to the org; `null` while a write has not finished. */
  planAppliedAt: Date | null;
  updatedAt: Date;
}

/** Why {@link assignPlan} refused. Nothing was written. */
export type BillingPlanErrorCode =
  'BILLING_OFF' | 'UNKNOWN_PLAN' | 'PROVIDER_MANAGED' | 'ORG_NOT_FOUND';

export class BillingPlanError extends Error {
  constructor(
    readonly code: BillingPlanErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'BillingPlanError';
  }
}

const SUBSCRIPTION_SELECT = {
  planKey: true,
  provider: true,
  subscriptionRef: true,
  status: true,
  periodStart: true,
  periodEnd: true,
  planAppliedAt: true,
  updatedAt: true,
} as const;

type SubscriptionRow = {
  planKey: string | null;
  provider: string | null;
  subscriptionRef: string | null;
  status: BillingSubscriptionStatus;
  periodStart: Date | null;
  periodEnd: Date | null;
  planAppliedAt: Date | null;
  updatedAt: Date;
};

function isProviderManaged(row: Pick<SubscriptionRow, 'subscriptionRef' | 'status'>): boolean {
  return row.subscriptionRef !== null && row.status !== 'ENDED';
}

function toView(row: SubscriptionRow): OrgSubscriptionView {
  return {
    planKey: row.planKey,
    provider: row.provider,
    providerManaged: isProviderManaged(row),
    status: row.status,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    planAppliedAt: row.planAppliedAt,
    updatedAt: row.updatedAt,
  };
}

/** The org's subscription record, or `null` when it has none. */
export async function loadOrgSubscription(orgId: string): Promise<OrgSubscriptionView | null> {
  const row = await runAsOrg(orgId, () =>
    prisma.orgBillingSubscription.findUnique({ where: { orgId }, select: SUBSCRIPTION_SELECT })
  );
  return row ? toView(row) : null;
}

/** What {@link assignPlan} did. */
export interface AssignPlanResult {
  previousPlanKey: string | null;
  planKey: string | null;
  /** Whether the record or any setting changed; `false` means nothing was written. */
  changed: boolean;
  /** What the plan wrote to the org; `null` when no plan was applied (`planKey: null`). */
  applied: PlanApplied | null;
  subscription: OrgSubscriptionView | null;
}

/**
 * Put an org on a plan by hand, or take it off one (`planKey: null`).
 *
 * Taking an org off its plan deletes the hand-assigned record and leaves its
 * switches, limits and budget as they are: the plan stops being named, and
 * what it gave stays until someone changes it. It decides nothing about who
 * may: the route asks `mayChangeOrgCommercialSettings()` first.
 *
 * @throws {BillingPlanError} `BILLING_OFF` when plans do not apply on this
 *   install, `UNKNOWN_PLAN`, `PROVIDER_MANAGED`, or `ORG_NOT_FOUND`.
 *   A clash with a concurrent settings write throws `P2034`
 *   (`isSettingsWriteConflict`), after the record was written: assigning
 *   again finishes it.
 */
export async function assignPlan(orgId: string, planKey: string | null): Promise<AssignPlanResult> {
  if (!billingPlansEnabled()) {
    throw new BillingPlanError(
      'BILLING_OFF',
      'Plans are off on this install: they need TENANCY_MODE=multi and at least one plan registered in lib/app/billing.ts'
    );
  }
  const plan = planKey === null ? null : (planOf(planKey) ?? undefined);
  if (plan === undefined) {
    throw new BillingPlanError('UNKNOWN_PLAN', `No plan has the key ${String(planKey)}`);
  }
  // `Org` is a system model, so this read needs no tenant scope.
  const org = await prisma.org.findUnique({ where: { id: orgId }, select: { id: true } });
  if (!org) throw new BillingPlanError('ORG_NOT_FOUND', 'Organisation not found');

  return runAsOrg(orgId, async () => {
    const current = await prisma.orgBillingSubscription.findUnique({
      where: { orgId },
      select: SUBSCRIPTION_SELECT,
    });
    if (current && isProviderManaged(current)) {
      throw new BillingPlanError(
        'PROVIDER_MANAGED',
        `This organisation pays for its plan through ${current.provider ?? 'a payment provider'}, so its plan follows that subscription. Change it there.`
      );
    }
    const previousPlanKey = current?.planKey ?? null;

    if (plan === null) {
      if (!current) {
        return {
          previousPlanKey,
          planKey: null,
          changed: false,
          applied: null,
          subscription: null,
        };
      }
      await prisma.orgBillingSubscription.delete({ where: { orgId } });
      return { previousPlanKey, planKey: null, changed: true, applied: null, subscription: null };
    }

    // A record already naming this plan, by hand and fully applied, is left
    // untouched unless applying finds something to change.
    const recordMatches =
      current !== null &&
      current.planKey === plan.key &&
      current.subscriptionRef === null &&
      current.status === 'ACTIVE' &&
      current.planAppliedAt !== null;

    if (!recordMatches) {
      // The provider and customer stay, so an ended subscription's customer
      // is still found at erasure; the subscription and its period go.
      const handAssigned = {
        planKey: plan.key,
        subscriptionRef: null,
        status: 'ACTIVE' as const,
        periodStart: null,
        periodEnd: null,
        planAppliedAt: null,
      };
      await prisma.orgBillingSubscription.upsert({
        where: { orgId },
        create: { orgId, ...handAssigned },
        update: handAssigned,
      });
    }

    const applied = await applyPlan(orgId, plan);
    if (applied === null) throw new BillingPlanError('ORG_NOT_FOUND', 'Organisation not found');

    if (recordMatches && !applied.changed) {
      return {
        previousPlanKey,
        planKey: plan.key,
        changed: false,
        applied,
        subscription: toView(current),
      };
    }
    const row = await prisma.orgBillingSubscription.update({
      where: { orgId },
      data: { planAppliedAt: new Date() },
      select: SUBSCRIPTION_SELECT,
    });
    return {
      previousPlanKey,
      planKey: plan.key,
      changed: true,
      applied,
      subscription: toView(row),
    };
  });
}
