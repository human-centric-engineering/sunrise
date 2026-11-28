/**
 * Unit Tests: the warn rule's notices, and an org's allowances (§139 t-1097)
 *
 * The real `runUsageNotices()`, `loadPlanAllowances()`, `allowanceWindow()`
 * and `emailOwners()` over an in-memory notice table with the unique key the
 * schema declares, a fake count, a fake handler and a mocked `sendEmail`.
 *
 * Pins: a notice is claimed before it is sent and sent once per window and
 * threshold; reaching the allowance claims "near" quietly; a handler that
 * throws releases its claim, so a later run retries; with no handler the
 * owners are emailed, in their language, with an idempotency key; the window
 * is the billing period while a provider subscription gives the plan, else
 * the meter's own.
 *
 * Twice at once on a real database: `npm run smoke:billing-usage`.
 *
 * @see lib/billing/usage-notices.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/env', () => ({ env: { BETTER_AUTH_URL: 'https://app.test' } }));
vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
// The org a call runs as, so the handler's scope can be pinned.
const scope = vi.hoisted(() => ({ org: null as string | null }));
vi.mock('@/lib/tenancy/context', () => ({
  runAsOrg: async (orgId: string, fn: () => unknown) => {
    const outer = scope.org;
    scope.org = orgId;
    try {
      return await fn();
    } finally {
      scope.org = outer;
    }
  },
}));
type ProviderState =
  { on: true; providerKey: string } | { on: false; reason: string; providerKey: string | null };
const providerState = vi.hoisted((): { value: ProviderState } => ({
  value: { on: true, providerKey: 'stripe' },
}));
vi.mock('@/lib/billing/config', () => ({ billingProviderState: () => providerState.value }));

const counts = vi.hoisted(() => new Map<string, number>());
const mockCountUsage = vi.hoisted(() =>
  vi.fn(async (orgId: string, key: string) => counts.get(`${orgId}:${key}`) ?? 0)
);
vi.mock('@/lib/billing/usage-report', () => ({ countUsage: mockCountUsage }));

vi.mock('@/lib/tenancy/meters', () => ({
  meterOf: (key: string) =>
    ({
      leads: { key: 'leads', label: 'Leads', period: 'month' },
      seats: { key: 'seats', label: 'Seats', period: 'standing' },
    })[key],
  meterWindow: async () => ({
    from: new Date('2026-12-01T00:00:00Z'),
    to: new Date('2027-01-01T00:00:00Z'),
  }),
}));

const mockSendEmail = vi.hoisted(() =>
  vi.fn(async (_options: { to: string; subject: string; idempotencyKey?: string }) => ({
    success: true,
    status: 'sent',
  }))
);
vi.mock('@/lib/email/send', () => ({ sendEmail: mockSendEmail }));
vi.mock('@/lib/email/locale', () => ({
  emailLocaleForUser: async () => ({ locale: 'en', timeZone: 'UTC' }),
}));

// ─── Plans ──────────────────────────────────────────────────────────────────

const plans = vi.hoisted(() => ({
  enabled: true,
  handler: null as null | ((notice: unknown) => unknown),
  list: [] as unknown[],
}));
vi.mock('@/lib/billing/plans', () => ({
  billingPlansEnabled: () => plans.enabled,
  registeredPlans: () => plans.list,
  planOf: (key: string) => (plans.list as { key: string }[]).find((p) => p.key === key),
  appUsageNoticeHandler: () => plans.handler,
}));

const item = (meterKey: string, overage: string, allowance = 10) => ({
  meterKey,
  overage,
  allowance,
  providerMeter: overage === 'soft_cap' ? `${meterKey}_over` : null,
  warnAtPercent: overage === 'warn' ? 80 : null,
});
const PLAN = {
  key: 'pro',
  meteredItems: {
    leads: item('leads', 'warn'),
    ai_spend_cents: item('ai_spend_cents', 'soft_cap', 500),
  },
};

// ─── The database ───────────────────────────────────────────────────────────

const db = vi.hoisted(() => ({
  records: [] as Record<string, unknown>[],
  notices: [] as Record<string, unknown>[],
  owners: [] as { user: { id: string; email: string } }[],
}));

const noticeKey = (n: Record<string, unknown>) =>
  `${String(n.orgId)}|${String(n.meterKey)}|${(n.periodStart as Date).toISOString()}|${String(n.threshold)}`;

const mockPrisma = vi.hoisted(() => ({
  orgBillingSubscription: {
    findMany: vi.fn(async ({ where }: { where: { orgId?: { gt: string } } }) =>
      db.records.filter((r) => !where.orgId || String(r.orgId) > where.orgId.gt)
    ),
    findUnique: vi.fn(
      async ({ where }: { where: { orgId: string } }) =>
        db.records.find((r) => r.orgId === where.orgId) ?? null
    ),
  },
  billingUsageNotice: {
    createMany: vi.fn(async ({ data }: { data: Record<string, unknown>[] }) => {
      let count = 0;
      for (const row of data) {
        if (db.notices.some((n) => noticeKey(n) === noticeKey(row))) continue;
        db.notices.push({ ...row });
        count += 1;
      }
      return { count };
    }),
    deleteMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      const before = db.notices.length;
      db.notices = db.notices.filter((n) => noticeKey(n) !== noticeKey(where));
      return { count: before - db.notices.length };
    }),
  },
  org: { findUnique: vi.fn(async () => ({ name: 'Acme' })) },
  orgMembership: { findMany: vi.fn(async () => db.owners) },
}));
vi.mock('@/lib/db/client', () => ({ prisma: mockPrisma }));

import {
  allowanceWindow,
  emailOwners,
  loadPlanAllowances,
  runUsageNotices,
} from '@/lib/billing/usage-notices';
import { logger } from '@/lib/logging';

const ORG = 'org_a';
const NOW = new Date('2026-12-10T12:00:00Z');
const DEC = new Date('2026-12-01T00:00:00Z');
const JAN = new Date('2027-01-01T00:00:00Z');
const PERIOD_START = new Date('2026-11-25T00:00:00Z');
const PERIOD_END = new Date('2026-12-25T00:00:00Z');
const told: { threshold: string; used: number; meterKey: string }[] = [];

function onPlan(overrides: Record<string, unknown> = {}): void {
  db.records.push({
    orgId: ORG,
    planKey: 'pro',
    provider: 'stripe',
    customerRef: 'cus_a',
    subscriptionRef: 'sub_1',
    status: 'ACTIVE',
    periodStart: PERIOD_START,
    periodEnd: PERIOD_END,
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  db.records = [];
  db.notices = [];
  db.owners = [{ user: { id: 'u1', email: 'owner@example.test' } }];
  counts.clear();
  told.length = 0;
  plans.enabled = true;
  plans.list = [PLAN];
  plans.handler = (notice) => {
    told.push(notice as (typeof told)[number]);
  };
  providerState.value = { on: true, providerKey: 'stripe' };
});

describe('runUsageNotices', () => {
  it('does nothing, and reads nothing, when plans are off or no plan warns', async () => {
    onPlan();
    counts.set(`${ORG}:leads`, 9);

    plans.enabled = false;
    await runUsageNotices(NOW);
    plans.enabled = true;
    plans.list = [{ key: 'pro', meteredItems: { x: item('x', 'hard_cap') } }];
    await runUsageNotices(NOW);

    expect(mockPrisma.orgBillingSubscription.findMany).not.toHaveBeenCalled();
    expect(told).toEqual([]);
  });

  it('tells the org once when it passes the threshold, counted in its billing period', async () => {
    onPlan();
    counts.set(`${ORG}:leads`, 8);

    const first = await runUsageNotices(NOW);
    await runUsageNotices(NOW);

    expect(first).toEqual({ checked: 1, notified: 1, failed: 0 });
    expect(told).toEqual([
      expect.objectContaining({
        orgId: ORG,
        planKey: 'pro',
        meterKey: 'leads',
        label: 'Leads',
        threshold: 'near',
        used: 8,
        allowance: 10,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
      }),
    ]);
    expect(mockCountUsage).toHaveBeenCalledWith(ORG, 'leads', {
      from: PERIOD_START,
      to: PERIOD_END,
    });
  });

  it('tells it once more at the allowance, and not about "near" after that', async () => {
    onPlan();
    counts.set(`${ORG}:leads`, 12);

    await runUsageNotices(NOW);
    await runUsageNotices(NOW);

    // Straight past the threshold: "near" is claimed quietly, never sent.
    expect(told.map((n) => n.threshold)).toEqual(['reached']);
    expect(db.notices.map((n) => n.threshold).sort()).toEqual(['near', 'reached']);
  });

  it('within the threshold says nothing and claims nothing', async () => {
    onPlan();
    counts.set(`${ORG}:leads`, 7);

    await runUsageNotices(NOW);

    expect(told).toEqual([]);
    expect(db.notices).toEqual([]);
  });

  it('releases the claim when the handler throws, so a later run tells the org', async () => {
    onPlan();
    counts.set(`${ORG}:leads`, 9);
    plans.handler = () => {
      throw new Error('the app’s notifier is down');
    };

    expect(await runUsageNotices(NOW)).toEqual({ checked: 1, notified: 0, failed: 1 });
    expect(db.notices).toEqual([]);

    plans.handler = (notice) => {
      told.push(notice as (typeof told)[number]);
    };
    await runUsageNotices(NOW);
    expect(told).toHaveLength(1);
  });

  it('runs the app’s handler as the org, not with the job’s system scope', async () => {
    onPlan();
    counts.set(`${ORG}:leads`, 9);
    const scopes: (string | null)[] = [];
    plans.handler = () => {
      scopes.push(scope.org);
    };

    await runUsageNotices(NOW);

    expect(scopes).toEqual([ORG]);
  });

  it('keeps a notice it sent when marking "near" as passed fails, and sends it once', async () => {
    onPlan();
    counts.set(`${ORG}:leads`, 12);
    const insert = mockPrisma.billingUsageNotice.createMany.getMockImplementation();
    mockPrisma.billingUsageNotice.createMany.mockImplementation(async (args) => {
      if (args.data[0]?.threshold === 'near') throw new Error('connection dropped');
      return insert ? insert(args) : { count: 0 };
    });

    expect(await runUsageNotices(NOW)).toEqual({ checked: 1, notified: 1, failed: 0 });
    await runUsageNotices(NOW);
    if (insert) mockPrisma.billingUsageNotice.createMany.mockImplementation(insert);

    expect(told.map((n) => n.threshold)).toEqual(['reached']);
    expect(db.notices.map((n) => n.threshold)).toEqual(['reached']);
  });

  it('rethrows the handler’s error when releasing its claim fails too, and logs the release', async () => {
    onPlan();
    counts.set(`${ORG}:leads`, 9);
    plans.handler = () => {
      throw new Error('the app’s notifier is down');
    };
    mockPrisma.billingUsageNotice.deleteMany.mockRejectedValueOnce(new Error('connection dropped'));

    expect(await runUsageNotices(NOW)).toEqual({ checked: 1, notified: 0, failed: 1 });

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('could not release'),
      expect.objectContaining({ error: 'connection dropped' })
    );
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('could not check or send'),
      expect.objectContaining({ error: 'the app’s notifier is down' })
    );
  });

  it('with no handler of the app’s, emails the org’s owners', async () => {
    plans.handler = null;
    onPlan();
    counts.set(`${ORG}:leads`, 9);

    await runUsageNotices(NOW);

    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(mockSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'owner@example.test' })
    );
  });
});

describe('allowanceWindow', () => {
  const warn = (meterKey: string) => ({ meterKey, overage: 'warn' as const });
  const subscribed = {
    orgId: ORG,
    planKey: 'pro',
    provider: 'stripe',
    status: 'ACTIVE' as const,
    periodStart: PERIOD_START,
    periodEnd: PERIOD_END,
  };

  it('is the meter’s own window for a hard cap, where its limit is enforced', async () => {
    expect(
      await allowanceWindow(subscribed, { meterKey: 'leads', overage: 'hard_cap' }, NOW)
    ).toEqual({ from: DEC, to: JAN });
  });

  it('keeps a period just past its end until a sync moves it on, and not past a day', async () => {
    const justPast = new Date(PERIOD_END.getTime() + 5 * 60_000);
    expect(await allowanceWindow(subscribed, warn('leads'), justPast)).toEqual({
      from: PERIOD_START,
      to: PERIOD_END,
    });
    const dayPast = new Date(PERIOD_END.getTime() + 24 * 60 * 60_000);
    expect(await allowanceWindow(subscribed, warn('leads'), dayPast)).toEqual({
      from: DEC,
      to: JAN,
    });
  });

  it('is the billing period while a provider subscription gives the org its plan', async () => {
    const record = {
      orgId: ORG,
      planKey: 'pro',
      provider: 'stripe',
      status: 'PAST_DUE' as const,
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
    };
    expect(await allowanceWindow(record, warn('leads'), NOW)).toEqual({
      from: PERIOD_START,
      to: PERIOD_END,
    });
  });

  it('is the meter’s own window for a plan assigned by hand, or a period that has passed', async () => {
    const byHand = {
      orgId: ORG,
      planKey: 'pro',
      provider: null,
      status: 'ACTIVE' as const,
      periodStart: null,
      periodEnd: null,
    };
    expect(await allowanceWindow(byHand, warn('leads'), NOW)).toEqual({ from: DEC, to: JAN });
    const lapsed = {
      ...byHand,
      provider: 'stripe',
      status: 'ENDED' as const,
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
    };
    expect(await allowanceWindow(lapsed, warn('leads'), NOW)).toEqual({ from: DEC, to: JAN });
  });

  it('is the UTC month for a standing meter and for AI spend', async () => {
    const byHand = {
      orgId: ORG,
      planKey: 'pro',
      provider: null,
      status: 'ACTIVE' as const,
      periodStart: null,
      periodEnd: null,
    };
    expect(await allowanceWindow(byHand, warn('seats'), NOW)).toEqual({ from: DEC, to: JAN });
    expect(await allowanceWindow(byHand, warn('ai_spend_cents'), NOW)).toEqual({
      from: DEC,
      to: JAN,
    });
  });
});

describe('loadPlanAllowances', () => {
  it('shows each metered item of the org’s plan with its use and state', async () => {
    onPlan();
    counts.set(`${ORG}:leads`, 9);
    counts.set(`${ORG}:ai_spend_cents`, 650);

    expect(await loadPlanAllowances(ORG, NOW)).toEqual([
      {
        key: 'leads',
        label: 'Leads',
        overage: 'warn',
        allowance: 10,
        money: false,
        billed: true,
        used: 9,
        state: 'near',
        window: { from: PERIOD_START, to: PERIOD_END },
      },
      {
        key: 'ai_spend_cents',
        label: 'AI spend',
        overage: 'soft_cap',
        allowance: 500,
        money: true,
        billed: true,
        used: 650,
        state: 'reached',
        window: { from: PERIOD_START, to: PERIOD_END },
      },
    ]);
  });

  it('says use past a soft cap is not billed on a plan assigned by hand', async () => {
    onPlan({
      provider: null,
      customerRef: null,
      subscriptionRef: null,
      periodStart: null,
      periodEnd: null,
    });

    const items = await loadPlanAllowances(ORG, NOW);

    expect(items.map((item) => [item.key, item.billed])).toEqual([
      ['leads', false],
      ['ai_spend_cents', false],
    ]);
  });

  it('says it is not billed when the record’s provider is not the one switched on here', async () => {
    onPlan();
    providerState.value = { on: false, reason: 'unset', providerKey: null };
    expect((await loadPlanAllowances(ORG, NOW)).every((item) => !item.billed)).toBe(true);

    providerState.value = { on: true, providerKey: 'paddle' };
    expect((await loadPlanAllowances(ORG, NOW)).every((item) => !item.billed)).toBe(true);
  });

  it('says an item could not be counted rather than showing nothing used', async () => {
    onPlan();
    mockCountUsage.mockRejectedValueOnce(new Error('count broke'));

    const [leads] = await loadPlanAllowances(ORG, NOW);

    expect(leads).toMatchObject({ key: 'leads', used: null, state: null });
  });

  it('is empty with no plan, or a plan with no metered items', async () => {
    expect(await loadPlanAllowances(ORG, NOW)).toEqual([]);
    onPlan({ planKey: 'gone' });
    expect(await loadPlanAllowances(ORG, NOW)).toEqual([]);
  });
});

describe('emailOwners', () => {
  const notice = {
    orgId: ORG,
    planKey: 'pro',
    meterKey: 'leads',
    label: 'Leads',
    threshold: 'reached' as const,
    used: 10,
    allowance: 10,
    periodStart: PERIOD_START,
    periodEnd: PERIOD_END,
  };

  it('emails each owner once per notice, keyed so a retry is not delivered twice', async () => {
    db.owners = [
      { user: { id: 'u1', email: 'one@example.test' } },
      { user: { id: 'u2', email: 'two@example.test' } },
    ];

    await emailOwners(notice);

    expect(mockSendEmail.mock.calls.map(([options]) => options.to)).toEqual([
      'one@example.test',
      'two@example.test',
    ]);
    const [options] = mockSendEmail.mock.calls[0] ?? [];
    expect(options?.subject).toBe('Acme: Leads has reached its allowance');
    expect(options?.idempotencyKey).toBe(
      `usage-notice:${ORG}:leads:${PERIOD_START.toISOString()}:reached:u1`
    );
    expect(mockPrisma.orgMembership.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { orgId: ORG, role: 'OWNER' } })
    );
  });

  it('throws when a send fails, so the notice is retried', async () => {
    mockSendEmail.mockResolvedValueOnce({ success: false, status: 'failed' });
    await expect(emailOwners(notice)).rejects.toThrow(/could not be emailed to 1 owner/);
  });

  it('sends nothing, and does not throw, for an org with no owner', async () => {
    db.owners = [];
    await emailOwners(notice);
    expect(mockSendEmail).not.toHaveBeenCalled();
  });
});
