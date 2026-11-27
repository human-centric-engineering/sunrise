/**
 * Unit Tests: assigning a plan by hand, and applying it (§139 t-1093)
 *
 * The real plan and entitlement registries, the real `applyPlan()`, and the
 * real settings writers (`setOrgSwitches()`, `writeOrgMeterLimits()`,
 * `updateOrgQuotas()`), over an in-memory org row and subscription table
 * behind a mocked Prisma. Pins: a plan writes exactly what it decides and
 * nothing else; re-assigning it writes nothing; a write that did not finish is
 * finished by assigning again; a provider subscription is not overridden; "no
 * plan" leaves the settings alone; and the refusals.
 *
 * The same against the real dev database: `npm run smoke:billing-plans`.
 *
 * @see lib/billing/subscriptions.ts · lib/billing/apply-plan.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';

const mockEnv = vi.hoisted(() => ({ TENANCY_MODE: 'multi' }));
vi.mock('@/lib/env', () => ({ env: mockEnv }));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockForgetOrgCap = vi.hoisted(() => vi.fn());
vi.mock('@/lib/orchestration/llm/spend-caps', () => ({ forgetOrgCap: mockForgetOrgCap }));

interface SubscriptionRow {
  orgId: string;
  planKey: string | null;
  provider: string | null;
  customerRef: string | null;
  subscriptionRef: string | null;
  status: 'INCOMPLETE' | 'ACTIVE' | 'PAST_DUE' | 'ENDED';
  periodStart: Date | null;
  periodEnd: Date | null;
  planAppliedAt: Date | null;
  updatedAt: Date;
  providerLive?: boolean;
}

const store = vi.hoisted(() => ({
  orgs: new Map<string, { settings: unknown }>(),
  subscriptions: new Map<string, SubscriptionRow>(),
}));

const mockPrisma = vi.hoisted(() => {
  const pick = (row: Record<string, unknown>, select?: Record<string, boolean>) =>
    select
      ? Object.fromEntries(
          Object.keys(select)
            .filter((k) => select[k])
            .map((k) => [k, row[k]])
        )
      : { ...row };
  const db = {
    org: {
      findUnique: vi.fn(
        async ({ where, select }: { where: { id: string }; select?: Record<string, boolean> }) => {
          const org = store.orgs.get(where.id);
          return org ? pick({ id: where.id, ...org }, select) : null;
        }
      ),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: { settings: unknown } }) => {
          const settings = data.settings === Prisma.DbNull ? null : data.settings;
          store.orgs.set(where.id, { settings: structuredClone(settings) });
          return { id: where.id, settings };
        }
      ),
    },
    orgBillingSubscription: {
      findUnique: vi.fn(
        async ({
          where,
          select,
        }: {
          where: { orgId: string };
          select?: Record<string, boolean>;
        }) => {
          const row = store.subscriptions.get(where.orgId);
          return row ? pick({ ...row }, select) : null;
        }
      ),
      upsert: vi.fn(
        async ({
          where,
          create,
          update,
          select,
        }: {
          where: { orgId: string };
          create: Partial<SubscriptionRow>;
          update: Partial<SubscriptionRow>;
          select?: Record<string, boolean>;
        }) => {
          const existing = store.subscriptions.get(where.orgId);
          const row: SubscriptionRow = existing
            ? { ...existing, ...update, updatedAt: new Date() }
            : {
                orgId: where.orgId,
                planKey: null,
                provider: null,
                customerRef: null,
                subscriptionRef: null,
                status: 'ACTIVE',
                periodStart: null,
                periodEnd: null,
                planAppliedAt: null,
                ...create,
                updatedAt: new Date(),
              };
          store.subscriptions.set(where.orgId, row);
          return pick({ ...row }, select);
        }
      ),
      update: vi.fn(
        async ({
          where,
          data,
          select,
        }: {
          where: { orgId: string };
          data: Partial<SubscriptionRow>;
          select?: Record<string, boolean>;
        }) => {
          const existing = store.subscriptions.get(where.orgId);
          if (!existing) throw new Error('no row');
          const row = { ...existing, ...data, updatedAt: new Date() };
          store.subscriptions.set(where.orgId, row);
          return pick({ ...row }, select);
        }
      ),
      delete: vi.fn(async ({ where }: { where: { orgId: string } }) => {
        store.subscriptions.delete(where.orgId);
      }),
    },
    $executeRaw: vi.fn(async () => 0),
    // The org row `FOR UPDATE`: the row when the org exists.
    $queryRaw: vi.fn(async (_sql: TemplateStringsArray, id: string) =>
      store.orgs.has(id) ? [{ id }] : []
    ),
    $transaction: vi.fn(),
  };
  return db;
});

/**
 * The outer transaction as Postgres runs it, for what matters here: a throw
 * rolls the org row and the record back. The settings writers run inside it
 * (`assignPlan()` hands them a client bound to it), so they never reach this.
 */
function transactionRollsBack() {
  mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
    const orgs = structuredClone([...store.orgs]);
    const subscriptions = structuredClone([...store.subscriptions]);
    try {
      return await fn(mockPrisma);
    } catch (error) {
      store.orgs = new Map(orgs);
      store.subscriptions = new Map(subscriptions);
      throw error;
    }
  });
}
vi.mock('@/lib/db/client', () => ({ prisma: mockPrisma }));

vi.mock('@/lib/app/billing', () => ({ initAppBilling: vi.fn() }));
vi.mock('@/lib/app/entitlements', () => ({ initAppEntitlements: vi.fn() }));

import { initAppBilling } from '@/lib/app/billing';
import { initAppEntitlements } from '@/lib/app/entitlements';
import { __resetBillingPlansForTests, registerPlan } from '@/lib/billing/plans';
import { assignPlan, BillingPlanError, loadOrgSubscription } from '@/lib/billing/subscriptions';
import { getTenantContext } from '@/lib/tenancy/context';
import {
  __resetEntitlementRegistryForTests,
  registerEntitlementSwitch,
  registerMeter,
} from '@/lib/tenancy/entitlements';

const ORG = 'cmorg000000000000000other';

function conflict() {
  return new Prisma.PrismaClientKnownRequestError('clash', {
    code: 'P2034',
    clientVersion: 'test',
  });
}

/** What staff set by hand before any plan: a switch no plan names, and a request cap. */
const HAND_SET = {
  entitlements: { on: ['beta'], off: [] },
  quotas: { requestsPerMinute: 60, meters: { convos: 9 } },
  privacy: { minimumMode: null, protectedTerms: [] },
};

function settings(): Record<string, unknown> {
  return store.orgs.get(ORG)?.settings as Record<string, unknown>;
}

function writes() {
  return {
    org: mockPrisma.org.update.mock.calls.length,
    record:
      mockPrisma.orgBillingSubscription.upsert.mock.calls.length +
      mockPrisma.orgBillingSubscription.update.mock.calls.length +
      mockPrisma.orgBillingSubscription.delete.mock.calls.length,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEnv.TENANCY_MODE = 'multi';
  store.orgs.clear();
  store.subscriptions.clear();
  store.orgs.set(ORG, { settings: structuredClone(HAND_SET) });
  transactionRollsBack();

  __resetEntitlementRegistryForTests();
  __resetBillingPlansForTests();
  vi.mocked(initAppEntitlements).mockImplementation(() => {
    registerEntitlementSwitch({ key: 'reports', label: 'Reports', description: '' });
    registerEntitlementSwitch({
      key: 'leads',
      label: 'Leads',
      description: '',
      whenNothingSet: true,
    });
    registerEntitlementSwitch({ key: 'beta', label: 'Beta', description: '' });
    registerMeter({ key: 'convos', label: 'Conversations', period: 'month', count: () => 0 });
  });
  vi.mocked(initAppBilling).mockImplementation(() => {
    registerPlan({
      key: 'pro',
      label: 'Pro',
      switches: { reports: true, leads: false },
      meterLimits: { seats: 25, convos: null },
      aiBudgetUsd: 100,
    });
    registerPlan({ key: 'switches_only', label: 'Switches only', switches: { reports: true } });
  });
});

describe('assignPlan', () => {
  it('writes exactly the switches, limits and budget the plan names, and keeps the rest', async () => {
    const result = await assignPlan(ORG, 'pro');

    expect(settings()).toEqual({
      // `beta` was set by hand and the plan does not name it.
      entitlements: { on: ['beta', 'reports'], off: ['leads'] },
      // The request cap stays; `convos: null` cleared its limit.
      quotas: { requestsPerMinute: 60, monthlyBudgetUsd: 100, meters: { seats: 25 } },
      privacy: HAND_SET.privacy,
    });
    expect(result).toMatchObject({ previousPlanKey: null, planKey: 'pro', changed: true });
    expect(result.applied).toEqual({
      changed: true,
      switches: {
        from: { on: ['beta'], off: [] },
        to: { on: ['beta', 'reports'], off: ['leads'] },
      },
      meterLimits: { from: { convos: 9 }, to: { seats: 25 } },
      aiBudgetUsd: { from: null, to: 100 },
    });
    // So this process enforces the new budget at once.
    expect(mockForgetOrgCap).toHaveBeenCalledWith(ORG);
    expect(store.subscriptions.get(ORG)).toMatchObject({
      planKey: 'pro',
      provider: null,
      subscriptionRef: null,
      status: 'ACTIVE',
      planAppliedAt: expect.any(Date),
    });
  });

  it('writes nothing at all when the plan is assigned again', async () => {
    await assignPlan(ORG, 'pro');
    const before = writes();
    mockForgetOrgCap.mockClear();

    const again = await assignPlan(ORG, 'pro');

    expect(again).toMatchObject({ previousPlanKey: 'pro', planKey: 'pro', changed: false });
    expect(again.applied?.changed).toBe(false);
    expect(writes()).toEqual(before);
    expect(mockForgetOrgCap).not.toHaveBeenCalled();
  });

  it('puts back what the plan decides when it has drifted, without a second record row', async () => {
    await assignPlan(ORG, 'pro');
    const firstApplied = store.subscriptions.get(ORG)?.planAppliedAt;
    // Staff changed a limit by hand since.
    const drifted = settings();
    (drifted.quotas as { meters: Record<string, number> }).meters.seats = 3;
    store.orgs.set(ORG, { settings: drifted });

    const again = await assignPlan(ORG, 'pro');

    expect(again.changed).toBe(true);
    expect(again.applied?.meterLimits).toEqual({ from: { seats: 3 }, to: { seats: 25 } });
    expect(again.applied?.switches).toBeNull();
    expect(again.applied?.aiBudgetUsd).toBeNull();
    // Still one record, stamped as applied again.
    expect(store.subscriptions.size).toBe(1);
    expect(store.subscriptions.get(ORG)?.planAppliedAt?.getTime()).toBeGreaterThanOrEqual(
      firstApplied!.getTime()
    );
  });

  it('decides only what it names: a plan with switches alone leaves limits and budget', async () => {
    await assignPlan(ORG, 'switches_only');

    expect(settings().quotas).toEqual(HAND_SET.quotas);
    expect(mockForgetOrgCap).not.toHaveBeenCalled();
  });

  it('writes nothing when a write fails part-way: the record and the settings roll back together', async () => {
    const failure = new Error('database down');
    // The switches land, then the limits write fails.
    const real = mockPrisma.org.update.getMockImplementation()!;
    mockPrisma.org.update.mockImplementationOnce(real).mockRejectedValueOnce(failure);

    await expect(assignPlan(ORG, 'pro')).rejects.toBe(failure);

    expect(settings()).toEqual(HAND_SET);
    expect(store.subscriptions.has(ORG)).toBe(false);
    expect(mockForgetOrgCap).not.toHaveBeenCalled();
    // Not a conflict, so not run again.
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('runs again after Postgres fails it with a write conflict or deadlock, and applies the plan', async () => {
    // Nothing of the failed run stays.
    const real = mockPrisma.org.update.getMockImplementation()!;
    mockPrisma.org.update.mockImplementationOnce(real).mockRejectedValueOnce(conflict());

    const result = await assignPlan(ORG, 'pro');

    expect(result.changed).toBe(true);
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(2);
    expect(settings().entitlements).toEqual({ on: ['beta', 'reports'], off: ['leads'] });
    expect(store.subscriptions.get(ORG)?.planAppliedAt).toEqual(expect.any(Date));
  });

  it('gives up after three conflicts, with nothing written', async () => {
    // Once per run; `mockRejectedValue` would outlive this test.
    mockPrisma.org.update
      .mockRejectedValueOnce(conflict())
      .mockRejectedValueOnce(conflict())
      .mockRejectedValueOnce(conflict());

    await expect(assignPlan(ORG, 'pro')).rejects.toMatchObject({ code: 'P2034' });

    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(3);
    expect(settings()).toEqual(HAND_SET);
    expect(store.subscriptions.has(ORG)).toBe(false);
  });

  it('takes the billing lock, then the org row, before it reads the record', async () => {
    await assignPlan(ORG, 'pro');

    expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(1);
    const [lockSql, key] = mockPrisma.$executeRaw.mock.calls[0] as unknown as [string[], string];
    expect(lockSql.join('?')).toContain('pg_advisory_xact_lock');
    expect(key).toBe(`billing:${ORG}`);
    const [rowSql, id] = mockPrisma.$queryRaw.mock.calls[0] as unknown as [string[], string];
    expect(rowSql.join('?')).toMatch(/FROM "org" WHERE "id" = \? FOR NO KEY UPDATE$/);
    expect(id).toBe(ORG);
    const lock = mockPrisma.$executeRaw.mock.invocationCallOrder[0];
    const row = mockPrisma.$queryRaw.mock.invocationCallOrder[0];
    const read = mockPrisma.orgBillingSubscription.findUnique.mock.invocationCallOrder[0];
    expect(lock).toBeLessThan(row);
    expect(row).toBeLessThan(read);
    // READ COMMITTED, so the reads after the locks see the latest commit.
    expect(mockPrisma.$transaction.mock.calls[0]?.[1]).toMatchObject({
      isolationLevel: 'ReadCommitted',
    });
  });

  it('refuses, writing nothing, when the org is gone by the time it is locked', async () => {
    mockPrisma.$queryRaw.mockResolvedValueOnce([]);

    await expect(assignPlan(ORG, 'pro')).rejects.toMatchObject({ code: 'ORG_NOT_FOUND' });
    expect(writes()).toEqual({ org: 0, record: 0 });
  });

  it('writes the settings of a plan its record names but does not mark applied', async () => {
    store.subscriptions.set(ORG, {
      orgId: ORG,
      planKey: 'pro',
      provider: null,
      customerRef: null,
      subscriptionRef: null,
      status: 'ACTIVE',
      periodStart: null,
      periodEnd: null,
      planAppliedAt: null,
      updatedAt: new Date(),
    });

    const result = await assignPlan(ORG, 'pro');

    expect(result.changed).toBe(true);
    expect(store.subscriptions.get(ORG)?.planAppliedAt).toEqual(expect.any(Date));
    expect(settings().entitlements).toEqual({ on: ['beta', 'reports'], off: ['leads'] });
    expect((await loadOrgSubscription(ORG))?.planAppliedAt).toEqual(expect.any(Date));
  });

  it('runs its record reads and writes as the org', async () => {
    let seen: string | null | undefined;
    mockPrisma.orgBillingSubscription.findUnique.mockImplementationOnce(async () => {
      seen = getTenantContext()?.orgId;
      return null;
    });

    await assignPlan(ORG, 'pro');

    expect(seen).toBe(ORG);
  });

  it('takes the org off its plan and leaves what the plan gave', async () => {
    await assignPlan(ORG, 'pro');
    const given = structuredClone(settings());
    const orgWrites = writes().org;

    const result = await assignPlan(ORG, null);

    expect(result).toMatchObject({ previousPlanKey: 'pro', planKey: null, changed: true });
    expect(store.subscriptions.has(ORG)).toBe(false);
    expect(settings()).toEqual(given);
    expect(writes().org).toBe(orgWrites);
  });

  it('writes nothing for "no plan" on an org that has none', async () => {
    const result = await assignPlan(ORG, null);

    expect(result.changed).toBe(false);
    expect(writes()).toEqual({ org: 0, record: 0 });
  });

  it('refuses while a provider subscription decides the plan, and writes nothing', async () => {
    store.subscriptions.set(ORG, {
      orgId: ORG,
      planKey: 'pro',
      provider: 'stripe',
      customerRef: 'cus_1',
      subscriptionRef: 'sub_1',
      status: 'PAST_DUE',
      periodStart: null,
      periodEnd: null,
      planAppliedAt: new Date(),
      updatedAt: new Date(),
    });

    await expect(assignPlan(ORG, 'switches_only')).rejects.toMatchObject({
      code: 'PROVIDER_MANAGED',
    });
    await expect(assignPlan(ORG, null)).rejects.toMatchObject({ code: 'PROVIDER_MANAGED' });
    expect(writes()).toEqual({ org: 0, record: 0 });
  });

  it('refuses over an ended subscription the provider can still charge (unpaid, paused)', async () => {
    // Assigned over, its reference would be cleared, and erasure with billing
    // off could no longer see it was still collectable (t-1094 round 2).
    store.subscriptions.set(ORG, {
      orgId: ORG,
      planKey: 'pro',
      provider: 'stripe',
      customerRef: 'cus_1',
      subscriptionRef: 'sub_1',
      status: 'ENDED',
      providerLive: true,
      periodStart: null,
      periodEnd: null,
      planAppliedAt: new Date(),
      updatedAt: new Date(),
    });

    await expect(assignPlan(ORG, 'switches_only')).rejects.toMatchObject({
      code: 'PROVIDER_MANAGED',
    });
    await expect(assignPlan(ORG, null)).rejects.toMatchObject({ code: 'PROVIDER_MANAGED' });
    expect(writes()).toEqual({ org: 0, record: 0 });
  });

  it('assigns over an ended provider subscription, keeping the customer for erasure', async () => {
    store.subscriptions.set(ORG, {
      orgId: ORG,
      planKey: 'pro',
      provider: 'stripe',
      customerRef: 'cus_1',
      subscriptionRef: 'sub_1',
      status: 'ENDED',
      periodStart: new Date('2026-10-01'),
      periodEnd: new Date('2026-11-01'),
      planAppliedAt: new Date(),
      updatedAt: new Date(),
    });

    await assignPlan(ORG, 'switches_only');

    expect(store.subscriptions.get(ORG)).toMatchObject({
      planKey: 'switches_only',
      provider: 'stripe',
      customerRef: 'cus_1',
      subscriptionRef: null,
      status: 'ACTIVE',
      periodStart: null,
      periodEnd: null,
    });
  });

  it('keeps the customer of an ended subscription when the org is taken off its plan', async () => {
    store.subscriptions.set(ORG, {
      orgId: ORG,
      planKey: 'pro',
      provider: 'stripe',
      customerRef: 'cus_1',
      subscriptionRef: 'sub_1',
      status: 'ENDED',
      periodStart: new Date('2026-10-01'),
      periodEnd: new Date('2026-11-01'),
      planAppliedAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await assignPlan(ORG, null);

    expect(result).toMatchObject({ previousPlanKey: 'pro', planKey: null, changed: true });
    expect(store.subscriptions.get(ORG)).toMatchObject({
      planKey: null,
      provider: 'stripe',
      customerRef: 'cus_1',
      subscriptionRef: null,
      planAppliedAt: null,
    });
    expect(mockPrisma.orgBillingSubscription.delete).not.toHaveBeenCalled();

    // …and a second "no plan" has nothing left to change.
    expect((await assignPlan(ORG, null)).changed).toBe(false);
  });

  it.each<[string, () => void, string]>([
    ['plans are off at single', () => (mockEnv.TENANCY_MODE = 'single'), 'BILLING_OFF'],
    [
      'no plan is registered',
      () => vi.mocked(initAppBilling).mockImplementation(() => {}),
      'BILLING_OFF',
    ],
  ])('refuses when %s, and writes nothing', async (_name, arrange, code) => {
    arrange();

    await expect(assignPlan(ORG, 'pro')).rejects.toMatchObject({ code });
    expect(writes()).toEqual({ org: 0, record: 0 });
  });

  it('refuses a plan key nothing registers', async () => {
    const error = await assignPlan(ORG, 'enterprise').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BillingPlanError);
    expect(error).toMatchObject({ code: 'UNKNOWN_PLAN' });
    expect(writes()).toEqual({ org: 0, record: 0 });
  });

  it('refuses an org that does not exist', async () => {
    await expect(assignPlan('cmorg0000000000000missing', 'pro')).rejects.toMatchObject({
      code: 'ORG_NOT_FOUND',
    });
  });
});
