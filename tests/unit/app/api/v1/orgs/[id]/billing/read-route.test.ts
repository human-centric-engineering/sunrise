/**
 * Unit Tests: GET /api/v1/orgs/[id]/billing (§139 t-1095)
 *
 * Runs the REAL `withAuth`, the REAL default policy (asked about the
 * resource kind `org.billing`), the REAL `loadOrgBilling()` and the REAL
 * `assertMayChangeBilling()` behind `mayChange`. Prisma is mocked at the
 * delegates; the plans, the meters' counts and whether billing is on are
 * faked.
 *
 * Pins who reads it: the org's OWNER (who may act) and ADMIN (who may not),
 * acting in it; a MEMBER and an owner of another org are refused before
 * anything is read. Billing off answers `billing_off`, as the other billing
 * routes do.
 */
import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import type { NextRequest } from 'next/server';
import { DEFAULT_ORG_ROLE, ORG_ADMIN_ROLE, ORG_OWNER_ROLE } from '@/lib/tenancy/roles';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';

const envOverrides = vi.hoisted((): Record<string, string | undefined> => ({}));
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: new Proxy(actual.env, {
      get: (target, key) =>
        typeof key === 'string' && key in envOverrides
          ? envOverrides[key]
          : (Reflect.get(target, key) as unknown),
    }),
  };
});

const mockGetSession = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: mockGetSession } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));

interface MockDb {
  org: { findUnique: Mock };
  orgMembership: { findUnique: Mock };
  aiApiKey: { findFirst: Mock; update: Mock };
  orgSupportGrant: { findFirst: Mock };
  orgBillingSubscription: { findUnique: Mock; upsert: Mock };
  $executeRaw: Mock;
  $queryRaw: Mock;
  $transaction: Mock;
}
const mockDb = vi.hoisted((): MockDb => ({
  org: { findUnique: vi.fn() },
  orgMembership: { findUnique: vi.fn() },
  aiApiKey: { findFirst: vi.fn(), update: vi.fn() },
  orgSupportGrant: { findFirst: vi.fn() },
  orgBillingSubscription: { findUnique: vi.fn(), upsert: vi.fn() },
  $executeRaw: vi.fn(),
  $queryRaw: vi.fn(),
  $transaction: vi.fn(),
}));
vi.mock('@/lib/db/client', () => ({ prisma: mockDb }));

const mockAudit = vi.hoisted(() => vi.fn());
vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({ logAdminAction: mockAudit }));

const mockLog = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock('@/lib/api/context', () => ({ getRouteLogger: vi.fn(async () => mockLog) }));
vi.mock('@/lib/logging', () => ({ logger: mockLog }));

vi.mock('@/lib/billing/plans', () => ({
  registeredPlans: () => [
    { key: 'free', label: 'Free', description: '', priceLookupKey: null },
    { key: 'pro', label: 'Pro', description: 'More of everything', priceLookupKey: 'pro_monthly' },
    { key: 'team', label: 'Team', description: '', priceLookupKey: 'team_monthly' },
  ],
  planOf: (key: string) =>
    ({
      free: { key: 'free', label: 'Free', description: '', priceLookupKey: null },
      pro: {
        key: 'pro',
        label: 'Pro',
        description: 'More of everything',
        priceLookupKey: 'pro_monthly',
      },
    })[key],
}));

const billing = vi.hoisted(() => ({ on: true }));
vi.mock('@/lib/billing/config', () => ({
  BILLING_OFF_MESSAGE: 'Billing is not switched on for this install',
  billingEnabled: () => billing.on,
  billingProviderState: () =>
    billing.on
      ? { on: true, providerKey: 'stripe' }
      : { on: false, reason: 'unset', providerKey: null },
}));

const meters = vi.hoisted(() => ({ usage: vi.fn() }));
vi.mock('@/lib/tenancy/meters', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tenancy/meters')>()),
  loadOrgMeterUsage: meters.usage,
}));

import { GET } from '@/app/api/v1/orgs/[id]/billing/route';
import { __resetAuthorizationPolicyForTests } from '@/lib/auth/authorization';
import { createMockAuthSession } from '@/tests/helpers/auth';

const ORG = 'cmorg000000000000000other';
const ELSEWHERE = 'cmorg00000000000000elsewh';

function session(role: 'USER' | 'ADMIN', activeOrgId: string | null) {
  const base = createMockAuthSession();
  return { session: { ...base.session, activeOrgId }, user: { ...base.user, role } };
}

/** An org member with this role, acting in `orgId`. */
function actingAs(orgRole: string, orgId = ORG): void {
  mockGetSession.mockResolvedValue(session('USER', orgId));
  mockDb.orgMembership.findUnique.mockResolvedValue({ role: orgRole, org: { status: 'ACTIVE' } });
}

function read(orgId = ORG) {
  const request = new Request(
    `http://localhost/api/v1/orgs/${orgId}/billing`
  ) as unknown as NextRequest;
  return GET(request, { params: Promise.resolve({ id: orgId }) });
}

interface Answer {
  success: boolean;
  data?: {
    orgId: string;
    plan: { key: string; label: string | null; description: string } | null;
    subscription: {
      status: string;
      providerManaged: boolean;
      elsewhere: boolean;
      assignedByHand: boolean;
      cancelAtPeriodEnd: boolean;
      periodStart: string | null;
      periodEnd: string | null;
    } | null;
    usage: Array<{ key: string; used: number | null; limit: number | null }> | null;
    plans: Array<{ key: string; current: boolean }>;
    mayChange: boolean;
    portalAvailable: boolean;
    customerElsewhere: boolean;
    installOrg: boolean;
  };
  error?: { code: string; details?: { reason?: string } };
}
async function json(res: Response): Promise<Answer> {
  return JSON.parse(await res.text()) as Answer;
}

const PAID = {
  planKey: 'pro',
  provider: 'stripe',
  customerRef: 'cus_a',
  subscriptionRef: 'sub_1',
  status: 'ACTIVE',
  providerStatus: 'active',
  providerLive: true,
  cancelAtPeriodEnd: false,
  periodStart: new Date('2026-11-01T00:00:00Z'),
  periodEnd: new Date('2026-12-01T00:00:00Z'),
  planAppliedAt: new Date('2026-11-01T00:00:01Z'),
  updatedAt: new Date('2026-11-01T00:00:01Z'),
};

beforeEach(() => {
  vi.clearAllMocks();
  __resetAuthorizationPolicyForTests();
  for (const key of Object.keys(envOverrides)) delete envOverrides[key];
  envOverrides.TENANCY_MODE = 'multi';
  billing.on = true;

  mockDb.aiApiKey.findFirst.mockResolvedValue(null);
  mockDb.orgSupportGrant.findFirst.mockResolvedValue(null);
  mockDb.org.findUnique.mockImplementation(async (args: { where: { id: string } }) => ({
    id: args.where.id,
    status: 'ACTIVE',
    name: 'Acme',
  }));
  mockDb.orgBillingSubscription.findUnique.mockResolvedValue(PAID);
  mockDb.$executeRaw.mockResolvedValue(0);
  mockDb.$queryRaw.mockResolvedValue([]);
  mockDb.$transaction.mockImplementation(async (fn: (tx: MockDb) => unknown) => fn(mockDb));
  meters.usage.mockResolvedValue({
    meters: [
      {
        key: 'seats',
        label: 'Seats',
        description: 'People in the org',
        period: 'standing',
        core: true,
        limit: 10,
        used: 3,
        window: null,
        countFailed: false,
      },
    ],
    unregistered: {},
  });
});

describe('the org’s OWNER, acting in it', () => {
  it('reads the plan, the period, usage and the plans, and may act on them', async () => {
    actingAs(ORG_OWNER_ROLE);

    const res = await read();

    expect(res.status).toBe(200);
    const { data } = await json(res);
    expect(data).toMatchObject({
      orgId: ORG,
      plan: { key: 'pro', label: 'Pro', description: 'More of everything' },
      subscription: {
        status: 'ACTIVE',
        providerManaged: true,
        elsewhere: false,
        assignedByHand: false,
        cancelAtPeriodEnd: false,
        periodStart: '2026-11-01T00:00:00.000Z',
        periodEnd: '2026-12-01T00:00:00.000Z',
      },
      usage: [{ key: 'seats', used: 3, limit: 10 }],
      mayChange: true,
      portalAvailable: true,
      customerElsewhere: false,
      installOrg: false,
    });
    // Only plans with a price can be bought; the one the org is on is marked.
    expect(data?.plans).toEqual([
      { key: 'pro', label: 'Pro', description: 'More of everything', current: true },
      { key: 'team', label: 'Team', description: '', current: false },
    ]);
    expect(meters.usage).toHaveBeenCalledWith(ORG);
  });

  it('is told billing is off, and nothing is read', async () => {
    actingAs(ORG_OWNER_ROLE);
    billing.on = false;

    const res = await read();

    expect(res.status).toBe(409);
    expect((await json(res)).error?.details?.reason).toBe('billing_off');
    expect(mockDb.orgBillingSubscription.findUnique).not.toHaveBeenCalled();
    expect(meters.usage).not.toHaveBeenCalled();
  });

  const HAND_SET = {
    ...PAID,
    provider: null,
    customerRef: null,
    subscriptionRef: null,
    providerStatus: null,
    providerLive: false,
    periodStart: null,
    periodEnd: null,
  };

  it('sees a priced plan staff set by hand as such, with no portal to open', async () => {
    actingAs(ORG_OWNER_ROLE);
    mockDb.orgBillingSubscription.findUnique.mockResolvedValue({ ...HAND_SET, planKey: 'team' });

    const { data } = await json(await read());

    expect(data?.subscription).toMatchObject({ assignedByHand: true, providerManaged: false });
    expect(data?.portalAvailable).toBe(false);
  });

  it('does not say staff set a free plan, which the founder may have chosen at signup (t-1096)', async () => {
    actingAs(ORG_OWNER_ROLE);
    mockDb.orgBillingSubscription.findUnique.mockResolvedValue({ ...HAND_SET, planKey: 'free' });

    const { data } = await json(await read());

    expect(data?.subscription).toMatchObject({ assignedByHand: false, providerManaged: false });
    expect(data?.portalAvailable).toBe(false);
    expect(data?.plans.every((plan) => !plan.current)).toBe(true);
  });

  it('has no portal while the customer is at another provider, and says the subscription is there', async () => {
    actingAs(ORG_OWNER_ROLE);
    mockDb.orgBillingSubscription.findUnique.mockResolvedValue({ ...PAID, provider: 'paddle' });

    const { data } = await json(await read());

    expect(data?.portalAvailable).toBe(false);
    expect(data?.subscription).toMatchObject({ providerManaged: true, elsewhere: true });
  });

  it('shows no subscription for a customer linked by a checkout that was never paid', async () => {
    actingAs(ORG_OWNER_ROLE);
    // `startCheckout()` links the customer before payment; the status is the schema default.
    mockDb.orgBillingSubscription.findUnique.mockResolvedValue({
      ...PAID,
      planKey: null,
      subscriptionRef: null,
      providerStatus: null,
      providerLive: false,
      periodStart: null,
      periodEnd: null,
    });

    const { data } = await json(await read());

    // The customer alone gives the portal nothing to show.
    expect(data).toMatchObject({ plan: null, subscription: null, portalAvailable: false });
  });

  it('does not call the plan a lapsed subscription fell back to one staff set', async () => {
    actingAs(ORG_OWNER_ROLE);
    // The webhook wrote the fallback plan as the subscription ended; a later
    // checkout's customer link then cleared the provider's word for it.
    mockDb.orgBillingSubscription.findUnique.mockResolvedValue({
      ...PAID,
      planKey: 'free',
      subscriptionRef: null,
      status: 'ENDED',
      providerStatus: null,
      providerLive: false,
    });

    const { data } = await json(await read());

    expect(data?.subscription).toMatchObject({ status: 'ENDED', assignedByHand: false });
  });

  it('with no record: no plan, no subscription', async () => {
    actingAs(ORG_OWNER_ROLE);
    mockDb.orgBillingSubscription.findUnique.mockResolvedValue(null);

    const { data } = await json(await read());

    expect(data).toMatchObject({ plan: null, subscription: null, portalAvailable: false });
  });

  it('names a plan the app no longer registers by its key, with no label', async () => {
    actingAs(ORG_OWNER_ROLE);
    mockDb.orgBillingSubscription.findUnique.mockResolvedValue({ ...PAID, planKey: 'legacy' });

    expect((await json(await read())).data?.plan).toEqual({
      key: 'legacy',
      label: null,
      description: '',
    });
  });

  it('says usage could not be counted rather than none', async () => {
    actingAs(ORG_OWNER_ROLE);
    meters.usage.mockResolvedValue(null);

    expect((await json(await read())).data?.usage).toBeNull();
  });

  it('still reads the plan and the portal when usage cannot be read, and logs it', async () => {
    actingAs(ORG_OWNER_ROLE);
    meters.usage.mockRejectedValue(new Error('connection reset'));

    const res = await read();

    expect(res.status).toBe(200);
    const { data } = await json(res);
    expect(data).toMatchObject({ usage: null, plan: { key: 'pro' }, portalAvailable: true });
    expect(mockLog.error).toHaveBeenCalledWith(
      expect.stringContaining("could not read the org's usage"),
      expect.objectContaining({ orgId: ORG, error: 'connection reset' })
    );
  });

  it('says the customer is at another provider once that subscription has ended', async () => {
    actingAs(ORG_OWNER_ROLE);
    mockDb.orgBillingSubscription.findUnique.mockResolvedValue({
      ...PAID,
      provider: 'paddle',
      status: 'ENDED',
      providerStatus: 'canceled',
      providerLive: false,
    });

    const { data } = await json(await read());

    expect(data).toMatchObject({ portalAvailable: false, customerElsewhere: true });
    expect(data?.subscription).toMatchObject({ providerManaged: false, elsewhere: false });
  });
});

describe('an ADMIN of the org', () => {
  it('reads the same billing, and may not act on it', async () => {
    actingAs(ORG_ADMIN_ROLE);

    const res = await read();

    expect(res.status).toBe(200);
    const { data } = await json(res);
    expect(data?.plan?.key).toBe('pro');
    expect(data?.mayChange).toBe(false);
  });
});

describe('everyone else is refused', () => {
  it('a MEMBER of the org', async () => {
    actingAs(DEFAULT_ORG_ROLE);
    expect((await read()).status).toBe(403);
    expect(mockDb.orgBillingSubscription.findUnique).not.toHaveBeenCalled();
  });

  it('an OWNER of another org, acting there', async () => {
    actingAs(ORG_OWNER_ROLE, ELSEWHERE);
    expect((await read()).status).toBe(403);
    expect(mockDb.orgBillingSubscription.findUnique).not.toHaveBeenCalled();
  });
});

describe('a platform admin', () => {
  it('in the install org reads its billing, marked as never billed, and may not act', async () => {
    mockGetSession.mockResolvedValue(session('ADMIN', INSTALL_ORG_ID));
    mockDb.orgMembership.findUnique.mockResolvedValue({
      role: ORG_OWNER_ROLE,
      org: { status: 'ACTIVE' },
    });
    mockDb.orgBillingSubscription.findUnique.mockResolvedValue(null);

    const res = await read(INSTALL_ORG_ID);

    expect(res.status).toBe(200);
    expect((await json(res)).data).toMatchObject({ installOrg: true, mayChange: false });
  });
});

it('refuses an org that does not exist at the guard, and reads nothing', async () => {
  mockGetSession.mockResolvedValue(session('ADMIN', INSTALL_ORG_ID));
  mockDb.orgMembership.findUnique.mockResolvedValue({
    role: ORG_OWNER_ROLE,
    org: { status: 'ACTIVE' },
  });
  mockDb.org.findUnique.mockImplementation(async (args: { where: { id: string } }) =>
    args.where.id === INSTALL_ORG_ID
      ? { id: INSTALL_ORG_ID, status: 'ACTIVE', name: 'Default' }
      : null
  );

  expect((await read()).status).toBe(403);
  expect(mockDb.orgBillingSubscription.findUnique).not.toHaveBeenCalled();
});

it('answers 404 when the org is gone by the time its billing is read', async () => {
  // The guard found it; it was erased before the handler read it.
  actingAs(ORG_OWNER_ROLE);
  let reads = 0;
  mockDb.org.findUnique.mockImplementation(async (args: { where: { id: string } }) =>
    args.where.id === ORG && ++reads > 1
      ? null
      : { id: args.where.id, status: 'ACTIVE', name: 'Acme' }
  );

  const res = await read();

  expect(res.status).toBe(404);
  expect(mockDb.orgBillingSubscription.findUnique).not.toHaveBeenCalled();
});
