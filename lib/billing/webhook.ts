/**
 * The billing webhook (§139 t-1094): verify, record the event once, apply the
 * provider's current state.
 *
 * Providers deliver each event at least once and in no guaranteed order, so
 * no event's own snapshot is ever applied. Each delivery, under the org's
 * billing lock and in one transaction:
 *
 * 1. records the event id in the ledger (`BillingWebhookEvent`, unique on
 *    provider and event id, inserted with `ON CONFLICT DO NOTHING`). No row
 *    inserted means a replay, and nothing else happens;
 * 2. fetches the subscription as the provider holds it now;
 * 3. applies that, under the lapsed-subscription rule;
 * 4. commits the ledger row and the change together.
 *
 * Fetching inside the lock is what makes deliveries in any order end on the
 * provider's state; the ledger is what makes a side effect (an audit row)
 * happen once. Committing both together means a crash between them is
 * retried, not mistaken for a replay. Each rejected alternative, and why, is
 * in the spec's table; the spike shows each one failing.
 *
 * The org is found before the lock, by the customer reference (a credential
 * lookup: no org is known yet), or, for a checkout whose customer reference
 * was never stored, by the org id the adapter wrote into the subscription's
 * metadata. An event that names no org that exists is answered and dropped:
 * it cannot go in the ledger, which is org-owned.
 *
 * @see .context/billing/billing.md#webhooks
 * @see .context/billing/billing.md#lapsed-subscriptions
 */

import { Prisma, type BillingSubscriptionStatus } from '@prisma/client';

import { applyPlan, type PlanApplied } from '@/lib/billing/apply-plan';
import { billingProvider } from '@/lib/billing/config';
import { fallbackPlan, planOf, registeredPlans, type RegisteredPlan } from '@/lib/billing/plans';
import {
  BillingSignatureError,
  type BillingEvent,
  type BillingProvider,
  type ProviderSubscription,
} from '@/lib/billing/provider';
import { lockOrgBilling, onTransaction } from '@/lib/billing/subscriptions';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { forgetOrgCap } from '@/lib/orchestration/llm/spend-caps';
import { runAsCredentialLookup, runAsOrg } from '@/lib/tenancy/context';

/** What the ledger row says the webhook did with an event. */
export type LedgerOutcome =
  /** The subscription's state was written to the org. */
  | 'applied'
  /** It matched what the org already had. */
  | 'unchanged'
  /** Recorded and deliberately not applied; a warning says why. */
  | 'not_applied'
  /** The event names no subscription, and the org has none. */
  | 'no_subscription';

export type WebhookResult =
  | { status: 'billing_off' }
  | { status: 'bad_signature' }
  | { status: 'ignored'; eventId: string; eventType: string }
  | { status: 'no_org'; eventId: string; eventType: string }
  | { status: 'replay'; eventId: string; orgId: string }
  | { status: 'recorded'; eventId: string; orgId: string; outcome: LedgerOutcome };

/** The org id a provider's metadata may carry: a cuid, or the install org's fixed id. */
const ORG_ID_SHAPE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The transaction holds the lock across a provider round trip or three (the
 * fetch, and the live-subscription list when one ends), so its timeout is
 * well above one.
 */
const WEBHOOK_TRANSACTION = {
  isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
  maxWait: 10_000,
  timeout: 60_000,
} as const;

const STATUS: Record<ProviderSubscription['status'], BillingSubscriptionStatus> = {
  incomplete: 'INCOMPLETE',
  active: 'ACTIVE',
  past_due: 'PAST_DUE',
  ended: 'ENDED',
};

type RecordRow = {
  planKey: string | null;
  provider: string | null;
  customerRef: string | null;
  subscriptionRef: string | null;
  status: BillingSubscriptionStatus;
  providerStatus: string | null;
  providerLive: boolean;
  cancelAtPeriodEnd: boolean;
  periodStart: Date | null;
  periodEnd: Date | null;
};

const RECORD_SELECT = {
  planKey: true,
  provider: true,
  customerRef: true,
  subscriptionRef: true,
  status: true,
  providerStatus: true,
  providerLive: true,
  cancelAtPeriodEnd: true,
  periodStart: true,
  periodEnd: true,
} as const;

/** What one delivery changed, for the audit row written after the commit. */
interface Applied {
  outcome: LedgerOutcome;
  subscriptionRef: string | null;
  plan: { from: string | null; to: string | null } | null;
  status: { from: BillingSubscriptionStatus | null; to: BillingSubscriptionStatus } | null;
  writes: PlanApplied | null;
  /** Whether any write in the delivery changed the AI budget, so the cache is forgotten. */
  budgetChanged: boolean;
}

/**
 * Handle one delivery to `POST /api/v1/billing/webhook/[provider]`.
 *
 * Throws on anything that should be retried (the provider unreachable, the
 * database), after rolling back, so the route answers 500 and the provider
 * delivers again.
 */
export async function handleBillingWebhook(input: {
  providerKey: string;
  rawBody: string;
  headers: Headers;
}): Promise<WebhookResult> {
  const provider = await billingProvider();
  if (!provider || provider.key !== input.providerKey) return { status: 'billing_off' };

  let event: BillingEvent;
  try {
    // Nothing is parsed, read or written before this verifies.
    event = await provider.parseWebhook({ rawBody: input.rawBody, headers: input.headers });
  } catch (error) {
    if (error instanceof BillingSignatureError) return { status: 'bad_signature' };
    throw error;
  }

  if (event.kind === 'ignored') {
    return { status: 'ignored', eventId: event.id, eventType: event.providerType };
  }

  const orgId = await findOrg(provider, event);
  if (orgId === null) {
    logger.warn('billing: webhook event names no organisation that exists; dropped', {
      provider: provider.key,
      eventId: event.id,
      eventType: event.providerType,
      customerRef: event.customerRef,
      subscriptionRef: event.subscriptionRef,
    });
    return { status: 'no_org', eventId: event.id, eventType: event.providerType };
  }

  const result = await runAsOrg(orgId, () =>
    prisma.$transaction(async (tx) => {
      if (!(await lockOrgBilling(tx, orgId))) return null;
      const inserted = await tx.billingWebhookEvent.createMany({
        data: [
          {
            provider: provider.key,
            eventId: event.id,
            eventType: event.providerType,
            outcome: 'received',
            orgId,
          },
        ],
        skipDuplicates: true,
      });
      if (inserted.count === 0) return 'replay' as const;

      const applied = await applyEvent(tx, provider, orgId, event);
      await tx.billingWebhookEvent.update({
        where: { provider_eventId: { provider: provider.key, eventId: event.id } },
        data: { outcome: applied.outcome },
      });
      return applied;
    }, WEBHOOK_TRANSACTION)
  );

  if (result === null) {
    // The org was erased between finding it and locking it.
    return { status: 'no_org', eventId: event.id, eventType: event.providerType };
  }
  if (result === 'replay') return { status: 'replay', eventId: event.id, orgId };

  // After the commit, so a re-read cannot cache the budget it replaced.
  if (result.budgetChanged) forgetOrgCap(orgId);
  if (result.plan || result.status) {
    logAdminAction({
      // The provider acted, not a person.
      userId: null,
      action: 'org.billing.sync',
      entityType: 'org',
      entityId: orgId,
      actingOrgId: orgId,
      changes: {
        ...(result.plan ? { plan: result.plan } : {}),
        ...(result.status ? { status: result.status } : {}),
        ...(result.writes?.switches ? { switches: result.writes.switches } : {}),
        ...(result.writes?.meterLimits ? { meterLimits: result.writes.meterLimits } : {}),
        ...(result.writes?.aiBudgetUsd ? { monthlyBudgetUsd: result.writes.aiBudgetUsd } : {}),
      },
      metadata: {
        provider: provider.key,
        eventId: event.id,
        eventType: event.providerType,
        subscriptionRef: result.subscriptionRef,
      },
    });
  }
  logger.info('billing: webhook event recorded', {
    provider: provider.key,
    eventId: event.id,
    eventType: event.providerType,
    orgId,
    outcome: result.outcome,
  });
  return { status: 'recorded', eventId: event.id, orgId, outcome: result.outcome };
}

/**
 * The org an event concerns: the one holding its customer, else the one the
 * subscription's metadata names. `null` when neither names an org that exists.
 * Outside any lock; the fetch here is used for the org id only.
 */
async function findOrg(provider: BillingProvider, event: BillingEvent): Promise<string | null> {
  if (event.customerRef !== null) {
    const customerRef = event.customerRef;
    const row = await runAsCredentialLookup('billing-customer', () =>
      prisma.orgBillingSubscription.findUnique({
        where: { provider_customerRef: { provider: provider.key, customerRef } },
        select: { orgId: true },
      })
    );
    if (row) return row.orgId;
  }
  if (event.subscriptionRef === null) return null;
  const subscription = await provider.fetchSubscription(event.subscriptionRef);
  const named = subscription?.orgId ?? null;
  if (named === null || !ORG_ID_SHAPE.test(named)) return null;
  // `Org` is a system model, so this read needs no tenant scope.
  const org = await prisma.org.findUnique({ where: { id: named }, select: { id: true } });
  return org ? org.id : null;
}

function warnNotApplied(why: string, fields: Record<string, unknown>): Applied {
  logger.warn(`billing: webhook event recorded and not applied: ${why}`, fields);
  return {
    outcome: 'not_applied',
    subscriptionRef: null,
    plan: null,
    status: null,
    writes: null,
    budgetChanged: false,
  };
}

/** Inside the locked transaction, after the ledger row is in. */
async function applyEvent(
  tx: Prisma.TransactionClient,
  provider: BillingProvider,
  orgId: string,
  event: BillingEvent
): Promise<Applied> {
  const record = await tx.orgBillingSubscription.findUnique({
    where: { orgId },
    select: RECORD_SELECT,
  });
  const target = event.subscriptionRef ?? record?.subscriptionRef ?? null;
  if (target === null) {
    return {
      outcome: 'no_subscription',
      subscriptionRef: null,
      plan: null,
      status: null,
      writes: null,
      budgetChanged: false,
    };
  }
  const fields = { provider: provider.key, orgId, eventId: event.id, subscriptionRef: target };

  // Inside the lock: what is applied is what the provider holds now.
  const subscription = await provider.fetchSubscription(target);
  if (!subscription) return warnNotApplied('the provider has no such subscription', fields);
  if (subscription.orgId !== null && subscription.orgId !== orgId) {
    return warnNotApplied("the subscription's metadata names another organisation", {
      ...fields,
      namedOrgId: subscription.orgId,
    });
  }
  // Re-checked under the lock: an org linked to one customer is never moved
  // to another. Erasure finds the other customer by its metadata.
  const heldCustomer = record?.provider === provider.key ? record.customerRef : null;
  if (heldCustomer !== null && heldCustomer !== subscription.customerRef) {
    return warnNotApplied('the organisation holds another customer', {
      ...fields,
      customerRef: subscription.customerRef,
    });
  }

  const storedRef = record?.provider === provider.key ? record.subscriptionRef : null;
  if (subscription.ref !== storedRef) {
    if (subscription.status === 'ended') {
      // A late event for a subscription that has ended never replaces the
      // stored one, and an ended one is never adopted as a new one.
      logger.info('billing: webhook event for an ended subscription the org does not hold', fields);
      return {
        outcome: 'unchanged',
        subscriptionRef: subscription.ref,
        plan: null,
        status: null,
        writes: null,
        budgetChanged: false,
      };
    }
    const replaceable =
      storedRef === null || record?.status === 'ENDED' || record?.status === 'INCOMPLETE';
    if (!replaceable) {
      return warnNotApplied('the organisation already has a live subscription', {
        ...fields,
        storedRef,
      });
    }
    // A stored one the provider can still charge or resume (unfinished,
    // paused, unpaid) is replaced only by one that has been paid for, and is
    // cancelled then: checkout leaves it alone, so an owner who abandons the
    // checkout page has lost nothing (review round 2).
    const storedChargeable =
      storedRef !== null && (record?.status === 'INCOMPLETE' || record?.providerLive === true);
    if (storedChargeable) {
      if (subscription.status === 'incomplete') {
        logger.info('billing: an unpaid subscription waits while the stored one can still charge', {
          ...fields,
          storedRef,
        });
        return {
          outcome: 'unchanged',
          subscriptionRef: subscription.ref,
          plan: null,
          status: null,
          writes: null,
          budgetChanged: false,
        };
      }
      await provider.cancelSubscription(storedRef);
      logger.info('billing: cancelled the subscription a paid one replaces', {
        ...fields,
        storedRef,
      });
    }
  }

  let applied = await writeSubscription(tx, provider, orgId, record, subscription);
  if (subscription.status === 'ended') {
    // A new subscription recorded before this one's cancellation arrived
    // takes effect now, not at its next renewal.
    const live = await provider.listLiveSubscriptions(subscription.customerRef);
    const next = live.find((s) => s.ref !== subscription.ref && s.status !== 'ended');
    if (next) {
      const after = await tx.orgBillingSubscription.findUnique({
        where: { orgId },
        select: RECORD_SELECT,
      });
      const adopted = await writeSubscription(tx, provider, orgId, after, next);
      // One audit row for the delivery: from what the org had before it, to
      // where the adopted subscription left it.
      const from = record?.planKey ?? null;
      const to = after?.planKey ?? null;
      const finalPlan = adopted.plan ? adopted.plan.to : to;
      applied = {
        outcome: 'applied',
        subscriptionRef: next.ref,
        plan: applied.plan || adopted.plan ? { from, to: finalPlan } : null,
        status: { from: record?.status ?? null, to: STATUS[next.status] },
        writes: adopted.writes ?? applied.writes,
        // Either write may have moved it: old plan to fallback, then fallback
        // to the adopted plan (review round 1).
        budgetChanged: applied.budgetChanged || adopted.budgetChanged,
      };
    }
  }
  return applied;
}

/** The plan whose price the subscription is on; `undefined` when none is. */
function planForPrices(lookupKeys: readonly string[]): RegisteredPlan | undefined {
  return registeredPlans().find(
    (plan) => plan.priceLookupKey !== null && lookupKeys.includes(plan.priceLookupKey)
  );
}

/**
 * Write one fetched subscription to the org's record, and the plan the
 * lapsed-subscription rule gives it to the org's settings. Idempotent:
 * writing the same state twice changes nothing.
 */
async function writeSubscription(
  tx: Prisma.TransactionClient,
  provider: BillingProvider,
  orgId: string,
  record: RecordRow | null,
  subscription: ProviderSubscription
): Promise<Applied> {
  const status = STATUS[subscription.status];
  const fromPlan = record?.planKey ?? null;
  let toPlan = fromPlan;
  let writes: PlanApplied | null = null;
  let planWritten = false;

  if (subscription.status === 'active' || subscription.status === 'past_due') {
    // Past due keeps the plan: the provider is still collecting.
    const plan = planForPrices(subscription.priceLookupKeys);
    if (plan) {
      writes = await applyPlan(orgId, plan, onTransaction(tx));
      toPlan = plan.key;
      planWritten = true;
    } else {
      logger.warn("billing: the subscription's price names no plan; the org's plan is unchanged", {
        provider: provider.key,
        orgId,
        subscriptionRef: subscription.ref,
        priceLookupKeys: subscription.priceLookupKeys,
      });
    }
  } else if (
    subscription.status === 'ended' &&
    (record?.status === 'ACTIVE' || record?.status === 'PAST_DUE')
  ) {
    // The lapse happens once, on the way into `ended` from a subscription
    // that gave access. One that ends while `incomplete` was never paid
    // for, so the org keeps what it had, a plan staff assigned included; and
    // a later delivery about one already ended changes nothing more (review
    // round 1).
    const fallback = fallbackPlan();
    if (fallback) {
      writes = await applyPlan(orgId, fallback, onTransaction(tx));
      toPlan = fallback.key;
      planWritten = true;
    } else {
      // No fallback: every switch the lapsed plan decided goes off. Its meter
      // limits and budget stay, since a removed limit reads as unlimited and
      // a zero one would lock the org out of adding anyone.
      const lapsed = fromPlan === null ? undefined : planOf(fromPlan);
      if (lapsed) {
        const off = Object.fromEntries(Object.keys(lapsed.switches).map((key) => [key, false]));
        writes = await applyPlan(
          orgId,
          { ...lapsed, switches: off, meterLimits: {}, aiBudgetUsd: undefined },
          onTransaction(tx)
        );
        planWritten = true;
      }
      toPlan = null;
    }
  }
  // `incomplete` applies nothing: the org keeps what it had before checkout.
  // Nor does `ended` after `incomplete` or `ended` (above).

  if (writes === null && planWritten) {
    throw new Error('The organisation was deleted while its plan was being applied');
  }

  const data = {
    provider: provider.key,
    customerRef: subscription.customerRef,
    subscriptionRef: subscription.ref,
    status,
    providerStatus: subscription.providerStatus,
    providerLive: subscription.live,
    cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
    periodStart: subscription.periodStart,
    periodEnd: subscription.periodEnd,
    planKey: toPlan,
  };
  const recordMatches =
    record !== null &&
    record.provider === data.provider &&
    record.customerRef === data.customerRef &&
    record.subscriptionRef === data.subscriptionRef &&
    record.status === data.status &&
    record.providerStatus === data.providerStatus &&
    record.providerLive === data.providerLive &&
    record.cancelAtPeriodEnd === data.cancelAtPeriodEnd &&
    record.periodStart?.getTime() === data.periodStart.getTime() &&
    record.periodEnd?.getTime() === data.periodEnd.getTime() &&
    record.planKey === data.planKey;
  const settingsChanged = writes?.changed ?? false;

  if (!recordMatches || settingsChanged) {
    const row = { ...data, ...(planWritten ? { planAppliedAt: new Date() } : {}) };
    await tx.orgBillingSubscription.upsert({
      where: { orgId },
      create: { orgId, ...row },
      update: row,
    });
  }

  const statusChanged = record?.status !== status || record.subscriptionRef !== subscription.ref;
  return {
    outcome: recordMatches && !settingsChanged ? 'unchanged' : 'applied',
    subscriptionRef: subscription.ref,
    plan: fromPlan !== toPlan || settingsChanged ? { from: fromPlan, to: toPlan } : null,
    status: statusChanged ? { from: record?.status ?? null, to: status } : null,
    writes,
    budgetChanged: (writes?.aiBudgetUsd ?? null) !== null,
  };
}
