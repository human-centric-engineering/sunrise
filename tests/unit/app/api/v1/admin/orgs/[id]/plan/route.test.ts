/**
 * Unit Tests: GET/PATCH /api/v1/admin/orgs/[id]/plan (§139 t-1093)
 *
 * Real `withAdminAuth` and the real plan and entitlement registries, with the
 * app's plans from a mocked `lib/app/billing.ts`. `assignPlan()` and
 * `loadOrgSubscription()` are mocked: what they write is pinned in
 * `tests/unit/lib/billing/subscriptions.test.ts`. Pins: platform-admin only;
 * at `multi`, written only from the install org, refused before the body is
 * read; each refusal's status and reason; and an audit row naming what was
 * replaced, written only when something changed.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { SHARED_SETTINGS_REFUSAL_CODE } from '@/lib/tenancy/shared-settings';

const mockEnv = vi.hoisted(() => ({ TENANCY_MODE: 'multi' }));
vi.mock('@/lib/env', () => ({ env: mockEnv }));

const mockGetSession = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: mockGetSession } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));

const mockResolveApiKey = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/api-keys', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/api-keys')>()),
  resolveApiKey: mockResolveApiKey,
}));

const mockPrisma = vi.hoisted(() => ({
  org: { findUnique: vi.fn() },
  orgMembership: { findUnique: vi.fn() },
}));
vi.mock('@/lib/db/client', () => ({ prisma: mockPrisma }));

const mockLogAdminAction = vi.hoisted(() => vi.fn());
vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({
  logAdminAction: mockLogAdminAction,
}));

const mockLog = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock('@/lib/api/context', () => ({ getRouteLogger: vi.fn(async () => mockLog) }));
vi.mock('@/lib/logging', () => ({ logger: mockLog }));

vi.mock('@/lib/app/entitlements', () => ({ initAppEntitlements: vi.fn() }));
vi.mock('@/lib/app/billing', () => ({ initAppBilling: vi.fn() }));

const mockAssignPlan = vi.hoisted(() => vi.fn());
const mockLoadOrgSubscription = vi.hoisted(() => vi.fn());
vi.mock('@/lib/billing/subscriptions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/billing/subscriptions')>()),
  assignPlan: mockAssignPlan,
  loadOrgSubscription: mockLoadOrgSubscription,
}));

import { GET, PATCH } from '@/app/api/v1/admin/orgs/[id]/plan/route';
import { initAppBilling } from '@/lib/app/billing';
import { initAppEntitlements } from '@/lib/app/entitlements';
import { __resetBillingPlansForTests, registerPlan, setFallbackPlan } from '@/lib/billing/plans';
import { BillingPlanError } from '@/lib/billing/subscriptions';
import {
  __resetEntitlementRegistryForTests,
  registerEntitlementSwitch,
} from '@/lib/tenancy/entitlements';
import { createMockAuthSession } from '@/tests/helpers/auth';
import { __resetAuthorizationPolicyForTests } from '@/lib/auth/authorization';
import { registerForkAdmittingOrgOwners } from '@/tests/helpers/fork-admits-org-owners';

const OTHER = 'cmorg000000000000000other';

function session(role: 'USER' | 'ADMIN', activeOrgId: string | null = INSTALL_ORG_ID) {
  const base = createMockAuthSession();
  return {
    ...base,
    session: { ...base.session, activeOrgId },
    user: { ...base.user, role },
  };
}

const URL_FOR = (id: string) => `http://localhost/api/v1/admin/orgs/${id}/plan`;
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const get = (id = OTHER) => GET(new Request(URL_FOR(id)) as unknown as NextRequest, ctx(id));
const patch = (body: unknown, id = OTHER) =>
  PATCH(
    new Request(URL_FOR(id), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }) as unknown as NextRequest,
    ctx(id)
  );

async function json(res: Response) {
  return JSON.parse(await res.text()) as {
    success: boolean;
    data?: Record<string, unknown>;
    error?: { code: string; message?: string; details?: Record<string, unknown> };
  };
}

const APPLIED = {
  changed: true,
  switches: { from: null, to: { on: ['reports'], off: [] } },
  meterLimits: null,
  aiBudgetUsd: { from: null, to: 100 },
};

beforeEach(() => {
  vi.clearAllMocks();
  __resetAuthorizationPolicyForTests();
  mockEnv.TENANCY_MODE = 'multi';
  __resetEntitlementRegistryForTests();
  __resetBillingPlansForTests();
  vi.mocked(initAppEntitlements).mockImplementation(() => {
    registerEntitlementSwitch({ key: 'reports', label: 'Reports', description: '' });
  });
  vi.mocked(initAppBilling).mockImplementation(() => {
    registerPlan({ key: 'free', label: 'Free', switches: { reports: false } });
    registerPlan({
      key: 'pro',
      label: 'Pro',
      description: 'Reports.',
      switches: { reports: true },
      aiBudgetUsd: 100,
      priceLookupKey: 'pro_monthly',
    });
    setFallbackPlan('free');
  });
  mockResolveApiKey.mockResolvedValue(null);
  mockGetSession.mockResolvedValue(session('ADMIN'));
  mockPrisma.org.findUnique.mockResolvedValue({ id: OTHER });
  mockPrisma.orgMembership.findUnique.mockResolvedValue({
    role: 'OWNER',
    org: { status: 'ACTIVE' },
  });
  mockLoadOrgSubscription.mockResolvedValue(null);
  mockAssignPlan.mockResolvedValue({
    previousPlanKey: null,
    planKey: 'pro',
    changed: true,
    applied: APPLIED,
    subscription: null,
  });
});

describe('GET /api/v1/admin/orgs/[id]/plan', () => {
  it('reports the plans, what each decides, the fallback and the org’s record', async () => {
    mockLoadOrgSubscription.mockResolvedValue({ planKey: 'free', planAppliedAt: null });

    const res = await get();
    const data = (await json(res)).data!;

    expect(res.status).toBe(200);
    expect(data).toMatchObject({
      orgId: OTHER,
      enabled: true,
      multiTenant: true,
      registrationFailed: false,
      mayChange: true,
      fallbackPlanKey: 'free',
      subscription: { planKey: 'free', planAppliedAt: null },
    });
    expect(data.plans).toEqual([
      {
        key: 'free',
        label: 'Free',
        description: '',
        priced: false,
        switches: { reports: false },
        meterLimits: {},
        aiBudgetUsd: null,
        decidesAiBudget: false,
      },
      {
        key: 'pro',
        label: 'Pro',
        description: 'Reports.',
        priced: true,
        switches: { reports: true },
        meterLimits: {},
        aiBudgetUsd: 100,
        decidesAiBudget: true,
      },
    ]);
    expect(mockLoadOrgSubscription).toHaveBeenCalledWith(OTHER);
  });

  it('says plans are off at single', async () => {
    mockEnv.TENANCY_MODE = 'single';
    mockGetSession.mockResolvedValue(session('ADMIN', null));

    const data = (await json(await get())).data!;

    expect(data).toMatchObject({ enabled: false, multiTenant: false });
  });

  it('says the registration failed, rather than looking like an install with no plan', async () => {
    vi.mocked(initAppBilling).mockImplementation(() => {
      throw new Error('boom');
    });

    const data = (await json(await get())).data!;

    expect(data).toMatchObject({ enabled: false, registrationFailed: true, plans: [] });
  });

  it('is a 404 for an org that does not exist', async () => {
    mockPrisma.org.findUnique.mockResolvedValue(null);

    expect((await get()).status).toBe(404);
  });

  it('refuses a user who is not a platform admin', async () => {
    mockGetSession.mockResolvedValue(session('USER', OTHER));

    expect((await get()).status).toBe(403);
  });

  it('lets a customer-org caller a fork admits read it, saying it cannot be changed from there', async () => {
    registerForkAdmittingOrgOwners();
    mockGetSession.mockResolvedValue(session('USER', OTHER));

    const res = await get();

    expect(res.status).toBe(200);
    expect((await json(res)).data).toEqual(expect.objectContaining({ mayChange: false }));
  });
});

describe('PATCH /api/v1/admin/orgs/[id]/plan', () => {
  it('assigns the plan and audits what it replaced', async () => {
    const res = await patch({ planKey: 'pro' });

    expect(res.status).toBe(200);
    expect(mockAssignPlan).toHaveBeenCalledWith(OTHER, 'pro');
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    expect(mockLogAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'org.plan.assign',
        entityType: 'org',
        entityId: OTHER,
        actingOrgId: OTHER,
        changes: {
          plan: { from: null, to: 'pro' },
          switches: APPLIED.switches,
          monthlyBudgetUsd: APPLIED.aiBudgetUsd,
        },
      })
    );
    expect((await json(res)).data).toMatchObject({ orgId: OTHER, mayChange: true });
  });

  it('takes the org off its plan with null', async () => {
    mockAssignPlan.mockResolvedValue({
      previousPlanKey: 'pro',
      planKey: null,
      changed: true,
      applied: null,
      subscription: null,
    });

    await patch({ planKey: null });

    expect(mockAssignPlan).toHaveBeenCalledWith(OTHER, null);
    expect(mockLogAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ changes: { plan: { from: 'pro', to: null } } })
    );
  });

  it('records nothing when the assignment changed nothing', async () => {
    mockAssignPlan.mockResolvedValue({
      previousPlanKey: 'pro',
      planKey: 'pro',
      changed: false,
      applied: { ...APPLIED, changed: false, switches: null, aiBudgetUsd: null },
      subscription: null,
    });

    const res = await patch({ planKey: 'pro' });

    expect(res.status).toBe(200);
    expect(mockLogAdminAction).not.toHaveBeenCalled();
  });

  it('refuses a customer-org caller before reading the body', async () => {
    registerForkAdmittingOrgOwners();
    mockGetSession.mockResolvedValue(session('USER', OTHER));

    const res = await patch('not json at all');
    const body = await json(res);

    expect(res.status).toBe(403);
    expect(body.error?.details).toEqual({ reason: SHARED_SETTINGS_REFUSAL_CODE });
    expect(mockAssignPlan).not.toHaveBeenCalled();
  });

  it.each([[{ planKey: 'Pro' }], [{ planKey: 'pro', extra: true }], [{}]])(
    'refuses a malformed body %j',
    async (body) => {
      expect((await patch(body)).status).toBe(400);
      expect(mockAssignPlan).not.toHaveBeenCalled();
    }
  );

  it.each<[string, number, string, Record<string, unknown> | undefined]>([
    ['UNKNOWN_PLAN', 400, 'VALIDATION_ERROR', undefined],
    ['BILLING_OFF', 409, 'CONFLICT', { reason: 'billing_off' }],
    ['PROVIDER_MANAGED', 409, 'CONFLICT', { reason: 'provider_managed' }],
  ])('answers %s with %i', async (code, status, errorCode, details) => {
    mockAssignPlan.mockRejectedValue(new BillingPlanError(code as never, `said ${code}`));

    const res = await patch({ planKey: 'pro' });
    const body = await json(res);

    expect(res.status).toBe(status);
    expect(body.error?.code).toBe(errorCode);
    expect(body.error?.message).toBe(`said ${code}`);
    if (details) expect(body.error?.details).toEqual(details);
    expect(mockLogAdminAction).not.toHaveBeenCalled();
  });

  it('is a 404 for an org that does not exist', async () => {
    mockAssignPlan.mockRejectedValue(new BillingPlanError('ORG_NOT_FOUND', 'gone'));

    expect((await patch({ planKey: 'pro' })).status).toBe(404);
  });

  it('answers a clash with a concurrent settings write with 409, saying to assign again', async () => {
    mockAssignPlan.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('clash', { code: 'P2034', clientVersion: 'test' })
    );

    const res = await patch({ planKey: 'pro' });

    expect(res.status).toBe(409);
    expect((await json(res)).error?.message).toMatch(/assign the plan again/);
  });

  it('lets any other failure through to the error handler', async () => {
    mockAssignPlan.mockRejectedValue(new Error('database down'));

    expect((await patch({ planKey: 'pro' })).status).toBe(500);
  });
});
