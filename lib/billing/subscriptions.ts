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
 * **All or nothing.** An assignment writes the record and the plan's settings
 * in one transaction under the org's locks ({@link assignPlan}), and sets
 * `planAppliedAt` in it, so a hand-assigned record is never left half-applied.
 * Re-assigning a plan that is fully applied writes nothing at all.
 *
 * Every read and write of the record runs as the org (`runAsOrg`), since the
 * table is tenant-owned and the caller is usually a platform admin acting
 * from the install org.
 *
 * @see lib/billing/plans.ts · lib/billing/apply-plan.ts
 * @see .context/billing/billing.md
 */

import { Prisma, type BillingSubscriptionStatus, type PrismaClient } from '@prisma/client';

import { applyPlan, type PlanApplied } from '@/lib/billing/apply-plan';
import { billingPlansEnabled, planOf } from '@/lib/billing/plans';
import { prisma } from '@/lib/db/client';
import { isSerializableConflict } from '@/lib/db/serializable-conflict';
import { forgetOrgCap } from '@/lib/orchestration/llm/spend-caps';
import { runAsOrg } from '@/lib/tenancy/context';

/** The org's subscription record, as the platform reads it. */
export interface OrgSubscriptionView {
  planKey: string | null;
  /**
   * The provider of the org's last paid subscription; `null` when it never
   * had one. It stays after that subscription ends and staff assign a plan
   * by hand, so read {@link providerManaged} for "paid through a provider".
   */
  provider: string | null;
  /** Whether a provider subscription that has not ended decides the plan. */
  providerManaged: boolean;
  status: BillingSubscriptionStatus;
  /** The provider's own word for it (`unpaid`, `trialing`); `null` when assigned by hand. */
  providerStatus: string | null;
  /** Whether a provider subscription ends when its current period does. */
  cancelAtPeriodEnd: boolean;
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
  customerRef: true,
  subscriptionRef: true,
  status: true,
  providerStatus: true,
  cancelAtPeriodEnd: true,
  periodStart: true,
  periodEnd: true,
  planAppliedAt: true,
  updatedAt: true,
} as const;

type SubscriptionRow = {
  planKey: string | null;
  provider: string | null;
  customerRef: string | null;
  subscriptionRef: string | null;
  status: BillingSubscriptionStatus;
  providerStatus: string | null;
  cancelAtPeriodEnd: boolean;
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
    providerStatus: row.providerStatus,
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
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
 * How many times {@link assignPlan} runs its transaction when Postgres fails
 * it with a write conflict or a deadlock (`P2034`). The locks below make that
 * rare; past this it is the caller's (the route answers 409, assign again).
 */
const MAX_ATTEMPTS = 3;

/** Per-org lock key for billing writes; t-1094's webhook takes the same one. */
export function billingLockKey(orgId: string): string {
  return `billing:${orgId}`;
}

/**
 * A client for the settings writers that runs them on an open transaction.
 * Each writer opens its own transaction when given the shared client; given
 * this, its work joins ours, so the record and every slice the plan writes
 * commit together or not at all.
 */
export function onTransaction(tx: Prisma.TransactionClient): Pick<PrismaClient, '$transaction'> {
  const run = (fn: (client: Prisma.TransactionClient) => Promise<unknown>) => fn(tx);
  return { $transaction: run as PrismaClient['$transaction'] };
}

/**
 * Take the org's billing locks inside an open transaction: the advisory lock
 * on {@link billingLockKey}, so every billing write for the org (a hand
 * assignment, a checkout, a webhook delivery) runs one after the other, then
 * the org row `FOR UPDATE`, so a settings write from another route waits for
 * the plan's read-modify-write. Every billing transaction takes both, in this
 * order, so two of them cannot deadlock on each other.
 *
 * @returns `false` when the org row does not exist (deleted, or erased).
 */
export async function lockOrgBilling(
  tx: Prisma.TransactionClient,
  orgId: string
): Promise<boolean> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${billingLockKey(orgId)}, 0))`;
  const locked = await tx.$queryRaw<
    { id: string }[]
  >`SELECT "id" FROM "org" WHERE "id" = ${orgId} FOR UPDATE`;
  return locked.length > 0;
}

/**
 * Put an org on a plan by hand, or take it off one (`planKey: null`).
 *
 * **One transaction, under the org's billing lock and its row lock.** The
 * record and every slice the plan writes commit together, or not at all. It
 * first takes a Postgres advisory lock on {@link billingLockKey}, so two
 * assignments (and t-1094's webhook) run one after the other, then the org
 * row `FOR UPDATE`, so a settings write from another route waits for it.
 * At READ COMMITTED every read after those locks sees what committed before
 * them. Serializable would not: its snapshot is taken at the first
 * statement, before the lock is granted, so an assignment that waited could
 * read the record and settings as they were and, with nothing to write,
 * report success over another's plan (review round 3).
 *
 * Taking an org off its plan clears the plan from the record and leaves its
 * switches, limits and budget as they are: the plan stops being named, and
 * what it gave stays until someone changes it. A record holding nothing else
 * is deleted; one holding a provider or customer reference is kept, so a
 * later erasure still finds that customer. It decides nothing about who may:
 * the route asks `mayChangeOrgCommercialSettings()` first.
 *
 * @throws {BillingPlanError} `BILLING_OFF` when plans do not apply on this
 *   install, `UNKNOWN_PLAN`, `PROVIDER_MANAGED`, or `ORG_NOT_FOUND`.
 *   A write conflict or deadlock that outlasts the retries throws `P2034`
 *   (`isSettingsWriteConflict`), and a lock wait past the timeout `P2028`;
 *   either way nothing was written.
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

  const attempt = () =>
    prisma.$transaction(
      async (tx): Promise<AssignPlanResult> => {
        if (!(await lockOrgBilling(tx, orgId))) {
          throw new BillingPlanError('ORG_NOT_FOUND', 'Organisation not found');
        }
        const current = await tx.orgBillingSubscription.findUnique({
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
          const unchanged = { previousPlanKey, planKey: null, applied: null };
          if (!current || (current.planKey === null && current.subscriptionRef === null)) {
            return {
              ...unchanged,
              changed: false,
              subscription: current ? toView(current) : null,
            };
          }
          if (current.provider === null && current.customerRef === null) {
            await tx.orgBillingSubscription.delete({ where: { orgId } });
            return { ...unchanged, changed: true, subscription: null };
          }
          // The provider's customer stays, for erasure to find.
          const row = await tx.orgBillingSubscription.update({
            where: { orgId },
            data: {
              planKey: null,
              subscriptionRef: null,
              providerStatus: null,
              cancelAtPeriodEnd: false,
              periodStart: null,
              periodEnd: null,
              planAppliedAt: null,
            },
            select: SUBSCRIPTION_SELECT,
          });
          return { ...unchanged, changed: true, subscription: toView(row) };
        }

        const applied = await applyPlan(orgId, plan, onTransaction(tx));
        if (applied === null) {
          throw new BillingPlanError('ORG_NOT_FOUND', 'Organisation not found');
        }

        // A record already naming this plan, by hand and fully applied, is
        // left untouched unless applying changed something.
        const recordMatches =
          current !== null &&
          current.planKey === plan.key &&
          current.subscriptionRef === null &&
          current.status === 'ACTIVE' &&
          current.planAppliedAt !== null;
        if (recordMatches && !applied.changed) {
          return {
            previousPlanKey,
            planKey: plan.key,
            changed: false,
            applied,
            subscription: toView(current),
          };
        }

        // The provider and customer stay, so an ended subscription's customer
        // is still found at erasure; the subscription and its period go.
        const handAssigned = {
          planKey: plan.key,
          subscriptionRef: null,
          status: 'ACTIVE' as const,
          providerStatus: null,
          cancelAtPeriodEnd: false,
          periodStart: null,
          periodEnd: null,
          planAppliedAt: new Date(),
        };
        const row = await tx.orgBillingSubscription.upsert({
          where: { orgId },
          create: { orgId, ...handAssigned },
          update: handAssigned,
          select: SUBSCRIPTION_SELECT,
        });
        return {
          previousPlanKey,
          planKey: plan.key,
          changed: true,
          applied,
          subscription: toView(row),
        };
      },
      // READ COMMITTED, not the serializable the settings writers ask for on
      // their own: the two locks above serialize what matters, and reads after
      // them see the latest commit (see the docblock). The timeout covers a
      // wait on the locks behind another assignment as well as the writes.
      {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        maxWait: 5_000,
        timeout: 15_000,
      }
    );
  const result = await runAsOrg(orgId, async () => {
    // A deadlock or write conflict Postgres resolved by failing this one.
    for (let tries = 1; ; tries++) {
      try {
        return await attempt();
      } catch (error) {
        if (!isSerializableConflict(error) || tries >= MAX_ATTEMPTS) throw error;
      }
    }
  });
  // After the commit, so a re-read cannot fetch the budget it replaced.
  if (result.applied?.aiBudgetUsd) forgetOrgCap(orgId);
  return result;
}
