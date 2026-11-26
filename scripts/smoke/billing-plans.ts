/**
 * Smoke: assigning a billing plan against a real database (§139 t-1093).
 *
 *   npm run smoke:billing-plans
 *
 * What the unit tests cannot show, because they mock Prisma:
 *
 *   • **A plan sets exactly what it names on a real org row.** Its switches,
 *     meter limits and AI budget land in `Org.settings` beside what staff set
 *     by hand (a switch it does not name, a request cap), through the real
 *     serializable writers.
 *   • **Re-assigning it writes nothing.** Neither the org row nor the
 *     subscription record is touched: both `updatedAt` columns stay put.
 *   • The subscription record is written in the org's scope, so the data
 *     layer stamps its `orgId`, and the unique key on `orgId` holds one row.
 *   • The org export's source for it returns the row, and the org's delete
 *     cascades it away.
 *
 * Runs at `TENANCY_MODE=multi` (plans apply only there) on an org it makes
 * for the run, with a plan and switches it registers itself; it changes no
 * install setting. Refuses to run at `single`; skips clean when no database
 * is reachable. Self-cleaning: the org, and with it the record, is removed on
 * the way out whether or not the checks held, and a failed cleanup fails the
 * run.
 */
import { isDeepStrictEqual } from 'node:util';

import '@/prisma/load-env';
import { prisma } from '@/lib/db/client';
import { registerPlan } from '@/lib/billing/plans';
import { assignPlan } from '@/lib/billing/subscriptions';
import { ORG_DATA_SOURCES } from '@/lib/privacy/org-sources';
import { isMultiTenant, runAsOrg, runAsSystem } from '@/lib/tenancy/context';
import { registerEntitlementSwitch } from '@/lib/tenancy/entitlements';

const stamp = Date.now().toString(36);

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

async function orgRow(orgId: string) {
  return prisma.org.findUniqueOrThrow({
    where: { id: orgId },
    select: { settings: true, updatedAt: true },
  });
}

async function record(orgId: string) {
  return runAsOrg(orgId, () =>
    prisma.orgBillingSubscription.findMany({ where: { orgId }, orderBy: { createdAt: 'asc' } })
  );
}

async function main(): Promise<void> {
  if (!isMultiTenant()) {
    console.error('✗ smoke:billing-plans needs TENANCY_MODE=multi: plans apply only there');
    process.exit(1);
  }
  if (!(await dbReachable())) {
    console.log('– no database reachable; skipped');
    return;
  }

  // Registered here rather than through lib/app/*, which ships empty. The
  // registries run the app's (empty) init on their first read and keep these.
  registerEntitlementSwitch({ key: 'smoke_reports', label: 'Smoke reports', description: '' });
  registerEntitlementSwitch({
    key: 'smoke_leads',
    label: 'Smoke leads',
    description: '',
    whenNothingSet: true,
  });
  registerEntitlementSwitch({ key: 'smoke_beta', label: 'Smoke beta', description: '' });
  registerPlan({
    key: 'smoke_free',
    label: 'Smoke Free',
    switches: { smoke_reports: false, smoke_leads: true },
    meterLimits: { seats: 3 },
    aiBudgetUsd: 5,
  });
  registerPlan({
    key: 'smoke_pro',
    label: 'Smoke Pro',
    switches: { smoke_reports: true, smoke_leads: false },
    meterLimits: { seats: 25 },
    aiBudgetUsd: 100,
  });

  let orgId: string | null = null;
  try {
    const org = await prisma.org.create({
      data: {
        slug: `smoke-billing-${stamp}`,
        name: 'Smoke billing',
        // What staff set by hand before any plan.
        settings: {
          entitlements: { on: ['smoke_beta'], off: [] },
          quotas: { requestsPerMinute: 60 },
        },
      },
      select: { id: true },
    });
    orgId = org.id;

    console.log('\nAssigning the plan');
    const first = await assignPlan(orgId, 'smoke_pro');
    check(first.changed, 'the first assignment reports a change');
    const applied = await orgRow(orgId);
    // Compared as values: JSONB does not keep key order.
    check(
      isDeepStrictEqual(applied.settings, {
        entitlements: { on: ['smoke_beta', 'smoke_reports'], off: ['smoke_leads'] },
        quotas: { requestsPerMinute: 60, monthlyBudgetUsd: 100, meters: { seats: 25 } },
      }),
      `the org holds the plan's switches, limit and budget beside what staff set (${JSON.stringify(applied.settings)})`
    );
    const rows = await record(orgId);
    check(rows.length === 1, 'one subscription record');
    check(rows[0]?.orgId === orgId, 'stamped with the org it was written in');
    check(rows[0]?.planKey === 'smoke_pro', 'naming the plan');
    check(rows[0]?.provider === null && rows[0]?.subscriptionRef === null, 'with no provider');
    check(rows[0]?.planAppliedAt instanceof Date, 'and marked applied');

    console.log('\nAssigning it again');
    // Past the millisecond, so an update would move updatedAt visibly.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const again = await assignPlan(orgId, 'smoke_pro');
    check(!again.changed, 'the second assignment reports no change');
    const after = await orgRow(orgId);
    check(after.updatedAt.getTime() === applied.updatedAt.getTime(), 'the org row was not written');
    const rowsAfter = await record(orgId);
    check(
      rowsAfter.length === 1 && rowsAfter[0]?.updatedAt.getTime() === rows[0]?.updatedAt.getTime(),
      'the subscription record was not written'
    );

    console.log('\nTwo assignments at once');
    // Under the org's billing lock they run one after the other, so whichever
    // committed last decides both the record and the settings.
    await Promise.all([assignPlan(orgId, 'smoke_free'), assignPlan(orgId, 'smoke_pro')]);
    const raced = await record(orgId);
    const racedSettings = (await orgRow(orgId)).settings as {
      quotas?: { meters?: { seats?: number } };
    };
    const seats = racedSettings.quotas?.meters?.seats;
    check(raced.length === 1, 'still one record');
    check(
      (raced[0]?.planKey === 'smoke_pro' && seats === 25) ||
        (raced[0]?.planKey === 'smoke_free' && seats === 3),
      `the record and the settings name the same plan (${raced[0]?.planKey}, seats ${seats})`
    );

    console.log('\nPrivacy');
    const source = ORG_DATA_SOURCES.find((s) => s.model === 'OrgBillingSubscription');
    const exported = source ? await runAsOrg(orgId, () => source.fetch({ orgId: orgId! })) : [];
    check(exported.length === 1, "the org export's source returns the record");

    await prisma.org.delete({ where: { id: orgId } });
    const orphaned = await runAsSystem('smoke: billing-plans erasure check', () =>
      prisma.orgBillingSubscription.count({ where: { orgId: orgId! } })
    );
    check(orphaned === 0, "the org's delete cascades its record away");
    orgId = null;
  } finally {
    if (orgId) {
      const id = orgId;
      await runAsSystem('smoke: billing-plans cleanup', () =>
        prisma.org.deleteMany({ where: { id } })
      ).catch((err: unknown) => {
        console.error('✗ cleanup failed — remove the smoke-billing org by hand', err);
        process.exitCode = 1;
      });
    }
    await prisma.$disconnect();
  }
  if (failures > 0) {
    console.error(`\n✗ smoke:billing-plans failed (${failures} check${failures === 1 ? '' : 's'})`);
    process.exitCode = 1;
  } else if (process.exitCode !== 1) {
    console.log('\n✓ smoke:billing-plans passed');
  }
}

main().catch((err: unknown) => {
  console.error('\n✗ smoke:billing-plans failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
