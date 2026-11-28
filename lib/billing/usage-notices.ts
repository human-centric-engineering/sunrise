/**
 * The `warn` overage rule's notices, and where an org's usage stands against
 * each metered item of its plan (§139 t-1097).
 *
 * A warn item stops nothing: the org is told once usage passes the item's
 * threshold (`near`) and again at the allowance (`reached`), once each per
 * window. Each notice is a `BillingUsageNotice` row, unique on (org, meter,
 * window start, threshold) and inserted before it is sent, so a retried run
 * or a second instance never sends it twice. A send that throws deletes its
 * row, so a later run tries again.
 *
 * **Who is told is the app's call** (`setUsageNoticeHandler()`). With none set
 * the platform emails the org's owners. The billing page shows the same
 * state ({@link loadPlanAllowances}) whatever the handler does.
 *
 * **The window** is the org's billing period while a provider subscription
 * gives it its plan; otherwise (a plan assigned by hand, or given away) the
 * meter's own window, and the UTC month for a standing meter and for AI spend,
 * as §110's budget counts it. A hard cap on the billing page is always the
 * meter's own window, where its limit is enforced. A standing meter has no window of its own, so
 * its notices are once a month at most.
 *
 * **Tenancy posture.** The job runs under the audited system scope to find the
 * orgs on a plan with a warn item, then reads and writes as each org. The
 * app's handler runs as the org too.
 *
 * @see lib/billing/overage.ts — the rule and the handler seam
 * @see .context/billing/billing.md#usage-reporting
 */

import type { BillingSubscriptionStatus } from '@prisma/client';

import UsageNoticeEmail from '@/emails/usage-notice';
import { prisma } from '@/lib/db/client';
import { emailLocaleForUser } from '@/lib/email/locale';
import { sendEmail } from '@/lib/email/send';
import { emailTranslator } from '@/lib/email/translate';
import { env } from '@/lib/env';
import { logger } from '@/lib/logging';
import {
  AI_SPEND_METER_KEY,
  allowanceState,
  type AllowanceState,
  type MeteredItem,
  type OverageRule,
  type UsageNotice,
} from '@/lib/billing/overage';
import {
  appUsageNoticeHandler,
  billingPlansEnabled,
  planOf,
  registeredPlans,
} from '@/lib/billing/plans';
import { billingProviderState } from '@/lib/billing/config';
import { ORG_BILLING_PAGE_PATH } from '@/lib/billing/routes';
import { countUsage } from '@/lib/billing/usage-report';
import { runAsOrg } from '@/lib/tenancy/context';
import { ORG_OWNER_ROLE } from '@/lib/tenancy/roles';
import { meterOf, meterWindow } from '@/lib/tenancy/meters';

/** The org's record, as far as a window needs it. */
interface WindowRecord {
  orgId: string;
  planKey: string | null;
  provider: string | null;
  customerRef: string | null;
  subscriptionRef: string | null;
  status: BillingSubscriptionStatus;
  periodStart: Date | null;
  periodEnd: Date | null;
}

/** What a window needs of the record: its subscription's period and state. */
type PeriodRecord = Omit<WindowRecord, 'customerRef' | 'subscriptionRef'>;

const WINDOW_FIELDS = {
  orgId: true,
  planKey: true,
  provider: true,
  customerRef: true,
  subscriptionRef: true,
  status: true,
  periodStart: true,
  periodEnd: true,
} as const;

/** The UTC month, as a `month` meter counts it. */
async function utcMonth(orgId: string, now: Date): Promise<{ from: Date; to: Date }> {
  const month = await meterWindow('month', orgId, now);
  if (!month.from || !month.to) throw new Error('A month window has no bounds');
  return { from: month.from, to: month.to };
}

/** The label a metered item goes by: its meter's, or "AI spend". */
export function meteredItemLabel(meterKey: string): string {
  if (meterKey === AI_SPEND_METER_KEY) return 'AI spend';
  return meterOf(meterKey)?.label ?? meterKey;
}

/**
 * How long past its end a stored billing period is still the window, while
 * the renewal's webhook has not moved it on. Switching to the meter's own
 * window at the boundary would start a new window, and send its notices
 * again; a period this far past its end means the sync is broken, and the
 * meter's own window is the better guess.
 */
const PERIOD_GRACE_MS = 24 * 60 * 60 * 1000;

/** The record's billing period while a provider subscription gives the org its plan. */
function billingPeriod(record: PeriodRecord): { from: Date; to: Date } | null {
  if (
    record.provider === null ||
    (record.status !== 'ACTIVE' && record.status !== 'PAST_DUE') ||
    record.periodStart === null ||
    record.periodEnd === null
  ) {
    return null;
  }
  return { from: record.periodStart, to: record.periodEnd };
}

/**
 * Whether the usage-report job bills this record's soft caps: the same live
 * record it reads (`LIVE_RECORD` in `usage-report.ts`), at the provider that
 * is switched on here.
 */
function billedHere(record: WindowRecord): boolean {
  if (billingPeriod(record) === null) return false;
  if (record.customerRef === null || record.subscriptionRef === null) return false;
  const state = billingProviderState();
  return state.on && state.providerKey === record.provider;
}

/**
 * The window a metered item's usage is measured in for this org now: the
 * billing period while a provider subscription gives the org its plan (kept a
 * day past its end until a sync moves it on), else the meter's own (the UTC
 * month for a standing meter and for AI spend). A hard cap is always the
 * meter's own window, since that is where `checkMeterQuota` counts the limit
 * the cap writes. Throws as the app's window function does.
 */
export async function allowanceWindow(
  record: PeriodRecord,
  item: Pick<MeteredItem, 'meterKey' | 'overage'>,
  now: Date
): Promise<{ from: Date; to: Date }> {
  const period = item.overage === 'hard_cap' ? null : billingPeriod(record);
  if (period && period.from <= now && now.getTime() < period.to.getTime() + PERIOD_GRACE_MS) {
    return period;
  }
  const meterKey = item.meterKey;
  const meter = meterKey === AI_SPEND_METER_KEY ? undefined : meterOf(meterKey);
  if (!meter || meter.period === 'standing') return utcMonth(record.orgId, now);
  const window = await meterWindow(meter.period, record.orgId, now);
  return window.from && window.to
    ? { from: window.from, to: window.to }
    : utcMonth(record.orgId, now);
}

/** One metered item of the org's plan, as the billing page shows it. */
export interface PlanAllowance {
  key: string;
  label: string;
  overage: OverageRule;
  allowance: number;
  /** AI spend, counted in cents. */
  money: boolean;
  /** Within the window; `null` when it could not be counted. */
  used: number | null;
  /**
   * Whether use past a soft cap is billed: only while a provider
   * subscription gives the org its plan. A plan assigned by hand reports
   * nothing, and a soft cap stops nothing, so its excess is not charged.
   */
  billed: boolean;
  state: AllowanceState | null;
  window: { from: Date; to: Date } | null;
}

/**
 * Where the org's usage stands against each metered item of its plan, for
 * the billing page. Empty when its plan has none. An item that cannot be
 * counted says so (`used: null`) and is logged; the rest still show.
 */
export async function loadPlanAllowances(
  orgId: string,
  now: Date = new Date()
): Promise<PlanAllowance[]> {
  const record = await runAsOrg(orgId, () =>
    prisma.orgBillingSubscription.findUnique({ where: { orgId }, select: WINDOW_FIELDS })
  );
  const plan = record?.planKey ? planOf(record.planKey) : undefined;
  if (!record || !plan) return [];
  return Promise.all(
    Object.values(plan.meteredItems).map(async (item): Promise<PlanAllowance> => {
      const base = {
        key: item.meterKey,
        label: meteredItemLabel(item.meterKey),
        overage: item.overage,
        allowance: item.allowance,
        money: item.meterKey === AI_SPEND_METER_KEY,
        billed: billedHere(record),
      };
      try {
        const window = await allowanceWindow(record, item, now);
        const used = await countUsage(orgId, item.meterKey, window);
        return { ...base, used, state: allowanceState(item, used), window };
      } catch (error) {
        logger.error('billing: a metered item could not be counted for the billing page', {
          orgId,
          meterKey: item.meterKey,
          error: error instanceof Error ? error.message : String(error),
        });
        return { ...base, used: null, state: null, window: null };
      }
    })
  );
}

/** What one run of the notices job did, for the tick's log line. */
export interface UsageNoticeRun {
  /** Warn items counted. */
  checked: number;
  /** Notices sent. */
  notified: number;
  /** Counts or sends that failed, to be retried on a later run. */
  failed: number;
}

/** Orgs read per page while walking every org on a plan with a warn item. */
const PAGE = 200;

/**
 * One run of the warn notices: count each warn item of each org on a plan
 * with one, and tell the org once per window when it is near or at the
 * allowance. Never throws for one org: a failure is logged, counted, and
 * retried on a later run.
 */
export async function runUsageNotices(now: Date = new Date()): Promise<UsageNoticeRun> {
  const run: UsageNoticeRun = { checked: 0, notified: 0, failed: 0 };
  if (!billingPlansEnabled()) return run;
  const planKeys = registeredPlans()
    .filter((plan) => Object.values(plan.meteredItems).some((item) => item.overage === 'warn'))
    .map((plan) => plan.key);
  if (planKeys.length === 0) return run;

  let cursor: string | undefined;
  for (;;) {
    const records = await prisma.orgBillingSubscription.findMany({
      where: { planKey: { in: planKeys }, ...(cursor ? { orgId: { gt: cursor } } : {}) },
      select: WINDOW_FIELDS,
      orderBy: { orgId: 'asc' },
      take: PAGE,
    });
    for (const record of records) {
      const plan = record.planKey ? planOf(record.planKey) : undefined;
      for (const item of Object.values(plan?.meteredItems ?? {})) {
        if (item.overage !== 'warn' || !plan) continue;
        try {
          run.checked += 1;
          if (await checkItem(record, plan.key, item, now)) run.notified += 1;
        } catch (error) {
          run.failed += 1;
          logger.error('billing: could not check or send a usage notice', {
            orgId: record.orgId,
            meterKey: item.meterKey,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    if (records.length < PAGE) break;
    cursor = records[records.length - 1]?.orgId;
  }
  return run;
}

/** @returns whether a notice was sent. */
async function checkItem(
  record: WindowRecord,
  planKey: string,
  item: MeteredItem,
  now: Date
): Promise<boolean> {
  const window = await allowanceWindow(record, item, now);
  const used = await countUsage(record.orgId, item.meterKey, window);
  const state = allowanceState(item, used);
  if (state === 'within') return false;

  const orgId = record.orgId;
  const claim = (threshold: 'near' | 'reached') =>
    runAsOrg(orgId, () =>
      prisma.billingUsageNotice.createMany({
        data: [
          {
            orgId,
            meterKey: item.meterKey,
            periodStart: window.from,
            threshold,
            used,
            allowance: item.allowance,
          },
        ],
        skipDuplicates: true,
      })
    );
  const claimed = await claim(state);
  if (claimed.count === 0) return false;

  const notice: UsageNotice = {
    orgId,
    planKey,
    meterKey: item.meterKey,
    label: meteredItemLabel(item.meterKey),
    threshold: state,
    used,
    allowance: item.allowance,
    periodStart: window.from,
    periodEnd: window.to,
  };
  try {
    // As the org, as an app's org hooks run, so the handler's reads and
    // writes are confined to it rather than run with the job's system scope.
    const handler = appUsageNoticeHandler() ?? emailOwners;
    await runAsOrg(orgId, async () => {
      await handler(notice);
    });
  } catch (error) {
    // Unclaimed, so a later run sends it. A release that fails too is
    // logged, and the handler's error is the one rethrown.
    try {
      await runAsOrg(orgId, () =>
        prisma.billingUsageNotice.deleteMany({
          where: { orgId, meterKey: item.meterKey, periodStart: window.from, threshold: state },
        })
      );
    } catch (releaseError) {
      logger.error('billing: could not release a usage notice that failed; it is not retried', {
        orgId,
        meterKey: item.meterKey,
        threshold: state,
        error: releaseError instanceof Error ? releaseError.message : String(releaseError),
      });
    }
    throw error;
  }
  // At the allowance, "near" is past too: claimed quietly once "reached" is
  // sent, so it is not sent later in the window as if usage were still
  // climbing towards it. Failing here sends nothing twice, so it is logged.
  if (state === 'reached') {
    try {
      await claim('near');
    } catch (error) {
      logger.warn('billing: could not mark a usage notice’s "near" as passed', {
        orgId,
        meterKey: item.meterKey,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  logger.info('billing: told an org it is near or at an allowance', {
    orgId,
    meterKey: item.meterKey,
    threshold: state,
    used,
    allowance: item.allowance,
  });
  return true;
}

/**
 * The platform's default notice: an email to each of the org's owners, in
 * their language. Throws when a send fails, so the notice is retried; a
 * resend within a day carries the same idempotency key, so an owner whose
 * copy went through is not emailed twice.
 */
export async function emailOwners(notice: UsageNotice): Promise<void> {
  const [org, owners] = await Promise.all([
    // `Org` and `OrgMembership` are system models: no tenant scope is needed.
    prisma.org.findUnique({ where: { id: notice.orgId }, select: { name: true } }),
    prisma.orgMembership.findMany({
      where: { orgId: notice.orgId, role: ORG_OWNER_ROLE },
      select: { user: { select: { id: true, email: true } } },
    }),
  ]);
  if (!org) return;
  if (owners.length === 0) {
    logger.warn('billing: an org near or at an allowance has no owner to tell', {
      orgId: notice.orgId,
      meterKey: notice.meterKey,
    });
    return;
  }
  const billingUrl = `${env.BETTER_AUTH_URL.replace(/\/+$/, '')}${ORG_BILLING_PAGE_PATH}`;
  const failed: string[] = [];
  for (const { user } of owners) {
    const where = await emailLocaleForUser(user.id, { orgId: notice.orgId });
    const props = {
      orgName: org.name,
      meterLabel: notice.label,
      threshold: notice.threshold,
      used: notice.used,
      allowance: notice.allowance,
      money: notice.meterKey === AI_SPEND_METER_KEY,
      billingUrl,
      ...where,
    };
    const result = await sendEmail({
      to: user.email,
      subject: emailTranslator(where, 'emails.usageNotice')('subject', {
        org: org.name,
        meter: notice.label,
        threshold: notice.threshold,
      }),
      react: UsageNoticeEmail(props),
      idempotencyKey: `usage-notice:${notice.orgId}:${notice.meterKey}:${notice.periodStart.toISOString()}:${notice.threshold}:${user.id}`,
    });
    if (!result.success) failed.push(user.id);
  }
  if (failed.length > 0) {
    throw new Error(`The usage notice could not be emailed to ${failed.length} owner(s)`);
  }
}
