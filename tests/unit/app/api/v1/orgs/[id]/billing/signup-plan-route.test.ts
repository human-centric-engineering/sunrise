/**
 * Unit Tests: POST and DELETE /api/v1/orgs/[id]/billing/signup-plan (§139 t-1096)
 *
 * Runs the REAL `withAuth`, the REAL default policy (asked about the resource
 * kind `org.billing`) and the REAL owner-only narrowing. The take-up itself
 * is mocked at `lib/billing/signup-plan.ts`, whose own tests cover it; here,
 * who may ask, and what each outcome answers and audits.
 */
import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import type { NextRequest } from 'next/server';
import { DEFAULT_ORG_ROLE, ORG_ADMIN_ROLE, ORG_OWNER_ROLE } from '@/lib/tenancy/roles';

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
}
const mockDb = vi.hoisted((): MockDb => ({
  org: { findUnique: vi.fn() },
  orgMembership: { findUnique: vi.fn() },
  aiApiKey: { findFirst: vi.fn(), update: vi.fn() },
  orgSupportGrant: { findFirst: vi.fn() },
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

const billing = vi.hoisted(() => ({ on: true }));
vi.mock('@/lib/billing/config', () => ({
  billingEnabled: () => billing.on,
  BILLING_OFF_MESSAGE: 'Billing is not switched on for this install',
}));

const mockTakeUp = vi.hoisted(() => vi.fn());
const mockDismiss = vi.hoisted(() => vi.fn());
vi.mock('@/lib/billing/signup-plan', () => ({
  takeUpSignupPlan: mockTakeUp,
  dismissSignupPlan: mockDismiss,
}));

import { DELETE, POST } from '@/app/api/v1/orgs/[id]/billing/signup-plan/route';
import { BillingCheckoutError } from '@/lib/billing/checkout';
import { BillingPlanError } from '@/lib/billing/subscriptions';
import { __resetAuthorizationPolicyForTests } from '@/lib/auth/authorization';
import { createMockAuthSession } from '@/tests/helpers/auth';

const ORG = 'cmorg000000000000000other';
const ELSEWHERE = 'cmorg00000000000000elsewh';
const USER_ID = 'cmjbv4i3x00003wsloputgwul';

function actingAs(orgRole: string, orgId = ORG): void {
  const base = createMockAuthSession();
  mockGetSession.mockResolvedValue({
    session: { ...base.session, activeOrgId: orgId },
    user: { ...base.user, role: 'USER' },
  });
  mockDb.orgMembership.findUnique.mockResolvedValue({ role: orgRole, org: { status: 'ACTIVE' } });
}

function takeUp(orgId = ORG) {
  const request = new Request(`http://localhost/api/v1/orgs/${orgId}/billing/signup-plan`, {
    method: 'POST',
  }) as unknown as NextRequest;
  return POST(request, { params: Promise.resolve({ id: orgId }) });
}

function dismiss(orgId = ORG) {
  const request = new Request(`http://localhost/api/v1/orgs/${orgId}/billing/signup-plan`, {
    method: 'DELETE',
  }) as unknown as NextRequest;
  return DELETE(request, { params: Promise.resolve({ id: orgId }) });
}

async function json(res: Response) {
  return JSON.parse(await res.text()) as {
    success: boolean;
    data?: Record<string, unknown>;
    error?: { code: string; details?: { reason?: string } };
  };
}

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
  mockTakeUp.mockResolvedValue({ kind: 'none' });
});

describe('the org’s OWNER', () => {
  it('is answered the checkout for a paid plan, audited as a checkout from signup', async () => {
    actingAs(ORG_OWNER_ROLE);
    mockTakeUp.mockResolvedValue({ kind: 'checkout', planKey: 'pro', url: 'https://co.test/s' });

    const res = await takeUp();

    expect(res.status).toBe(200);
    expect((await json(res)).data).toEqual({
      outcome: 'checkout',
      planKey: 'pro',
      url: 'https://co.test/s',
    });
    expect(mockTakeUp).toHaveBeenCalledWith(ORG, { actorUserId: USER_ID });
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER_ID,
        action: 'org.billing.checkout',
        entityId: ORG,
        metadata: { plan: 'pro', source: 'signup' },
      })
    );
  });

  it('is told a free plan was applied, with no checkout audit (the take-up audits it)', async () => {
    actingAs(ORG_OWNER_ROLE);
    mockTakeUp.mockResolvedValue({ kind: 'applied', planKey: 'starter' });

    const res = await takeUp();

    expect((await json(res)).data).toEqual({ outcome: 'applied', planKey: 'starter' });
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('is answered none when nothing waits, and dropped for a plan no longer offered', async () => {
    actingAs(ORG_OWNER_ROLE);
    expect((await json(await takeUp())).data).toEqual({ outcome: 'none' });

    mockTakeUp.mockResolvedValue({ kind: 'dropped', planKey: 'legacy' });
    expect((await json(await takeUp())).data).toEqual({ outcome: 'dropped', planKey: 'legacy' });
  });

  it('is told billing is off, and nothing is taken up', async () => {
    actingAs(ORG_OWNER_ROLE);
    billing.on = false;

    const res = await takeUp();

    expect(res.status).toBe(409);
    expect((await json(res)).error?.details?.reason).toBe('billing_off');
    expect(mockTakeUp).not.toHaveBeenCalled();
  });

  it('is answered the checkout’s refusal in the checkout route’s words', async () => {
    actingAs(ORG_OWNER_ROLE);
    mockTakeUp.mockRejectedValue(new BillingCheckoutError('PRICE_MISSING', 'not set up'));

    const res = await takeUp();

    expect(res.status).toBe(409);
    expect((await json(res)).error?.details?.reason).toBe('price_missing');
  });
});

describe('a free plan that cannot be applied', () => {
  it('answers 409 with the reason when the plan cannot be assigned', async () => {
    actingAs(ORG_OWNER_ROLE);
    mockTakeUp.mockRejectedValue(new BillingPlanError('PROVIDER_MANAGED', 'paid elsewhere'));

    const res = await takeUp();

    expect(res.status).toBe(409);
    expect((await json(res)).error).toMatchObject({
      code: 'CONFLICT',
      details: { reason: 'provider_managed' },
    });
  });

  it('answers 404 when the org is gone', async () => {
    actingAs(ORG_OWNER_ROLE);
    mockTakeUp.mockRejectedValue(new BillingPlanError('ORG_NOT_FOUND', 'gone'));

    const res = await takeUp();

    expect(res.status).toBe(404);
    expect((await json(res)).error?.code).toBe('NOT_FOUND');
  });

  it('answers 500 for anything else, without saying what', async () => {
    actingAs(ORG_OWNER_ROLE);
    mockTakeUp.mockRejectedValue(new Error('connection reset'));

    const res = await takeUp();

    expect(res.status).toBe(500);
    expect(mockAudit).not.toHaveBeenCalled();
  });
});

describe('DELETE — the owner chooses not to take it up', () => {
  it('removes the waiting plan, audited as a dismissal', async () => {
    actingAs(ORG_OWNER_ROLE);
    mockDismiss.mockResolvedValue('pro');

    const res = await dismiss();

    expect(res.status).toBe(200);
    expect((await json(res)).data).toEqual({ removed: 'pro' });
    expect(mockDismiss).toHaveBeenCalledWith(ORG);
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER_ID,
        action: 'org.billing.signup_plan.dismiss',
        entityId: ORG,
        metadata: { plan: 'pro' },
      })
    );
  });

  it('answers removed: null, unaudited, when nothing was waiting', async () => {
    actingAs(ORG_OWNER_ROLE);
    mockDismiss.mockResolvedValue(null);

    expect((await json(await dismiss())).data).toEqual({ removed: null });
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('is told billing is off, and nothing is removed', async () => {
    actingAs(ORG_OWNER_ROLE);
    billing.on = false;

    const res = await dismiss();

    expect(res.status).toBe(409);
    expect(mockDismiss).not.toHaveBeenCalled();
  });

  it.each([
    ['an ADMIN', ORG_ADMIN_ROLE],
    ['a MEMBER', DEFAULT_ORG_ROLE],
  ])('refuses %s, and nothing is removed', async (_label, role) => {
    actingAs(role);

    expect((await dismiss()).status).toBe(403);
    expect(mockDismiss).not.toHaveBeenCalled();
  });
});

describe('everyone else', () => {
  it.each([
    ['an ADMIN', ORG_ADMIN_ROLE],
    ['a MEMBER', DEFAULT_ORG_ROLE],
  ])('%s is refused, and nothing is taken up', async (_label, role) => {
    actingAs(role);

    const res = await takeUp();

    expect(res.status).toBe(403);
    expect(mockTakeUp).not.toHaveBeenCalled();
  });

  it('an OWNER acting in another org is refused', async () => {
    actingAs(ORG_OWNER_ROLE, ELSEWHERE);
    mockDb.orgMembership.findUnique.mockImplementation(
      async (args: { where: { orgId_userId: { orgId: string } } }) =>
        args.where.orgId_userId.orgId === ELSEWHERE
          ? { role: ORG_OWNER_ROLE, org: { status: 'ACTIVE' } }
          : null
    );

    const res = await takeUp();

    expect(res.status).toBe(403);
    expect(mockTakeUp).not.toHaveBeenCalled();
  });
});
