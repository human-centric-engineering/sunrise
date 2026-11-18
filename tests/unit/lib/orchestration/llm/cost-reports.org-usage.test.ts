/**
 * Unit tests for getOrgUsage() in cost-reports.ts (§110 t-790)
 *
 * The rollup a fork builds invoices from, so the period is load-bearing: a
 * row from outside the month must never reach a total. `aiCostLog.groupBy`
 * is an in-memory fake that applies the `where` the code passes it — the
 * `createdAt` window and the `orgId` filter — and groups by `orgId`, so
 * dropping the period filter from the query lets the out-of-month rows in and
 * fails these tests, rather than only failing a check on the arguments.
 *
 * Covers:
 * - each org's month total, its calls and tokens, against its cap
 * - detached (NULL-org) rows in their own bucket at multi
 * - nothing from the month before or the month after
 * - the read runs in the system scope at multi, as nothing else sees every org
 * - one install-org row at single, NULL-org rows included
 * - the org filter
 *
 * @see lib/orchestration/llm/cost-reports.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getTenantContext, runAsOrg } from '@/lib/tenancy/context';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';

const mockMode = vi.hoisted(() => ({ value: 'multi' }));
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: new Proxy(actual.env, {
      get: (target, key) =>
        key === 'TENANCY_MODE' ? mockMode.value : (Reflect.get(target, key) as unknown),
    }),
  };
});

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiCostLog: { groupBy: vi.fn() },
    org: { findMany: vi.fn() },
  },
}));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { prisma } = await import('@/lib/db/client');
const { getOrgUsage, utcMonthBounds } = await import('@/lib/orchestration/llm/cost-reports');

const ACME = 'cmorg00000000000000000acme';
const BETA = 'cmorg00000000000000000beta';

interface Row {
  orgId: string | null;
  createdAt: Date;
  totalCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  /** A call on the org's own key (§137 t-1046). */
  ownKey: boolean;
}

const row = (orgId: string | null, iso: string, cost: number, ownKey = false): Row => ({
  orgId,
  createdAt: new Date(iso),
  totalCostUsd: cost,
  inputTokens: 100,
  outputTokens: 10,
  ownKey,
});

/** October 2026, with a row on each side of each boundary. */
const ROWS: Row[] = [
  row(ACME, '2026-10-01T00:00:00.000Z', 2), // first instant of the month: in
  row(ACME, '2026-10-15T12:00:00.000Z', 3),
  row(BETA, '2026-10-31T23:59:59.999Z', 4), // last instant: in
  row(null, '2026-10-10T00:00:00.000Z', 5), // an erased org's detached spend
  row(ACME, '2026-09-30T23:59:59.999Z', 1000), // the month before: out
  row(BETA, '2026-11-01T00:00:00.000Z', 1000), // the month after: out
  row(null, '2026-09-15T00:00:00.000Z', 1000), // detached, but the month before: out
];

/** Rows a test adds to {@link ROWS} for itself. */
let extraRows: Row[] = [];

const ORGS = [
  { id: INSTALL_ORG_ID, name: 'Install', slug: 'install', status: 'ACTIVE', settings: null },
  {
    id: ACME,
    name: 'Acme',
    slug: 'acme',
    status: 'ACTIVE',
    settings: { quotas: { monthlyBudgetUsd: 10 }, branding: { logo: 'x' } },
  },
  {
    id: BETA,
    name: 'Beta',
    slug: 'beta',
    status: 'SUSPENDED',
    settings: { quotas: { monthlyBudgetUsd: 0 } },
  },
];

interface GroupByArgs {
  by: Array<'orgId' | 'ownKey'>;
  where: { createdAt?: { gte?: Date; lt?: Date }; orgId?: string };
}
interface FindManyArgs {
  where: { id?: string };
}

/** The tenant context each query ran in. */
let scopes: Array<ReturnType<typeof getTenantContext>>;

beforeEach(() => {
  vi.resetAllMocks();
  mockMode.value = 'multi';
  scopes = [];
  extraRows = [];

  vi.mocked(prisma.aiCostLog.groupBy).mockImplementation((async (args: GroupByArgs) => {
    scopes.push(getTenantContext());
    const { createdAt, orgId } = args.where;
    const kept = [...ROWS, ...extraRows].filter(
      (r) =>
        (createdAt?.gte === undefined || r.createdAt >= createdAt.gte) &&
        (createdAt?.lt === undefined || r.createdAt < createdAt.lt) &&
        (orgId === undefined || r.orgId === orgId)
    );
    // Grouped on exactly the columns asked for, as Postgres would.
    const groups = new Map<string, Row[]>();
    for (const r of kept) {
      const key = JSON.stringify(args.by.map((column) => r[column]));
      groups.set(key, [...(groups.get(key) ?? []), r]);
    }
    return [...groups.values()].map((rows) => ({
      ...Object.fromEntries(args.by.map((column) => [column, rows[0][column]])),
      _sum: {
        totalCostUsd: rows.reduce((s, r) => s + r.totalCostUsd, 0),
        inputTokens: rows.reduce((s, r) => s + r.inputTokens, 0),
        outputTokens: rows.reduce((s, r) => s + r.outputTokens, 0),
      },
      _count: { _all: rows.length },
    }));
  }) as never);

  vi.mocked(prisma.org.findMany).mockImplementation((async (args: FindManyArgs) => {
    scopes.push(getTenantContext());
    return ORGS.filter((o) => args.where.id === undefined || o.id === args.where.id);
  }) as never);
});

describe('utcMonthBounds', () => {
  it('spans the UTC calendar month, end exclusive, across a year boundary', () => {
    expect(utcMonthBounds('2026-12')).toEqual({
      start: new Date('2026-12-01T00:00:00.000Z'),
      end: new Date('2027-01-01T00:00:00.000Z'),
    });
  });
});

describe('getOrgUsage at multi', () => {
  it("returns each org's month total against its cap, and nothing from outside the month", async () => {
    const report = await getOrgUsage({ period: '2026-10' });

    expect(report.period).toBe('2026-10');
    expect(report.periodStart).toBe('2026-10-01T00:00:00.000Z');
    expect(report.periodEnd).toBe('2026-11-01T00:00:00.000Z');
    // Highest spend first; an org with no spend is still listed.
    expect(report.orgs.map((o) => o.orgId)).toEqual([ACME, BETA, INSTALL_ORG_ID]);

    const [acme, beta, install] = report.orgs;
    expect(acme).toEqual({
      orgId: ACME,
      name: 'Acme',
      slug: 'acme',
      status: 'ACTIVE',
      totalCostUsd: 5,
      ownKeyCostUsd: 0,
      inputTokens: 200,
      outputTokens: 20,
      count: 2,
      monthlyBudgetUsd: 10,
      utilisation: 0.5,
    });
    // A cap of 0 is "no paid calls": there is no share of it to compute.
    expect(beta).toMatchObject({ totalCostUsd: 4, count: 1, monthlyBudgetUsd: 0 });
    expect(beta.utilisation).toBeNull();
    expect(install).toMatchObject({
      totalCostUsd: 0,
      count: 0,
      monthlyBudgetUsd: null,
      utilisation: null,
    });

    expect(report.detached).toEqual({
      totalCostUsd: 5,
      ownKeyCostUsd: 0,
      inputTokens: 100,
      outputTokens: 10,
      count: 1,
    });
    // 2 + 3 + 4 + 5: none of the 1000s from September or November.
    expect(report.totals).toEqual({
      totalCostUsd: 14,
      ownKeyCostUsd: 0,
      inputTokens: 400,
      outputTokens: 40,
      count: 4,
    });
  });

  it('reads every org in the system scope, even when called from inside one org', async () => {
    const report = await runAsOrg(ACME, () => getOrgUsage({ period: '2026-10' }));

    expect(report.orgs).toHaveLength(3);
    expect(scopes).toHaveLength(2);
    for (const scope of scopes) expect(scope).toMatchObject({ orgId: null, source: 'system' });
  });

  it('narrows to one org, with no detached bucket', async () => {
    const report = await getOrgUsage({ period: '2026-10', orgId: ACME });

    expect(report.orgs.map((o) => o.orgId)).toEqual([ACME]);
    expect(report.orgs[0].totalCostUsd).toBe(5);
    expect(report.detached).toBeNull();
    expect(report.totals.totalCostUsd).toBe(5);
  });

  it("counts a row naming an org that no longer exists as detached, not as nobody's", async () => {
    vi.mocked(prisma.org.findMany).mockResolvedValueOnce(
      ORGS.filter((o) => o.id !== BETA) as never
    );

    const report = await getOrgUsage({ period: '2026-10' });

    expect(report.orgs.map((o) => o.orgId)).toEqual([ACME, INSTALL_ORG_ID]);
    expect(report.detached?.totalCostUsd).toBe(9); // Beta's 4 + the NULL-org 5
    expect(report.totals.totalCostUsd).toBe(14);
  });

  it("reports an org's own-key spend apart, and holds only the platform's spend to its cap (§137)", async () => {
    // Acme spent 5 on the platform's keys (half its cap of 10) and 6 on its
    // own key in a row that falls in the month, and 1000 on its own key in one
    // that does not.
    extraRows = [
      row(ACME, '2026-10-20T00:00:00.000Z', 6, true),
      row(ACME, '2026-11-02T00:00:00.000Z', 1000, true),
    ];

    const report = await getOrgUsage({ period: '2026-10' });

    const acme = report.orgs.find((o) => o.orgId === ACME);
    expect(acme).toMatchObject({
      totalCostUsd: 11,
      ownKeyCostUsd: 6,
      count: 3,
      inputTokens: 300,
      outputTokens: 30,
      // 5 / 10, not 11 / 10: the cap counts the platform's spend only.
      utilisation: 0.5,
    });
    expect(report.orgs.find((o) => o.orgId === BETA)?.ownKeyCostUsd).toBe(0);
    expect(report.totals).toMatchObject({ totalCostUsd: 20, ownKeyCostUsd: 6, count: 5 });
  });

  it('returns zeros for a month with no spend', async () => {
    const report = await getOrgUsage({ period: '2025-01' });

    expect(report.orgs.every((o) => o.totalCostUsd === 0 && o.count === 0)).toBe(true);
    expect(report.totals.totalCostUsd).toBe(0);
  });
});

describe('getOrgUsage at single', () => {
  beforeEach(() => {
    mockMode.value = 'single';
  });

  it('returns one install-org row totalling every row in the month, NULL-org ones included', async () => {
    const report = await getOrgUsage({ period: '2026-10' });

    expect(report.orgs).toHaveLength(1);
    expect(report.orgs[0]).toMatchObject({
      orgId: INSTALL_ORG_ID,
      totalCostUsd: 14,
      count: 4,
    });
    expect(report.detached).toBeNull();
    expect(report.totals.totalCostUsd).toBe(14);
    // No bypass to take at single: the reads run as they are.
    expect(scopes).toHaveLength(2);
    expect(scopes.some((scope) => scope?.source === 'system')).toBe(false);
  });

  it('returns no row for an org id that is not the install org', async () => {
    const report = await getOrgUsage({ period: '2026-10', orgId: ACME });

    expect(report.orgs).toEqual([]);
  });
});
