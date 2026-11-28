/**
 * Unit Tests: usage reported once per billing period (§139 t-1097)
 *
 * The real `runUsageReports()`, `closeBillingPeriod()`, `countUsage()` and
 * `reportBeforeCancelling()` over an in-memory record and report table behind
 * a mocked Prisma that applies the filters the module writes (`in`, `notIn`,
 * `not`, `lt`, `lte`, `gt`, `OR`), so the claim and first-count-wins updates
 * behave as they would on Postgres within one process. The meters and the
 * provider are fakes.
 *
 * Pins: off unless it can bill (no provider, plans off, nothing soft-capped);
 * a closed period is counted once after it settles and sent once, with the
 * row's id, final, a second before the end; within the allowance nothing is
 * sent; a failed send is retried and a held lease is respected; a last period
 * sends running totals and is marked late at its close; erasure reports the
 * open period once.
 *
 * Exactly once across two real database sessions, and each rule end to end:
 * `npm run smoke:billing-usage`.
 *
 * @see lib/billing/usage-report.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/tenancy/context', () => ({
  runAsOrg: (_orgId: string, fn: () => unknown) => fn(),
}));
vi.mock('@/lib/auth/subject-context', () => ({
  runAcrossOwners: (_reason: string, fn: () => unknown) => fn(),
}));

const counts = vi.hoisted(() => new Map<string, number>());
const mockCountMeter = vi.hoisted(() =>
  vi.fn(async (orgId: string, key: string) => counts.get(`${orgId}:${key}`) ?? 0)
);
vi.mock('@/lib/tenancy/meters', () => ({ countMeterWithin: mockCountMeter }));

// ─── Plans ──────────────────────────────────────────────────────────────────

const plans = vi.hoisted(() => ({ enabled: true, list: [] as unknown[] }));
vi.mock('@/lib/billing/plans', () => ({
  billingPlansEnabled: () => plans.enabled,
  registeredPlans: () => plans.list,
  planOf: (key: string) => (plans.list as { key: string }[]).find((p) => p.key === key),
}));

const METERED = {
  key: 'pro',
  meteredItems: {
    convos: {
      meterKey: 'convos',
      overage: 'soft_cap',
      allowance: 10,
      providerMeter: 'convos_over',
      warnAtPercent: null,
    },
    leads: {
      meterKey: 'leads',
      overage: 'warn',
      allowance: 10,
      providerMeter: null,
      warnAtPercent: 80,
    },
  },
};
const UNMETERED = { key: 'free', meteredItems: {} };

// ─── The database ───────────────────────────────────────────────────────────

type Row = Record<string, unknown>;

function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'OR') return (cond as Row[]).some((c) => matches(row, c));
    const value = row[key] ?? null;
    if (cond instanceof Date) return value instanceof Date && value.getTime() === cond.getTime();
    if (cond !== null && typeof cond === 'object') {
      const ops = cond as Record<string, unknown>;
      const cmp = (other: unknown) =>
        value instanceof Date && other instanceof Date
          ? value.getTime() - other.getTime()
          : typeof value === 'string' && typeof other === 'string'
            ? value.localeCompare(other)
            : (value as number) - (other as number);
      if ('in' in ops && !(ops.in as unknown[]).includes(value)) return false;
      if ('notIn' in ops && (ops.notIn as unknown[]).includes(value)) return false;
      if ('not' in ops && ops.not === null && value === null) return false;
      if ('lt' in ops && (value === null || cmp(ops.lt) >= 0)) return false;
      if ('lte' in ops && (value === null || cmp(ops.lte) > 0)) return false;
      if ('gt' in ops && (value === null || cmp(ops.gt) <= 0)) return false;
      return true;
    }
    return value === cond;
  });
}

/** `orderBy: { field: 'asc' }`, on one string field, as the module pages. */
function ordered(rows: Row[], orderBy?: Record<string, 'asc'>): Row[] {
  const field = orderBy ? Object.keys(orderBy)[0] : undefined;
  if (!field) return rows;
  return [...rows].sort((a, b) => String(a[field]).localeCompare(String(b[field])));
}

const db = vi.hoisted((): { records: Row[]; reports: Row[]; cost: number | null } => ({
  records: [],
  reports: [],
  cost: 0,
}));
let nextId = 0;

const mockPrisma = vi.hoisted(() => ({
  orgBillingSubscription: {
    findMany: vi.fn(
      async ({
        where,
        take,
        orderBy,
      }: {
        where: Row;
        take?: number;
        orderBy?: Record<string, 'asc'>;
      }) =>
        ordered(
          db.records.filter((r) => matches(r, where)),
          orderBy
        ).slice(0, take ?? Infinity)
    ),
    findFirst: vi.fn(
      async ({ where }: { where: Row }) => db.records.find((r) => matches(r, where)) ?? null
    ),
  },
  billingUsageReport: {
    count: vi.fn(
      async ({ where }: { where: Row }) => db.reports.filter((r) => matches(r, where)).length
    ),
    createMany: vi.fn(async ({ data }: { data: Row[] }) => {
      let count = 0;
      for (const row of data) {
        // Unique on (orgId, meterKey, periodStart), ON CONFLICT DO NOTHING.
        const clash = db.reports.some(
          (r) =>
            r.orgId === row.orgId &&
            r.meterKey === row.meterKey &&
            (r.periodStart as Date).getTime() === (row.periodStart as Date).getTime()
        );
        if (clash) continue;
        db.reports.push({
          id: `rep_${++nextId}`,
          lastPeriod: false,
          status: 'PENDING',
          used: null,
          quantity: null,
          countedAt: null,
          runningSends: 0,
          runningQuantity: null,
          sendingAt: null,
          sentAt: null,
          ...row,
        });
        count += 1;
      }
      return { count };
    }),
    updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
      const hit = db.reports.filter((r) => matches(r, where));
      for (const r of hit) Object.assign(r, data);
      return { count: hit.length };
    }),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Row }) => {
      const row = db.reports.find((r) => r.id === where.id);
      if (!row) throw new Error('no such report');
      Object.assign(row, data);
      return { ...row };
    }),
    findUnique: vi.fn(
      async ({ where }: { where: { id?: string; orgId_meterKey_periodStart?: Row } }) => {
        const key = where.orgId_meterKey_periodStart ?? { id: where.id };
        const row = db.reports.find((r) => matches(r, key));
        return row ? { ...row } : null;
      }
    ),
    findMany: vi.fn(
      async ({
        where,
        take,
        orderBy,
      }: {
        where: Row;
        take?: number;
        orderBy?: Record<string, 'asc'>;
      }) =>
        ordered(
          db.reports.filter((r) => matches(r, where)),
          orderBy
        )
          .slice(0, take ?? Infinity)
          .map((r) => ({ ...r }))
    ),
  },
  aiCostLog: {
    aggregate: vi.fn(async () => ({ _sum: { totalCostUsd: db.cost } })),
  },
}));
vi.mock('@/lib/db/client', () => ({ prisma: mockPrisma }));

// ─── The provider ───────────────────────────────────────────────────────────

import type { BillingProvider } from '@/lib/billing/provider';

const fake = vi.hoisted((): { provider: unknown } => ({ provider: null }));
vi.mock('@/lib/billing/config', () => ({ billingProvider: async () => fake.provider }));

function makeProvider(): BillingProvider {
  return {
    key: 'stripe',
    createCheckout: vi.fn(),
    openPortal: vi.fn(),
    expireOpenCheckouts: vi.fn(),
    parseWebhook: vi.fn(),
    fetchSubscription: vi.fn(),
    listLiveSubscriptions: vi.fn(),
    findCustomerRefs: vi.fn(),
    // A round trip, so concurrent runs interleave at the send.
    reportUsage: vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }),
    cancelSubscription: vi.fn(),
  };
}

import {
  closeBillingPeriod,
  countUsage,
  reportBeforeCancelling,
  runUsageReports,
  USAGE_SEND_LEASE_MS,
  USAGE_SETTLE_MS,
} from '@/lib/billing/usage-report';

/** The in-memory client, as the close's transaction parameter is typed. */
const asDb = mockPrisma as unknown as Parameters<typeof closeBillingPeriod>[0];

const ORG = 'org_a';
const MINUTE = 60_000;
const NOW = new Date('2026-12-01T00:20:00Z');
const NOV = new Date('2026-11-01T00:00:00Z');
const DEC = new Date('2026-12-01T00:00:00Z');
const JAN = new Date('2027-01-01T00:00:00Z');
let provider: BillingProvider;

function record(overrides: Row = {}): void {
  db.records.push({
    orgId: ORG,
    planKey: 'pro',
    provider: 'stripe',
    customerRef: 'cus_a',
    subscriptionRef: 'sub_1',
    status: 'ACTIVE',
    periodStart: NOV,
    periodEnd: DEC,
    cancelAtPeriodEnd: false,
    ...overrides,
  });
}

/** The subscription a period closes under, as the webhook and the tick pass it. */
const subscriptionOf = (periodStart: Date) => ({
  orgId: ORG,
  provider: 'stripe',
  customerRef: 'cus_a',
  subscriptionRef: 'sub_1',
  planKey: 'pro',
  periodStart,
});

const reportFor = (meterKey = 'convos') => db.reports.find((r) => r.meterKey === meterKey);
const sends = () => vi.mocked(provider.reportUsage).mock.calls.map(([input]) => input);

beforeEach(() => {
  vi.clearAllMocks();
  db.records = [];
  db.reports = [];
  db.cost = 0;
  counts.clear();
  plans.enabled = true;
  plans.list = [METERED, UNMETERED];
  provider = makeProvider();
  fake.provider = provider;
});

describe('off unless it can bill', () => {
  it.each([
    ['no payment provider is on', () => (fake.provider = null)],
    ['plans do not apply (single, or none registered)', () => (plans.enabled = false)],
    ['no plan has a soft cap', () => (plans.list = [UNMETERED])],
  ])('reports nothing, and reads nothing, when %s', async (_name, arrange) => {
    record();
    counts.set(`${ORG}:convos`, 50);
    arrange();

    const run = await runUsageReports(NOW);

    expect(run).toEqual({ closed: 0, running: 0, counted: 0, sent: 0, late: 0, failed: 0 });
    expect(mockPrisma.orgBillingSubscription.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.billingUsageReport.findMany).not.toHaveBeenCalled();
    expect(db.reports).toEqual([]);
  });

  it('reports nothing for an org on a plan with no metered items', async () => {
    record({ planKey: 'free' });

    await runUsageReports(NOW);

    expect(db.reports).toEqual([]);
    expect(provider.reportUsage).not.toHaveBeenCalled();
  });
});

describe('a closed period', () => {
  it('is counted once it has settled, and its excess sent once, final, a second before its end', async () => {
    record();
    counts.set(`${ORG}:convos`, 25);

    const run = await runUsageReports(NOW);

    expect(run).toMatchObject({ closed: 1, counted: 1, sent: 1, failed: 0 });
    // Only the soft cap is billed: warn reports nothing.
    expect(db.reports).toHaveLength(1);
    expect(reportFor()).toMatchObject({
      status: 'SENT',
      used: 25,
      quantity: 15,
      providerMeter: 'convos_over',
      periodStart: NOV,
      periodEnd: DEC,
      sendingAt: null,
    });
    expect(sends()).toEqual([
      {
        customerRef: 'cus_a',
        subscriptionRef: 'sub_1',
        providerMeter: 'convos_over',
        quantity: 15,
        periodStart: NOV,
        periodEnd: DEC,
        final: true,
        at: new Date(DEC.getTime() - 1000),
        identifier: reportFor()?.id,
      },
    ]);
    expect(mockCountMeter).toHaveBeenCalledWith(ORG, 'convos', { from: NOV, to: DEC });
  });

  it('waits while the period is settling', async () => {
    record();
    counts.set(`${ORG}:convos`, 25);

    await runUsageReports(new Date(DEC.getTime() + USAGE_SETTLE_MS - 1));

    expect(db.reports).toEqual([]);
    expect(provider.reportUsage).not.toHaveBeenCalled();
  });

  it('within the allowance is recorded and sends nothing', async () => {
    record();
    counts.set(`${ORG}:convos`, 10);

    await runUsageReports(NOW);

    expect(reportFor()).toMatchObject({ status: 'NONE', used: 10, quantity: 0 });
    expect(provider.reportUsage).not.toHaveBeenCalled();
  });

  it('is counted and sent once however many runs overlap or follow', async () => {
    record();
    counts.set(`${ORG}:convos`, 25);

    await Promise.all([runUsageReports(NOW), runUsageReports(NOW), runUsageReports(NOW)]);
    counts.set(`${ORG}:convos`, 99);
    await runUsageReports(new Date(NOW.getTime() + MINUTE));

    expect(db.reports).toHaveLength(1);
    expect(provider.reportUsage).toHaveBeenCalledTimes(1);
    // Counted once: usage that changed afterwards changes nothing reported.
    expect(reportFor()).toMatchObject({ used: 25, quantity: 15 });
  });

  it('retries a send that failed, under the same identifier', async () => {
    record();
    counts.set(`${ORG}:convos`, 25);
    vi.mocked(provider.reportUsage).mockRejectedValueOnce(new Error('provider unreachable'));

    const first = await runUsageReports(NOW);
    expect(first).toMatchObject({ sent: 0, failed: 1 });
    expect(reportFor()).toMatchObject({ status: 'COUNTED', sendingAt: null });

    const second = await runUsageReports(new Date(NOW.getTime() + 5 * MINUTE));
    expect(second).toMatchObject({ sent: 1, failed: 0 });
    const [a, b] = sends();
    expect(a?.identifier).toBe(b?.identifier);
    expect(reportFor()?.status).toBe('SENT');
  });

  it('leaves a send another instance holds, and takes it over once the lease runs out', async () => {
    record();
    counts.set(`${ORG}:convos`, 25);
    await closeBillingPeriod(asDb, { ...db.records[0], periodStart: NOV } as never, {
      periodEnd: DEC,
      lastPeriod: false,
    });
    Object.assign(reportFor() ?? {}, {
      status: 'COUNTED',
      used: 25,
      quantity: 15,
      sendingAt: new Date(NOW.getTime() - MINUTE),
    });

    await runUsageReports(NOW);
    expect(provider.reportUsage).not.toHaveBeenCalled();

    await runUsageReports(new Date(NOW.getTime() + USAGE_SEND_LEASE_MS));
    expect(provider.reportUsage).toHaveBeenCalledTimes(1);
  });

  it('is not counted or sent by an install whose provider is now another', async () => {
    record({ provider: 'paddle' });
    counts.set(`${ORG}:convos`, 25);
    await closeBillingPeriod(asDb, db.records[0] as never, {
      periodEnd: DEC,
      lastPeriod: false,
    });

    await runUsageReports(NOW);

    expect(reportFor()?.status).toBe('PENDING');
    expect(provider.reportUsage).not.toHaveBeenCalled();
  });

  it('a counting failure is logged and retried, and the other orgs still report', async () => {
    record();
    record({ orgId: 'org_b', customerRef: 'cus_b', subscriptionRef: 'sub_b' });
    counts.set('org_b:convos', 12);
    mockCountMeter.mockRejectedValueOnce(new Error('count broke'));

    const run = await runUsageReports(NOW);

    expect(run).toMatchObject({ failed: 1, sent: 1 });
    expect(sends().map((s) => s.customerRef)).toEqual(['cus_b']);
    expect(reportFor()?.status).toBe('PENDING');
  });
});

describe('every row, every run', () => {
  /** Orgs named so they sort ahead of `org_z`, the one that must not wait. */
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) => `org_${String(i).padStart(3, '0')}`);

  it('closes a newly ended period behind more than a page of periods already closed', async () => {
    // Stale records: closed, the renewal never synced.
    for (const orgId of many(120)) {
      record({ orgId, customerRef: `cus_${orgId}`, subscriptionRef: `sub_${orgId}` });
      db.reports.push({
        id: `old_${orgId}`,
        orgId,
        meterKey: 'convos',
        periodStart: NOV,
        status: 'NONE',
      });
    }
    record({ orgId: 'org_z', customerRef: 'cus_z', subscriptionRef: 'sub_z' });
    counts.set('org_z:convos', 25);

    const run = await runUsageReports(NOW);

    expect(run).toMatchObject({ closed: 1, sent: 1 });
    expect(sends().map((x) => x.customerRef)).toEqual(['cus_z']);
  });

  it('sends a counted report behind more than a page that the provider keeps refusing', async () => {
    for (const orgId of many(120)) {
      db.reports.push({
        id: `a_${orgId}`,
        orgId,
        provider: 'stripe',
        customerRef: 'cus_refused',
        subscriptionRef: 'sub_x',
        providerMeter: 'convos_over',
        meterKey: 'convos',
        periodStart: NOV,
        periodEnd: DEC,
        status: 'COUNTED',
        quantity: 1,
        sendingAt: null,
      });
    }
    db.reports.push({
      id: 'z_report',
      orgId: 'org_z',
      provider: 'stripe',
      customerRef: 'cus_z',
      subscriptionRef: 'sub_z',
      providerMeter: 'convos_over',
      meterKey: 'convos',
      periodStart: NOV,
      periodEnd: DEC,
      status: 'COUNTED',
      quantity: 3,
      sendingAt: null,
    });
    vi.mocked(provider.reportUsage).mockImplementation(async (input) => {
      if (input.customerRef === 'cus_refused') throw new Error('timestamp too old');
    });

    const run = await runUsageReports(NOW);

    expect(run).toMatchObject({ sent: 1, failed: 120 });
    expect(db.reports.find((r) => r.id === 'z_report')?.status).toBe('SENT');
  });
});

describe('closeBillingPeriod', () => {
  const subscription = subscriptionOf(NOV);

  it('writes nothing for a plan that bills nothing, or a period with no length', async () => {
    expect(
      await closeBillingPeriod(
        asDb,
        { ...subscription, planKey: 'free' },
        {
          periodEnd: DEC,
          lastPeriod: false,
        }
      )
    ).toBe(0);
    expect(
      await closeBillingPeriod(asDb, subscription, { periodEnd: NOV, lastPeriod: false })
    ).toBe(0);
    expect(mockPrisma.billingUsageReport.createMany).not.toHaveBeenCalled();
  });

  it('takes a later, better-informed close until the period is counted, and never after', async () => {
    const ended = new Date('2026-11-20T00:00:00Z');
    await closeBillingPeriod(asDb, subscription, { periodEnd: DEC, lastPeriod: false });
    await closeBillingPeriod(asDb, subscription, { periodEnd: ended, lastPeriod: true });
    expect(db.reports).toHaveLength(1);
    expect(reportFor()).toMatchObject({ periodEnd: ended, lastPeriod: true, status: 'PENDING' });

    Object.assign(reportFor() ?? {}, { status: 'SENT' });
    await closeBillingPeriod(asDb, subscription, { periodEnd: DEC, lastPeriod: false });
    expect(reportFor()).toMatchObject({ periodEnd: ended, lastPeriod: true, status: 'SENT' });
  });

  it('bills a row opened under an earlier plan under the plan the period closed on', async () => {
    plans.list = [
      METERED,
      {
        key: 'max',
        meteredItems: {
          convos: { ...METERED.meteredItems.convos, allowance: 50, providerMeter: 'convos_max' },
        },
      },
    ];
    // Opened by a running total under `pro`; the org moved to `max` since.
    await closeBillingPeriod(asDb, subscription, { periodEnd: DEC, lastPeriod: false });
    Object.assign(reportFor() ?? {}, { status: 'OPEN' });

    await closeBillingPeriod(
      asDb,
      { ...subscription, planKey: 'max' },
      { periodEnd: DEC, lastPeriod: false }
    );

    expect(reportFor()).toMatchObject({
      status: 'PENDING',
      planKey: 'max',
      allowance: 50,
      providerMeter: 'convos_max',
    });
  });
});

describe('the last period', () => {
  it('sends running totals while the subscription cancels at its end, and marks the close late', async () => {
    record({ periodStart: DEC, periodEnd: JAN, cancelAtPeriodEnd: true });
    counts.set(`${ORG}:convos`, 12);

    await runUsageReports(NOW);
    await runUsageReports(new Date(NOW.getTime() + 5 * MINUTE));
    counts.set(`${ORG}:convos`, 20);
    const later = new Date(NOW.getTime() + 10 * MINUTE);
    await runUsageReports(later);

    const id = String(reportFor()?.id);
    expect(sends().map((s) => [s.final, s.quantity, s.identifier])).toEqual([
      [false, 2, `${id}:1`],
      // Unchanged in between: nothing sent.
      [false, 10, `${id}:2`],
    ]);
    expect(sends()[1]?.at).toEqual(later);
    expect(reportFor()).toMatchObject({ status: 'OPEN', runningSends: 2, runningQuantity: 10 });

    // The period ends; the provider has made its final invoice.
    counts.set(`${ORG}:convos`, 21);
    const run = await runUsageReports(new Date(JAN.getTime() + 10 * MINUTE));

    expect(run).toMatchObject({ closed: 1, counted: 1, late: 1, sent: 0 });
    expect(reportFor()).toMatchObject({ status: 'LATE', used: 21, quantity: 11 });
    expect(provider.reportUsage).toHaveBeenCalledTimes(2);
  });

  it('bills a period normally when the cancellation was withdrawn before it closed', async () => {
    record({ periodStart: DEC, periodEnd: JAN, cancelAtPeriodEnd: true });
    counts.set(`${ORG}:convos`, 12);
    await runUsageReports(NOW);
    Object.assign(db.records[0] ?? {}, { cancelAtPeriodEnd: false });

    await runUsageReports(new Date(JAN.getTime() + 10 * MINUTE));

    expect(reportFor()).toMatchObject({ status: 'SENT', lastPeriod: false, quantity: 2 });
    expect(sends().at(-1)).toMatchObject({ final: true, identifier: reportFor()?.id });
  });
});

describe('reportBeforeCancelling', () => {
  it('sends the open period’s excess so far, placed now, and leaves the period open', async () => {
    record({ periodStart: DEC, periodEnd: JAN });
    counts.set(`${ORG}:convos`, 30);

    expect(await reportBeforeCancelling(provider, ORG, NOW)).toBe(1);
    // Retried with nothing new: the provider already holds this total.
    expect(await reportBeforeCancelling(provider, ORG, NOW)).toBe(0);

    const id = String(reportFor()?.id);
    expect(sends()).toEqual([
      expect.objectContaining({ final: false, quantity: 20, at: NOW, identifier: `${id}:1` }),
    ]);
    expect(reportFor()).toMatchObject({ status: 'OPEN', periodEnd: JAN, runningQuantity: 20 });
  });

  it('leaves a period whose cancellation failed to close, be counted and be sent as any other', async () => {
    record({ periodStart: DEC, periodEnd: JAN });
    counts.set(`${ORG}:convos`, 30);
    await reportBeforeCancelling(provider, ORG, NOW);

    // The cancellation failed and the erasure was not retried: the
    // subscription goes on, and the rest of the period is used.
    counts.set(`${ORG}:convos`, 45);
    const run = await runUsageReports(new Date(JAN.getTime() + 10 * MINUTE));

    expect(run).toMatchObject({ closed: 1, counted: 1, sent: 1, late: 0 });
    expect(reportFor()).toMatchObject({ status: 'SENT', periodEnd: JAN, lastPeriod: false });
    expect(sends().at(-1)).toMatchObject({
      final: true,
      quantity: 35,
      at: new Date(JAN.getTime() - 1000),
      identifier: reportFor()?.id,
    });
  });

  it('counts and sends a closed period not yet sent, since erasure deletes its row', async () => {
    // The stored period ended 20 minutes ago; the tick closed it, and the
    // renewal has not been synced.
    record();
    await closeBillingPeriod(asDb, subscriptionOf(NOV), { periodEnd: DEC, lastPeriod: false });
    counts.set(`${ORG}:convos`, 14);

    expect(await reportBeforeCancelling(provider, ORG, NOW)).toBe(1);

    expect(sends()).toEqual([
      expect.objectContaining({
        final: true,
        quantity: 4,
        at: new Date(DEC.getTime() - 1000),
        identifier: reportFor()?.id,
      }),
    ]);
    expect(reportFor()).toMatchObject({ status: 'SENT', used: 14 });
  });

  it('sends nothing within the allowance, or with no live subscription at this provider', async () => {
    record({ periodStart: DEC, periodEnd: JAN });
    counts.set(`${ORG}:convos`, 3);
    expect(await reportBeforeCancelling(provider, ORG, NOW)).toBe(0);
    expect(reportFor()?.status).toBe('OPEN');

    db.records = [];
    db.reports = [];
    record({ status: 'ENDED' });
    expect(await reportBeforeCancelling(provider, ORG, NOW)).toBe(0);
    expect(db.reports).toEqual([]);
    expect(provider.reportUsage).not.toHaveBeenCalled();
  });

  it('throws when the send fails, and releases the row for a retry', async () => {
    record({ periodStart: DEC, periodEnd: JAN });
    counts.set(`${ORG}:convos`, 30);
    vi.mocked(provider.reportUsage).mockRejectedValueOnce(new Error('provider unreachable'));

    await expect(reportBeforeCancelling(provider, ORG, NOW)).rejects.toThrow(
      'provider unreachable'
    );
    expect(reportFor()).toMatchObject({ status: 'OPEN', sendingAt: null, runningSends: 0 });
  });

  it('throws rather than reporting done while another send holds the row', async () => {
    record({ periodStart: DEC, periodEnd: JAN });
    counts.set(`${ORG}:convos`, 30);
    await reportBeforeCancelling(provider, ORG, NOW);
    counts.set(`${ORG}:convos`, 40);
    Object.assign(reportFor() ?? {}, { sendingAt: new Date(NOW.getTime() - MINUTE) });

    await expect(reportBeforeCancelling(provider, ORG, NOW)).rejects.toThrow(
      'being sent elsewhere'
    );
    expect(provider.reportUsage).toHaveBeenCalledTimes(1);
  });
});

describe('countUsage', () => {
  it('counts a meter through the meter', async () => {
    counts.set(`${ORG}:convos`, 7);
    expect(await countUsage(ORG, 'convos', { from: NOV, to: DEC })).toBe(7);
  });

  it('counts AI spend in whole cents, rounded once, leaving out calls on the org’s own key', async () => {
    db.cost = 1.512;
    expect(await countUsage(ORG, 'ai_spend_cents', { from: NOV, to: DEC })).toBe(151);
    expect(mockPrisma.aiCostLog.aggregate).toHaveBeenCalledWith({
      where: { orgId: ORG, ownKey: false, createdAt: { gte: NOV, lt: DEC } },
      _sum: { totalCostUsd: true },
    });

    db.cost = null;
    expect(await countUsage(ORG, 'ai_spend_cents', { from: NOV, to: DEC })).toBe(0);
  });
});
