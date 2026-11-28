/**
 * Usage reported to the payment provider once per billing period (§139 t-1097).
 *
 * Meters count on demand and record no usage events, so a period's usage is
 * counted once, after it closes, and the answer is kept. Each billed meter
 * (a metered item whose overage rule is `soft_cap`) gets one
 * `BillingUsageReport` per (org, meter, period start), unique, through these
 * steps:
 *
 * 1. **Closed.** The webhook closes a period when a sync sees it move on, or
 *    the subscription end ({@link closeBillingPeriod}, inside the webhook's
 *    transaction). The maintenance tick closes one too when the stored period
 *    has ended and no sync has moved it on yet, so a late webhook does not
 *    hold up a report. Closing twice is harmless: the row is unique.
 * 2. **Settled, then counted once.** A few minutes after the period's end
 *    ({@link USAGE_SETTLE_MS}), so rows committed just before the boundary are
 *    counted. The count and the excess go into the row, and a row already
 *    counted is never counted again, so rows erased or purged afterwards do
 *    not change what was billed.
 * 3. **Recorded before it is sent**, and sent with the row's id as the
 *    provider's identifier, `final: true`, placed one second before the
 *    period's end. A send takes a lease on the row first, so two instances do
 *    not send at once; one that crashed mid-send is retried after the lease.
 *    A resend is harmless: Stripe's meter takes the period's last value.
 *
 * **The last period** of a subscription is invoiced when it ends, so a report
 * sent after it closes lands on no invoice. While the subscription cancels at
 * the period's end, each run sends the period's running total
 * (`final: false`, placed now, a new identifier each time). When it closes,
 * the count is recorded and marked `LATE`, not sent. An org erased mid-period
 * has its open period's total so far sent, as a running total, before the
 * subscription is cancelled ({@link reportBeforeCancelling}); its row stays
 * open, so a cancellation that fails leaves the period to close as any
 * other. One ended at once by the provider is
 * closed when it ended and marked `LATE`, so the loss is visible.
 *
 * **Off unless it can bill.** With no provider, plans not in use, or no plan
 * with a soft cap, nothing here makes a query.
 *
 * **Tenancy posture.** The job runs under the audited system scope to find the
 * orgs with something to do, then does each org's reads and writes as that
 * org (`runAsOrg`). Counts run as the org and across its owners, as every
 * meter count does.
 *
 * @see lib/billing/overage.ts — the rule, and which items are billed
 * @see .context/billing/billing.md#usage-reporting
 */

import type { BillingUsageReport, Prisma, PrismaClient } from '@prisma/client';

import { runAcrossOwners } from '@/lib/auth/subject-context';
import { billingProvider } from '@/lib/billing/config';
import { AI_SPEND_METER_KEY, excessOver, type MeteredItem } from '@/lib/billing/overage';
import { billingPlansEnabled, planOf, registeredPlans } from '@/lib/billing/plans';
import type { BillingProvider } from '@/lib/billing/provider';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { runAsOrg } from '@/lib/tenancy/context';
import { countMeterWithin } from '@/lib/tenancy/meters';

const MINUTE = 60 * 1000;

/** How long after a period's end it is counted, so rows committed at the boundary are in. */
export const USAGE_SETTLE_MS = 5 * MINUTE;

/** How long a send holds a row before another instance may retry it. */
export const USAGE_SEND_LEASE_MS = 10 * MINUTE;

/**
 * Stripe finalises a period's invoice an hour after it ends unless the
 * operator extends it. A report sent later is still sent (the operator may
 * have extended it), and logged, since it may miss the invoice.
 */
const DEFAULT_PROVIDER_GRACE_MS = 60 * MINUTE;

/** Rows read per page; each step walks every page in one run. */
const PAGE = 100;

/**
 * Walk every row a query matches, a page at a time, keyed on a unique field
 * the query orders by. Every page is walked, so rows a step skips or fails on
 * (a period already closed, a total unchanged, a send the provider refuses)
 * never hold the rest back to a later run.
 */
async function eachPage<T>(
  read: (after: string | undefined) => Promise<T[]>,
  keyOf: (row: T) => string,
  handle: (row: T) => Promise<void>
): Promise<void> {
  let after: string | undefined;
  for (;;) {
    const rows = await read(after);
    for (const row of rows) await handle(row);
    const last = rows.at(-1);
    if (rows.length < PAGE || last === undefined) return;
    after = keyOf(last);
  }
}

type Db = Pick<PrismaClient, 'billingUsageReport'> | Prisma.TransactionClient;

/** A plan's billed items: its soft caps. */
export function billedItems(planKey: string | null): MeteredItem[] {
  if (planKey === null) return [];
  const plan = planOf(planKey);
  if (!plan) return [];
  return Object.values(plan.meteredItems).filter((item) => item.overage === 'soft_cap');
}

/** The keys of every plan with a billed item. */
function billedPlanKeys(): string[] {
  return registeredPlans()
    .filter((plan) => billedItems(plan.key).length > 0)
    .map((plan) => plan.key);
}

/**
 * How much of one metered item an org used within `[from, to)`. AI spend is
 * the org's AI cost leaving out calls on its own key, summed and then rounded
 * to whole cents once; anything else is the meter's count. Throws when it
 * cannot be counted: a bill must not be built on a count that failed.
 */
export async function countUsage(
  orgId: string,
  meterKey: string,
  window: { from: Date; to: Date }
): Promise<number> {
  if (meterKey !== AI_SPEND_METER_KEY) return countMeterWithin(orgId, meterKey, window);
  const total = await runAcrossOwners(
    "billing: an org's AI spend is counted across its members",
    () =>
      runAsOrg(orgId, () =>
        prisma.aiCostLog.aggregate({
          where: {
            orgId,
            // The vendor bills the org for calls on its own key (§110).
            ownKey: false,
            createdAt: { gte: window.from, lt: window.to },
          },
          _sum: { totalCostUsd: true },
        })
      )
  );
  const usd = total._sum.totalCostUsd ?? 0;
  return Number.isFinite(usd) && usd > 0 ? Math.round(usd * 100) : 0;
}

/** The subscription a period belonged to, as the org's record holds it. */
export interface ClosingSubscription {
  orgId: string;
  provider: string;
  customerRef: string;
  subscriptionRef: string;
  planKey: string | null;
  periodStart: Date;
}

/**
 * Record that a billing period has closed: one report row per billed item of
 * the plan the org was on, waiting to be counted. `periodEnd` is when it
 * closed (the period's end, or when the subscription ended if that was
 * earlier); `lastPeriod` when the subscription will not renew.
 *
 * Idempotent: a row already there keeps its id. One still open (running
 * totals) or not yet counted takes the closing values, so a later, better
 * informed close (the webhook saying the subscription ended early) wins over
 * the tick's; one already counted is never changed.
 *
 * @returns how many rows the period has.
 */
export async function closeBillingPeriod(
  db: Db,
  subscription: ClosingSubscription,
  close: { periodEnd: Date; lastPeriod: boolean }
): Promise<number> {
  const items = billedItems(subscription.planKey);
  if (items.length === 0 || subscription.planKey === null) return 0;
  if (close.periodEnd <= subscription.periodStart) return 0;
  const planKey = subscription.planKey;
  await db.billingUsageReport.createMany({
    data: items.map((item) => ({
      orgId: subscription.orgId,
      provider: subscription.provider,
      customerRef: subscription.customerRef,
      subscriptionRef: subscription.subscriptionRef,
      planKey,
      meterKey: item.meterKey,
      // Set for every soft cap (`checkMeteredItems`).
      providerMeter: item.providerMeter ?? item.meterKey,
      allowance: item.allowance,
      periodStart: subscription.periodStart,
      periodEnd: close.periodEnd,
      lastPeriod: close.lastPeriod,
      status: 'PENDING' as const,
    })),
    skipDuplicates: true,
  });
  // Per item: a row opened under an earlier plan takes this one's allowance
  // and provider meter, so the period is billed under the plan it closed on.
  for (const item of items) {
    await db.billingUsageReport.updateMany({
      where: {
        orgId: subscription.orgId,
        periodStart: subscription.periodStart,
        meterKey: item.meterKey,
        status: { in: ['OPEN', 'PENDING'] },
      },
      data: {
        status: 'PENDING',
        periodEnd: close.periodEnd,
        lastPeriod: close.lastPeriod,
        planKey,
        allowance: item.allowance,
        providerMeter: item.providerMeter ?? item.meterKey,
      },
    });
  }
  return items.length;
}

/** What one run of the job did, for the tick's log line. */
export interface UsageReportRun {
  /** Periods the tick closed itself, because no sync had moved them on. */
  closed: number;
  /** Running totals sent for subscriptions cancelling at period end. */
  running: number;
  /** Reports counted. */
  counted: number;
  /** Reports sent. */
  sent: number;
  /** Reports counted after the provider invoiced the period, so not sent. */
  late: number;
  /** Counts or sends that failed, to be retried on a later run. */
  failed: number;
}

const NOTHING: UsageReportRun = { closed: 0, running: 0, counted: 0, sent: 0, late: 0, failed: 0 };

/**
 * One run of the usage-report job: close the periods that ended without a
 * sync, send running totals in last periods, count what has settled, and send
 * what is counted. Never throws for one org or row: a failure is logged,
 * counted in `failed`, and retried on a later run.
 */
export async function runUsageReports(now: Date = new Date()): Promise<UsageReportRun> {
  if (!billingPlansEnabled()) return NOTHING;
  const planKeys = billedPlanKeys();
  if (planKeys.length === 0) return NOTHING;
  const provider = await billingProvider();
  if (!provider) return NOTHING;

  const run = { ...NOTHING };
  await closeEndedPeriods(provider, planKeys, now, run);
  await sendRunningTotals(provider, planKeys, now, run);
  await countSettled(provider, now, run);
  await sendCounted(provider, now, run);
  return run;
}

const LIVE_RECORD = {
  subscriptionRef: { not: null },
  customerRef: { not: null },
  periodStart: { not: null },
  periodEnd: { not: null },
  status: { in: ['ACTIVE', 'PAST_DUE'] },
} as const satisfies Prisma.OrgBillingSubscriptionWhereInput;

const RECORD_FIELDS = {
  orgId: true,
  provider: true,
  customerRef: true,
  subscriptionRef: true,
  planKey: true,
  periodStart: true,
  periodEnd: true,
  cancelAtPeriodEnd: true,
} as const;

interface LiveRecord extends ClosingSubscription {
  periodEnd: Date;
  cancelAtPeriodEnd: boolean;
}

function asLive(row: {
  orgId: string;
  provider: string | null;
  customerRef: string | null;
  subscriptionRef: string | null;
  planKey: string | null;
  periodStart: Date | null;
  periodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
}): LiveRecord | null {
  if (
    row.provider === null ||
    row.customerRef === null ||
    row.subscriptionRef === null ||
    row.periodStart === null ||
    row.periodEnd === null
  ) {
    return null;
  }
  return {
    orgId: row.orgId,
    provider: row.provider,
    customerRef: row.customerRef,
    subscriptionRef: row.subscriptionRef,
    planKey: row.planKey,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Close every period whose end has passed while the record still holds it,
 * active: the renewal's webhook has not arrived yet. Only those not already
 * closed, so a run after the close writes nothing.
 */
async function closeEndedPeriods(
  provider: BillingProvider,
  planKeys: string[],
  now: Date,
  run: UsageReportRun
): Promise<void> {
  const read = (after: string | undefined) =>
    prisma.orgBillingSubscription.findMany({
      where: {
        ...LIVE_RECORD,
        provider: provider.key,
        planKey: { in: planKeys },
        periodEnd: { lte: new Date(now.getTime() - USAGE_SETTLE_MS) },
        ...(after ? { orgId: { gt: after } } : {}),
      },
      select: RECORD_FIELDS,
      orderBy: { orgId: 'asc' },
      take: PAGE,
    });
  await eachPage(
    read,
    (row) => row.orgId,
    async (row) => {
      const record = asLive(row);
      if (!record) return;
      try {
        const closedAlready = await runAsOrg(record.orgId, () =>
          prisma.billingUsageReport.count({
            where: {
              orgId: record.orgId,
              periodStart: record.periodStart,
              // Pending too: a period whose count keeps failing is not closed
              // again each run, which would count as work every run.
              status: { notIn: ['OPEN'] },
            },
          })
        );
        if (closedAlready > 0) return;
        await runAsOrg(record.orgId, () =>
          closeBillingPeriod(prisma, record, {
            periodEnd: record.periodEnd,
            // Cancelling at its end, the provider has made its final invoice.
            lastPeriod: record.cancelAtPeriodEnd,
          })
        );
        run.closed += 1;
      } catch (error) {
        run.failed += 1;
        logger.error('billing: could not close a billing period', {
          orgId: record.orgId,
          error: errorText(error),
        });
      }
    }
  );
}

/**
 * While a subscription cancels at its period's end, send the period's running
 * total each run it has changed, so the provider's final invoice carries all
 * but the last few minutes of usage.
 */
async function sendRunningTotals(
  provider: BillingProvider,
  planKeys: string[],
  now: Date,
  run: UsageReportRun
): Promise<void> {
  const read = (after: string | undefined) =>
    prisma.orgBillingSubscription.findMany({
      where: {
        ...LIVE_RECORD,
        provider: provider.key,
        planKey: { in: planKeys },
        cancelAtPeriodEnd: true,
        periodEnd: { gt: now },
        ...(after ? { orgId: { gt: after } } : {}),
      },
      select: RECORD_FIELDS,
      orderBy: { orgId: 'asc' },
      take: PAGE,
    });
  await eachPage(
    read,
    (row) => row.orgId,
    async (row) => {
      const record = asLive(row);
      if (!record || record.periodStart >= now) return;
      for (const item of billedItems(record.planKey)) {
        try {
          if ((await sendRunningTotal(provider, record, item, now)).outcome === 'sent')
            run.running += 1;
        } catch (error) {
          run.failed += 1;
          logger.error('billing: could not send a running usage total', {
            orgId: record.orgId,
            meterKey: item.meterKey,
            error: errorText(error),
          });
        }
      }
    }
  );
}

/**
 * Send the open period's total so far, placed now, with a new identifier each
 * time (the provider keeps the period's last value). The row stays `OPEN`, so
 * the period still closes, is counted and is sent as any other.
 *
 * @returns the outcome, with the total counted: `sent`; `unchanged` when the
 *   provider already holds this total; `busy` when another send holds the
 *   row's lease; `closed` when the row is no longer open.
 */
async function sendRunningTotal(
  provider: BillingProvider,
  record: LiveRecord,
  item: MeteredItem,
  now: Date
): Promise<{ outcome: 'sent' | 'unchanged' | 'busy' | 'closed'; quantity: number }> {
  return runAsOrg(record.orgId, async () => {
    const key = {
      orgId_meterKey_periodStart: {
        orgId: record.orgId,
        meterKey: item.meterKey,
        periodStart: record.periodStart,
      },
    };
    await prisma.billingUsageReport.createMany({
      data: [
        {
          orgId: record.orgId,
          provider: record.provider,
          customerRef: record.customerRef,
          subscriptionRef: record.subscriptionRef,
          planKey: record.planKey ?? '',
          meterKey: item.meterKey,
          providerMeter: item.providerMeter ?? item.meterKey,
          allowance: item.allowance,
          periodStart: record.periodStart,
          periodEnd: record.periodEnd,
          lastPeriod: true,
          status: 'OPEN',
        },
      ],
      skipDuplicates: true,
    });
    const report = await prisma.billingUsageReport.findUnique({ where: key });
    if (!report || report.status !== 'OPEN') return { outcome: 'closed', quantity: 0 };

    // The plan's item as it is now, so a plan changed mid-period is reported
    // under the later one, as the period's close bills it.
    const providerMeter = item.providerMeter ?? item.meterKey;
    const quantity = excessOver(
      item,
      await countUsage(record.orgId, item.meterKey, { from: record.periodStart, to: now })
    );
    // Nothing new to say: the provider's meter already holds this total.
    if (quantity === (report.runningQuantity ?? 0) && providerMeter === report.providerMeter) {
      return { outcome: 'unchanged', quantity };
    }
    if (!(await claimSend(report, now, 'OPEN'))) return { outcome: 'busy', quantity };

    const send = report.runningSends + 1;
    try {
      await provider.reportUsage({
        customerRef: report.customerRef,
        subscriptionRef: report.subscriptionRef,
        providerMeter,
        quantity,
        periodStart: report.periodStart,
        periodEnd: report.periodEnd,
        final: false,
        at: now,
        // A provider drops an identifier it saw within a day, so each total has its own.
        identifier: `${report.id}:${send}`,
      });
    } catch (error) {
      await releaseSend(report.id);
      throw error;
    }
    await prisma.billingUsageReport.update({
      where: { id: report.id },
      data: {
        runningSends: send,
        runningQuantity: quantity,
        sendingAt: null,
        planKey: record.planKey ?? report.planKey,
        allowance: item.allowance,
        providerMeter,
      },
    });
    return { outcome: 'sent', quantity };
  });
}

/**
 * Take the row's send lease: set `sendingAt` while no other send holds it (or
 * its holder is past the lease). Only the instance that took it sends.
 */
async function claimSend(
  report: Pick<BillingUsageReport, 'id'>,
  now: Date,
  status: 'OPEN' | 'COUNTED'
): Promise<boolean> {
  const claimed = await prisma.billingUsageReport.updateMany({
    where: {
      id: report.id,
      status,
      OR: [
        { sendingAt: null },
        { sendingAt: { lt: new Date(now.getTime() - USAGE_SEND_LEASE_MS) } },
      ],
    },
    data: { sendingAt: now },
  });
  return claimed.count === 1;
}

async function releaseSend(id: string): Promise<void> {
  try {
    await prisma.billingUsageReport.update({ where: { id }, data: { sendingAt: null } });
  } catch (error) {
    // The lease runs out on its own; this only makes the retry sooner.
    logger.warn('billing: could not release a usage report send', { id, error: errorText(error) });
  }
}

/** Every closed report that has settled: count it once and keep the answer. */
async function countSettled(
  provider: BillingProvider,
  now: Date,
  run: UsageReportRun
): Promise<void> {
  const read = (after: string | undefined) =>
    prisma.billingUsageReport.findMany({
      where: {
        status: 'PENDING',
        provider: provider.key,
        periodEnd: { lte: new Date(now.getTime() - USAGE_SETTLE_MS) },
        ...(after ? { id: { gt: after } } : {}),
      },
      orderBy: { id: 'asc' },
      take: PAGE,
    });
  await eachPage(
    read,
    (report) => report.id,
    async (report) => {
      try {
        const outcome = await countReport(report, now);
        if (outcome === null) return;
        run.counted += 1;
        if (outcome === 'LATE') run.late += 1;
      } catch (error) {
        run.failed += 1;
        logger.error('billing: could not count a usage report', {
          orgId: report.orgId,
          reportId: report.id,
          meterKey: report.meterKey,
          error: errorText(error),
        });
      }
    }
  );
}

/** @returns the status it was counted to, or `null` when another instance counted it first. */
async function countReport(
  report: BillingUsageReport,
  now: Date
): Promise<'COUNTED' | 'NONE' | 'LATE' | null> {
  const used = await countUsage(report.orgId, report.meterKey, {
    from: report.periodStart,
    to: report.periodEnd,
  });
  const quantity = excessOver(report, used);
  const status = report.lastPeriod ? 'LATE' : quantity > 0 ? 'COUNTED' : 'NONE';
  const written = await runAsOrg(report.orgId, () =>
    prisma.billingUsageReport.updateMany({
      // Only the first count is kept.
      where: { id: report.id, status: 'PENDING' },
      data: { status, used, quantity, countedAt: now },
    })
  );
  if (written.count === 0) return null;
  if (status === 'LATE') {
    logger.warn(
      "billing: a subscription's last period was counted after the provider invoiced it; not sent",
      {
        orgId: report.orgId,
        reportId: report.id,
        meterKey: report.meterKey,
        used,
        quantity,
        runningQuantity: report.runningQuantity,
      }
    );
  }
  return status;
}

/** Every counted report with an excess: send it, once. */
async function sendCounted(
  provider: BillingProvider,
  now: Date,
  run: UsageReportRun
): Promise<void> {
  const read = (after: string | undefined) =>
    prisma.billingUsageReport.findMany({
      where: { status: 'COUNTED', provider: provider.key, ...(after ? { id: { gt: after } } : {}) },
      orderBy: { id: 'asc' },
      take: PAGE,
    });
  await eachPage(
    read,
    (report) => report.id,
    async (report) => {
      try {
        if (await sendReport(provider, report, now)) run.sent += 1;
      } catch (error) {
        run.failed += 1;
        logger.error('billing: could not send a usage report; it is retried', {
          orgId: report.orgId,
          reportId: report.id,
          meterKey: report.meterKey,
          error: errorText(error),
        });
      }
    }
  );
}

/** @returns whether this call sent it. */
async function sendReport(
  provider: BillingProvider,
  report: BillingUsageReport,
  now: Date,
  at: Date = new Date(report.periodEnd.getTime() - 1000)
): Promise<boolean> {
  return runAsOrg(report.orgId, async () => {
    if (!(await claimSend(report, now, 'COUNTED'))) return false;
    try {
      await provider.reportUsage({
        customerRef: report.customerRef,
        subscriptionRef: report.subscriptionRef,
        providerMeter: report.providerMeter,
        quantity: report.quantity ?? 0,
        periodStart: report.periodStart,
        periodEnd: report.periodEnd,
        final: true,
        at,
        identifier: report.id,
      });
    } catch (error) {
      await releaseSend(report.id);
      throw error;
    }
    await prisma.billingUsageReport.update({
      where: { id: report.id },
      data: { status: 'SENT', sentAt: now, sendingAt: null },
    });
    if (now.getTime() > report.periodEnd.getTime() + DEFAULT_PROVIDER_GRACE_MS) {
      logger.warn(
        "billing: a usage report was sent after the provider's default grace period; it is on the invoice only if the grace period was extended",
        { orgId: report.orgId, reportId: report.id, periodEnd: report.periodEnd }
      );
    }
    return true;
  });
}

/**
 * Before the platform cancels an org's subscription (erasure), report what the
 * cancellation's invoice should carry. The open period's total so far is sent
 * as a running total (placed now, a new identifier each time), so its row
 * stays `OPEN`: if the cancellation then fails, or the erasure is never
 * retried, the period still closes, is counted and is sent as any other, and
 * the provider keeps the later value. A period that already closed and has
 * not been sent yet is counted and sent now, since erasing the org deletes
 * its rows.
 *
 * Throws when a count or a send fails, or another instance holds a send's
 * lease, so the caller can log what went unreported. Does nothing when the
 * org's record holds no live subscription at this provider, or its plan bills
 * nothing.
 *
 * @returns how many reports it sent.
 */
export async function reportBeforeCancelling(
  provider: BillingProvider,
  orgId: string,
  now: Date = new Date()
): Promise<number> {
  return runAsOrg(orgId, async () => {
    let sent = 0;
    // Closed, and not sent yet: the tick would have, minutes from now.
    const waiting = await prisma.billingUsageReport.findMany({
      where: { orgId, provider: provider.key, status: { in: ['PENDING', 'COUNTED'] } },
    });
    for (const report of waiting) {
      let counted: BillingUsageReport | null = report;
      if (report.status === 'PENDING') {
        // Counted now rather than after settling: the org's rows go with it.
        // Whoever counted it, the row says where it is now.
        await countReport(report, now);
        counted = await prisma.billingUsageReport.findUnique({ where: { id: report.id } });
      }
      if (counted === null || counted.status !== 'COUNTED') continue;
      if (!(await sendReport(provider, counted, now))) {
        throw new Error(`Usage report ${counted.id} is being sent elsewhere`);
      }
      logSentBeforeCancelling(counted, counted.quantity ?? 0);
      sent += 1;
    }

    const row = await prisma.orgBillingSubscription.findFirst({
      where: { ...LIVE_RECORD, orgId, provider: provider.key },
      select: RECORD_FIELDS,
    });
    const record = row ? asLive(row) : null;
    // A stored period already over is the one closed above; the provider's
    // next one has not been synced, so it is not known here.
    if (!record || record.periodStart >= now || record.periodEnd <= now) return sent;
    for (const item of billedItems(record.planKey)) {
      const { outcome, quantity } = await sendRunningTotal(provider, record, item, now);
      if (outcome === 'busy') {
        throw new Error(`The ${item.meterKey} usage total is being sent elsewhere`);
      }
      if (outcome === 'sent') {
        logSentBeforeCancelling({ ...record, meterKey: item.meterKey }, quantity);
        sent += 1;
      }
    }
    return sent;
  });
}

/**
 * Each report sent before a cancellation, with what it said. The provider
 * may build the cancellation's invoice before it has processed the report
 * (Stripe processes meter events asynchronously; not verified against a
 * live account), and the org's rows are then erased, so this line is what
 * the invoice can be checked against.
 */
function logSentBeforeCancelling(
  report: Pick<BillingUsageReport, 'orgId' | 'meterKey' | 'periodStart'>,
  quantity: number
): void {
  logger.info('billing: reported usage before cancelling; check it is on the final invoice', {
    orgId: report.orgId,
    meterKey: report.meterKey,
    periodStart: report.periodStart,
    quantity,
  });
}
