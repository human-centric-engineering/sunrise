/**
 * Smoke: usage reported once per billing period, and the overage rules,
 * against a real database (§139 t-1097).
 *
 *   npm run smoke:billing-usage
 *
 * What the unit tests cannot show, because they mock Prisma:
 *
 *   • **A closed period makes exactly one report per org and meter**, when
 *     the job runs twice at once (two instances) and again after: the unique
 *     key on (org, meter, period start), `ON CONFLICT DO NOTHING`, the
 *     first-count-wins update and the send lease hold on a real Postgres, and
 *     the provider is sent each report once.
 *   • **A period is counted once.** Usage that changes after the count does
 *     not change what was reported.
 *   • **AI spend** is summed from the org's real cost rows, leaving out calls
 *     on its own key, and rounded to cents once.
 *   • **The last period**: running totals while the subscription cancels at
 *     its end, each with its own identifier, and the closing count marked late
 *     and not sent. **Erasure** reports the open period's total so far
 *     before it cancels, and leaves the period open.
 *   • **Each rule**: warn tells the org once per threshold and allows; soft
 *     cap allows and reports the excess; hard cap refuses at the allowance.
 *   • **A plan with no metered items reports nothing.**
 *   • The rows are written in the org's scope (RLS on in CI) and are in the
 *     org export.
 *
 * The provider is one this script registers, recording each report. The
 * meters count what this script says they count, so a count can be changed
 * after a period closes.
 *
 * Runs at `TENANCY_MODE=multi` with `BILLING_PROVIDER=smoke` (the npm script
 * sets both). Skips clean when no database is reachable. Self-cleaning: the
 * orgs and cost rows it makes are removed on the way out, and a failed
 * cleanup fails the run.
 */
import '@/prisma/load-env';
import { prisma } from '@/lib/db/client';
import { applyPlan } from '@/lib/billing/apply-plan';
import { billingProvider } from '@/lib/billing/config';
import { setUsageNoticeHandler, type UsageNotice } from '@/lib/billing/overage';
import { planOf, registerPlan } from '@/lib/billing/plans';
import { registerBillingProvider, type BillingProvider } from '@/lib/billing/provider';
import { cancelOrgSubscriptionsAtProvider } from '@/lib/billing/erase';
import { closeBillingPeriod, runUsageReports as reportsJob } from '@/lib/billing/usage-report';
import { runUsageNotices as noticesJob } from '@/lib/billing/usage-notices';
import { ORG_DATA_SOURCES } from '@/lib/privacy/org-sources';
import { isMultiTenant, runAsOrg, runAsSystem } from '@/lib/tenancy/context';
import { registerMeter } from '@/lib/tenancy/entitlements';
import { checkMeterQuota } from '@/lib/tenancy/meters';

const stamp = Date.now().toString(36);
const PROVIDER = 'smoke';
const MINUTE = 60 * 1000;

let failures = 0;
function check(cond: boolean, msg: string): void {
  if (cond) {
    console.log(`  ✓ ${msg}`);
    return;
  }
  failures += 1;
  console.log(`  ✗ ${msg}`);
}

async function dbReachable(): Promise<boolean> {
  try {
    await runAsSystem('smoke: reachability', () => prisma.$queryRaw`SELECT 1`);
    return true;
  } catch {
    return false;
  }
}

// ─── What the meters count, and what the provider is told ───────────────────

/** Per org and meter, what its count answers. */
const counts = new Map<string, number>();
const countOf = (orgId: string, key: string) => counts.get(`${orgId}:${key}`) ?? 0;
const setCount = (orgId: string, key: string, n: number) => counts.set(`${orgId}:${key}`, n);

type Report = Parameters<BillingProvider['reportUsage']>[0];
const reports: Report[] = [];
const notices: UsageNotice[] = [];

const smokeProvider: BillingProvider = {
  key: PROVIDER,
  createCheckout: () => Promise.reject(new Error('not used')),
  openPortal: () => Promise.reject(new Error('not used')),
  expireOpenCheckouts: () => Promise.resolve(),
  parseWebhook: () => Promise.reject(new Error('not used')),
  fetchSubscription: () => Promise.resolve(null),
  listLiveSubscriptions: () => Promise.resolve([]),
  findCustomerRefs: () => Promise.resolve([]),
  reportUsage: async (input) => {
    // A round trip, so two instances' sends would overlap if nothing stopped them.
    await new Promise((resolve) => setTimeout(resolve, 20));
    reports.push(input);
  },
  cancelSubscription: () => Promise.resolve(),
};

const sentFor = (customerRef: string) => reports.filter((r) => r.customerRef === customerRef);

// ─── Orgs ───────────────────────────────────────────────────────────────────

const madeOrgs: string[] = [];
const madeCostRows: string[] = [];

async function makeOrg(name: string, record: Record<string, unknown> | null): Promise<string> {
  const org = await prisma.org.create({
    data: { slug: `smoke-billing-usage-${name}-${stamp}`, name: `Smoke billing usage ${name}` },
    select: { id: true },
  });
  madeOrgs.push(org.id);
  if (record) {
    await runAsOrg(org.id, () =>
      prisma.orgBillingSubscription.create({
        data: {
          orgId: org.id,
          provider: PROVIDER,
          customerRef: `cus_${name}_${stamp}`,
          subscriptionRef: `sub_${name}_${stamp}`,
          status: 'ACTIVE',
          providerStatus: 'active',
          providerLive: true,
          ...record,
        },
      })
    );
  }
  return org.id;
}

async function costRow(orgId: string, usd: number, ownKey = false, at = new Date()) {
  const row = await runAsOrg(orgId, () =>
    prisma.aiCostLog.create({
      data: {
        orgId,
        model: 'smoke-model',
        provider: 'smoke',
        operation: 'chat',
        inputTokens: 1,
        outputTokens: 1,
        inputCostUsd: usd,
        outputCostUsd: 0,
        totalCostUsd: usd,
        ownKey,
        createdAt: at,
      },
      select: { id: true },
    })
  );
  madeCostRows.push(row.id);
}

// As the maintenance tick runs them: under the system scope each job declares.
const runUsageReports = () => runAsSystem('smoke: usageReports', () => reportsJob());
const runUsageNotices = () => runAsSystem('smoke: usageNotices', () => noticesJob());

const reportsOf = (orgId: string) =>
  runAsOrg(orgId, () =>
    prisma.billingUsageReport.findMany({ where: { orgId }, orderBy: { meterKey: 'asc' } })
  );

// ─── The run ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!isMultiTenant()) {
    console.error('✗ smoke:billing-usage needs TENANCY_MODE=multi: billing applies only there');
    process.exit(1);
  }
  if (process.env.BILLING_PROVIDER !== PROVIDER) {
    console.error(`✗ smoke:billing-usage needs BILLING_PROVIDER=${PROVIDER}`);
    process.exit(1);
  }
  if (!(await dbReachable())) {
    console.log('– no database reachable; skipped');
    return;
  }

  // Registered here rather than through lib/app/*, which ships empty.
  for (const key of ['smoke_convos', 'smoke_leads', 'smoke_docs']) {
    registerMeter({
      key,
      label: key,
      period: 'month',
      count: ({ orgId }) => countOf(orgId, key),
    });
  }
  registerPlan({
    key: 'smoke_metered',
    label: 'Smoke metered',
    switches: {},
    priceLookupKey: `smoke_metered_${stamp}`,
    meteredItems: {
      smoke_convos: { overage: 'soft_cap', allowance: 10, providerMeter: 'smoke_convos_over' },
      ai_spend_cents: { overage: 'soft_cap', allowance: 100, providerMeter: 'smoke_ai_over' },
      smoke_leads: { overage: 'warn', allowance: 10 },
      smoke_docs: { overage: 'hard_cap', allowance: 5 },
    },
  });
  registerPlan({ key: 'smoke_plain', label: 'Smoke plain', switches: {} });
  registerBillingProvider({ key: PROVIDER, create: () => smokeProvider });
  setUsageNoticeHandler((notice) => {
    if (madeOrgs.includes(notice.orgId)) notices.push(notice);
  });
  check((await billingProvider())?.key === PROVIDER, 'billing is on with the smoke provider');

  const now = new Date();
  const closedStart = new Date(now.getTime() - 30 * 24 * 60 * MINUTE);
  const closedEnd = new Date(now.getTime() - 10 * MINUTE);
  const openEnd = new Date(now.getTime() + 10 * 24 * 60 * MINUTE);

  try {
    console.log('\nA closed period, run on two instances at once and again');
    const a = await makeOrg('a', {
      planKey: 'smoke_metered',
      periodStart: closedStart,
      periodEnd: closedEnd,
    });
    setCount(a, 'smoke_convos', 25);
    // 1.2 cents of small calls, which per call would each round to nothing,
    // $1.50 of real spend, and $5 on the org's own key, which is not billed.
    await costRow(a, 0.004, false, new Date(closedStart.getTime() + MINUTE));
    await costRow(a, 0.004, false, new Date(closedStart.getTime() + 2 * MINUTE));
    await costRow(a, 0.004, false, new Date(closedStart.getTime() + 3 * MINUTE));
    await costRow(a, 1.5, false, new Date(closedStart.getTime() + 4 * MINUTE));
    await costRow(a, 5, true, new Date(closedStart.getTime() + 5 * MINUTE));
    // After the period's end: not in it.
    await costRow(a, 9, false, new Date(closedEnd.getTime() + MINUTE));

    await Promise.all([runUsageReports(), runUsageReports()]);
    await runUsageReports();

    const rowsA = await reportsOf(a);
    const sentA = sentFor(`cus_a_${stamp}`);
    check(rowsA.length === 2, 'one report row per billed meter, no more');
    check(sentA.length === 2, 'the provider was sent each report once');
    const convos = rowsA.find((r) => r.meterKey === 'smoke_convos');
    const ai = rowsA.find((r) => r.meterKey === 'ai_spend_cents');
    check(
      convos?.status === 'SENT' && convos.used === 25 && convos.quantity === 15,
      'soft cap: 25 used against 10 allowed reports the excess, 15'
    );
    check(
      ai?.status === 'SENT' && ai.used === 151 && ai.quantity === 51,
      'AI spend: $1.512 leaving out the own-key call is 151 cents, 51 over'
    );
    const convosSent = sentA.find((r) => r.providerMeter === 'smoke_convos_over');
    check(
      convosSent?.identifier === convos?.id &&
        convosSent?.final === true &&
        convosSent.at.getTime() === closedEnd.getTime() - 1000,
      'sent with the row’s id, final, one second before the period’s end'
    );

    setCount(a, 'smoke_convos', 99);
    await runUsageReports();
    const again = await reportsOf(a);
    check(
      sentFor(`cus_a_${stamp}`).length === 2 &&
        again.find((r) => r.meterKey === 'smoke_convos')?.quantity === 15,
      'usage that changes after the count changes nothing that was reported'
    );

    console.log('\nThe webhook closing the same period');
    const closedAgain = await runAsOrg(a, () =>
      prisma.$transaction((tx) =>
        closeBillingPeriod(
          tx,
          {
            orgId: a,
            provider: PROVIDER,
            customerRef: `cus_a_${stamp}`,
            subscriptionRef: `sub_a_${stamp}`,
            planKey: 'smoke_metered',
            periodStart: closedStart,
          },
          { periodEnd: closedEnd, lastPeriod: false }
        )
      )
    );
    check(
      closedAgain === 2 && (await reportsOf(a)).length === 2,
      'closing it again adds no row and changes none counted'
    );

    console.log('\nThe last period: cancelling at its end');
    const b = await makeOrg('b', {
      planKey: 'smoke_metered',
      periodStart: closedStart,
      periodEnd: openEnd,
      cancelAtPeriodEnd: true,
    });
    setCount(b, 'smoke_convos', 12);
    await Promise.all([runUsageReports(), runUsageReports()]);
    await runUsageReports();
    let sentB = sentFor(`cus_b_${stamp}`);
    const open = (await reportsOf(b)).find((r) => r.meterKey === 'smoke_convos');
    check(
      sentB.length === 1 && sentB[0]?.final === false && sentB[0]?.quantity === 2,
      'a running total is sent, not final, once while it is unchanged'
    );
    check(sentB[0]?.identifier === `${open?.id}:1`, 'its identifier is the row’s id and a count');
    setCount(b, 'smoke_convos', 20);
    await runUsageReports();
    sentB = sentFor(`cus_b_${stamp}`);
    check(
      sentB.length === 2 && sentB[1]?.quantity === 10 && sentB[1]?.identifier === `${open?.id}:2`,
      'a changed total is sent again, under a new identifier'
    );
    await runAsOrg(b, () =>
      prisma.orgBillingSubscription.update({
        where: { orgId: b },
        data: { periodEnd: closedEnd },
      })
    );
    setCount(b, 'smoke_convos', 21);
    await runUsageReports();
    const closedB = (await reportsOf(b)).find((r) => r.meterKey === 'smoke_convos');
    check(
      closedB?.status === 'LATE' && closedB.used === 21 && sentFor(`cus_b_${stamp}`).length === 2,
      'at the close the count is recorded and marked late, and not sent'
    );

    console.log('\nErasure');
    const c = await makeOrg('c', {
      planKey: 'smoke_metered',
      periodStart: closedStart,
      periodEnd: openEnd,
    });
    setCount(c, 'smoke_convos', 30);
    const cancelled = await cancelOrgSubscriptionsAtProvider(c);
    const sentC = sentFor(`cus_c_${stamp}`);
    check(cancelled !== null, 'the cancellation ran');
    check(
      sentC.length === 1 && sentC[0]?.final === false && sentC[0]?.quantity === 20,
      'the open period’s excess so far is reported before the subscription is cancelled'
    );
    const openC = (await reportsOf(c)).find((r) => r.meterKey === 'smoke_convos');
    check(
      openC?.status === 'OPEN' && openC.periodEnd.getTime() === openEnd.getTime(),
      'its row stays open, so a cancellation that failed leaves the period to close as any other'
    );
    await cancelOrgSubscriptionsAtProvider(c);
    check(sentFor(`cus_c_${stamp}`).length === 1, 'a retried erasure does not report it again');

    console.log('\nA plan with no metered items');
    const d = await makeOrg('d', {
      planKey: 'smoke_plain',
      periodStart: closedStart,
      periodEnd: closedEnd,
    });
    await runUsageReports();
    check(
      (await reportsOf(d)).length === 0 && sentFor(`cus_d_${stamp}`).length === 0,
      'reports nothing'
    );

    console.log('\nWarn and hard cap');
    const e = await makeOrg('e', null);
    const metered = planOf('smoke_metered');
    if (!metered) throw new Error('smoke: plan not registered');
    await applyPlan(e, metered);
    await runAsOrg(e, () =>
      prisma.orgBillingSubscription.create({
        data: { orgId: e, planKey: 'smoke_metered', status: 'ACTIVE' },
      })
    );
    setCount(e, 'smoke_docs', 5);
    setCount(e, 'smoke_convos', 500);
    check(
      !(await checkMeterQuota(e, 'smoke_docs')).allowed,
      'hard cap: the allowance is the limit, and a sixth is refused'
    );
    check(
      (await checkMeterQuota(e, 'smoke_convos')).allowed,
      'soft cap: no limit is written, so usage past the allowance is allowed'
    );
    setCount(e, 'smoke_leads', 8);
    await Promise.all([runUsageNotices(), runUsageNotices()]);
    await runUsageNotices();
    const ofE = () => notices.filter((n) => n.orgId === e);
    check(
      ofE().length === 1 && ofE()[0]?.threshold === 'near' && ofE()[0]?.used === 8,
      'warn: at 80% the org is told once, on two instances and a rerun'
    );
    check((await checkMeterQuota(e, 'smoke_leads')).allowed, 'warn: and nothing is refused');
    setCount(e, 'smoke_leads', 14);
    await runUsageNotices();
    await runUsageNotices();
    check(
      ofE().length === 2 && ofE()[1]?.threshold === 'reached',
      'warn: past the allowance it is told once more, and only once'
    );

    console.log('\nThe org export');
    const reportSource = ORG_DATA_SOURCES.find((s) => s.model === 'BillingUsageReport');
    const noticeSource = ORG_DATA_SOURCES.find((s) => s.model === 'BillingUsageNotice');
    const exported = reportSource ? await runAsOrg(a, () => reportSource.fetch({ orgId: a })) : [];
    const exportedNotices = noticeSource
      ? await runAsOrg(e, () => noticeSource.fetch({ orgId: e }))
      : [];
    check(Array.isArray(exported) && exported.length === 2, 'carries the org’s usage reports');
    check(
      Array.isArray(exportedNotices) && exportedNotices.length === 2,
      'carries the org’s usage notices'
    );
  } finally {
    const orgs = [...madeOrgs];
    const rows = [...madeCostRows];
    await runAsSystem('smoke: billing-usage cleanup', async () => {
      // Cost rows outlive their org (SetNull), so they go first and by id.
      await prisma.aiCostLog.deleteMany({ where: { id: { in: rows } } });
      await prisma.org.deleteMany({ where: { id: { in: orgs } } });
    }).catch((err: unknown) => {
      console.error('✗ cleanup failed — remove the smoke-billing-usage orgs by hand', err);
      process.exitCode = 1;
    });
  }

  await prisma.$disconnect();
  if (failures > 0) {
    console.error(`\n✗ smoke:billing-usage failed (${failures} check${failures === 1 ? '' : 's'})`);
    process.exitCode = 1;
  } else if (process.exitCode !== 1) {
    console.log('\n✓ smoke:billing-usage passed');
  }
}

main().catch((err: unknown) => {
  console.error('\n✗ smoke:billing-usage failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
