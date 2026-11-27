/**
 * Unit Tests: /api/v1/orgs/[id]/billing/checkout and /portal (§139 t-1094)
 *
 * Runs the REAL `withAuth`, the REAL default policy (asked about the
 * resource kind `org.billing`), the REAL entry rule and the REAL
 * `startCheckout()` / `openBillingPortal()`. Prisma is mocked at the
 * delegates; the provider is a fake behind a mocked `billingProvider()`, and
 * `null` from it is billing off.
 *
 * Pins who may: only the org's OWNER acting in it. An ADMIN, a MEMBER, a
 * platform admin, a caller acting in another org, a support session and an
 * API key are refused, and none of them reaches the provider.
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
  planOf: (key: string) =>
    key === 'pro' ? { key: 'pro', label: 'Pro', priceLookupKey: 'pro_monthly' } : undefined,
}));

const provider = vi.hoisted(() => ({
  key: 'stripe',
  createCheckout: vi.fn(),
  openPortal: vi.fn(),
  fetchSubscription: vi.fn(),
  cancelSubscription: vi.fn(),
}));
const billing = vi.hoisted(() => ({ on: true }));
vi.mock('@/lib/billing/config', () => ({
  billingProvider: async () => (billing.on ? provider : null),
}));

import { POST as CHECKOUT } from '@/app/api/v1/orgs/[id]/billing/checkout/route';
import { POST as PORTAL } from '@/app/api/v1/orgs/[id]/billing/portal/route';
import { __resetAuthorizationPolicyForTests } from '@/lib/auth/authorization';
import { createMockAuthSession } from '@/tests/helpers/auth';

const ORG = 'cmorg000000000000000other';
const ELSEWHERE = 'cmorg00000000000000elsewh';
const USER_ID = 'cmjbv4i3x00003wsloputgwul';

function session(role: 'USER' | 'ADMIN', activeOrgId: string | null) {
  const base = createMockAuthSession();
  return { session: { ...base.session, activeOrgId }, user: { ...base.user, role } };
}

/** An org member with this role, acting in `orgId`. */
function actingAs(orgRole: string, orgId = ORG): void {
  mockGetSession.mockResolvedValue(session('USER', orgId));
  mockDb.orgMembership.findUnique.mockResolvedValue({ role: orgRole, org: { status: 'ACTIVE' } });
}

const params = (id = ORG) => ({ params: Promise.resolve({ id }) });

function checkout(body: unknown = { planKey: 'pro' }, orgId = ORG, headers: HeadersInit = {}) {
  const request = new Request(`http://localhost/api/v1/orgs/${orgId}/billing/checkout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
  return CHECKOUT(request, params(orgId));
}

function portal(orgId = ORG) {
  const request = new Request(`http://localhost/api/v1/orgs/${orgId}/billing/portal`, {
    method: 'POST',
  }) as unknown as NextRequest;
  return PORTAL(request, params(orgId));
}

async function json(res: Response) {
  return JSON.parse(await res.text()) as {
    success: boolean;
    data?: { url: string };
    error?: { code: string; details?: { reason?: string } };
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetAuthorizationPolicyForTests();
  for (const key of Object.keys(envOverrides)) delete envOverrides[key];
  envOverrides.TENANCY_MODE = 'multi';
  envOverrides.BETTER_AUTH_URL = 'https://app.test';
  billing.on = true;

  mockDb.aiApiKey.findFirst.mockResolvedValue(null);
  mockDb.orgSupportGrant.findFirst.mockResolvedValue(null);
  mockDb.org.findUnique.mockImplementation(async (args: { where: { id: string } }) => ({
    id: args.where.id,
    status: 'ACTIVE',
    name: 'Acme',
  }));
  mockDb.orgBillingSubscription.findUnique.mockResolvedValue({
    provider: 'stripe',
    customerRef: 'cus_a',
    subscriptionRef: null,
  });
  mockDb.$executeRaw.mockResolvedValue(0);
  mockDb.$queryRaw.mockResolvedValue([{ id: ORG }]);
  mockDb.$transaction.mockImplementation(async (fn: (tx: MockDb) => unknown) => fn(mockDb));
  provider.createCheckout.mockResolvedValue({
    url: 'https://checkout.test/s',
    customerRef: 'cus_a',
  });
  provider.openPortal.mockResolvedValue({ url: 'https://portal.test/p' });
});

describe('the org’s OWNER', () => {
  it('starts a checkout for a plan, and it is audited', async () => {
    actingAs(ORG_OWNER_ROLE);

    const res = await checkout();

    expect(res.status).toBe(200);
    expect((await json(res)).data).toEqual({ url: 'https://checkout.test/s' });
    expect(provider.createCheckout).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: ORG, priceLookupKey: 'pro_monthly' })
    );
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER_ID,
        action: 'org.billing.checkout',
        entityId: ORG,
        metadata: { planKey: 'pro' },
      })
    );
  });

  it('opens the portal', async () => {
    actingAs(ORG_OWNER_ROLE);
    const res = await portal();
    expect(res.status).toBe(200);
    expect((await json(res)).data).toEqual({ url: 'https://portal.test/p' });
  });

  it('is told billing is off on both routes, and nothing reaches a provider', async () => {
    actingAs(ORG_OWNER_ROLE);
    billing.on = false;

    for (const res of [await checkout(), await portal()]) {
      expect(res.status).toBe(409);
      expect((await json(res)).error?.details?.reason).toBe('billing_off');
    }
    expect(provider.createCheckout).not.toHaveBeenCalled();
    expect(provider.openPortal).not.toHaveBeenCalled();
  });

  it('is refused a plan that does not exist, and a body that is not a plan key', async () => {
    actingAs(ORG_OWNER_ROLE);
    expect((await checkout({ planKey: 'gold' })).status).toBe(400);
    expect((await checkout({ planKey: 'Pro Plan!' })).status).toBe(400);
    expect((await checkout({ planKey: 'pro', extra: 1 })).status).toBe(400);
    expect(provider.createCheckout).not.toHaveBeenCalled();
  });

  it('is sent to the portal while the org already has a live subscription', async () => {
    actingAs(ORG_OWNER_ROLE);
    mockDb.orgBillingSubscription.findUnique.mockResolvedValue({
      provider: 'stripe',
      customerRef: 'cus_a',
      subscriptionRef: 'sub_1',
    });
    provider.fetchSubscription.mockResolvedValue({ ref: 'sub_1', status: 'active', live: true });

    const res = await checkout();

    expect(res.status).toBe(409);
    expect((await json(res)).error?.details?.reason).toBe('already_subscribed');
  });
});

describe('a provider failure', () => {
  it('is a 500 that, in production, tells the owner nothing of the provider’s error', async () => {
    // Outside production the guard's handler shows an unknown error's
    // message, as it does on every route; production hides it.
    envOverrides.NODE_ENV = 'production';
    actingAs(ORG_OWNER_ROLE);
    provider.createCheckout.mockRejectedValue(new Error('Stripe: api key sk_test_leak invalid'));
    provider.openPortal.mockRejectedValue(new Error('Stripe: api key sk_test_leak invalid'));

    for (const res of [await checkout(), await portal()]) {
      expect(res.status).toBe(500);
      expect(await res.text()).not.toContain('sk_test_leak');
    }
    expect(mockAudit).not.toHaveBeenCalled();
  });
});

describe('everyone else is refused, and reaches no provider', () => {
  it.each([
    ['an ADMIN of the org', ORG_ADMIN_ROLE, 403],
    ['a MEMBER of the org', DEFAULT_ORG_ROLE, 403],
  ])('%s', async (_name, role, status) => {
    actingAs(role);
    expect((await checkout()).status).toBe(status);
    expect((await portal()).status).toBe(status);
    expect(provider.createCheckout).not.toHaveBeenCalled();
    expect(provider.openPortal).not.toHaveBeenCalled();
  });

  it('an OWNER of another org, acting there', async () => {
    actingAs(ORG_OWNER_ROLE, ELSEWHERE);
    expect((await checkout()).status).toBe(403);
    expect((await portal()).status).toBe(403);
    expect(provider.createCheckout).not.toHaveBeenCalled();
  });

  it('a platform admin acting in their own org', async () => {
    mockGetSession.mockResolvedValue(session('ADMIN', INSTALL_ORG_ID));
    mockDb.orgMembership.findUnique.mockResolvedValue({
      role: ORG_OWNER_ROLE,
      org: { status: 'ACTIVE' },
    });
    expect((await checkout()).status).toBe(403);
    expect(provider.createCheckout).not.toHaveBeenCalled();
  });

  it('a platform admin in the org under a support grant', async () => {
    mockGetSession.mockResolvedValue(session('ADMIN', ORG));
    mockDb.orgMembership.findUnique.mockResolvedValue(null);
    mockDb.orgSupportGrant.findFirst.mockResolvedValue({
      id: 'cmgrant00000000000000one',
      level: 'ADMIN',
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    expect((await checkout()).status).toBe(403);
    expect(provider.createCheckout).not.toHaveBeenCalled();
  });

  it('the install org, even for its OWNER', async () => {
    actingAs(ORG_OWNER_ROLE, INSTALL_ORG_ID);
    expect((await checkout({ planKey: 'pro' }, INSTALL_ORG_ID)).status).toBe(409);
    expect(provider.createCheckout).not.toHaveBeenCalled();
  });

  it('an admin-scoped API key, which the policy admits and the route does not', async () => {
    mockGetSession.mockResolvedValue(null);
    mockDb.aiApiKey.findFirst.mockResolvedValue({
      id: 'cmkey000000000000000key1',
      userId: USER_ID,
      scopes: ['admin'],
      rateLimitRpm: null,
      expiresAt: null,
      createdAt: new Date(),
      orgId: null,
      user: {
        id: USER_ID,
        name: 'Key Owner',
        email: 'owner@example.com',
        emailVerified: true,
        image: null,
        role: 'ADMIN',
        accountType: 'HUMAN',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

    const res = await checkout({ planKey: 'pro' }, INSTALL_ORG_ID, {
      authorization: 'Bearer sk_deadbeefdeadbeefdeadbeefdeadbeef',
    });

    expect(res.status).toBe(403);
    expect(provider.createCheckout).not.toHaveBeenCalled();
  });

  it('no session at all', async () => {
    mockGetSession.mockResolvedValue(null);
    expect((await checkout()).status).toBe(401);
  });
});
