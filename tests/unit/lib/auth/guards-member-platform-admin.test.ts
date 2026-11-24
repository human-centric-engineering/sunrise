/**
 * Tests: a platform admin who is a member of a customer org acts there as
 * their org role (t-1032, #1177)
 *
 * Drives the real guards with the membership read mocked at Prisma, and pins
 * what a member platform admin IS inside a customer org at `multi`:
 *
 * - their org role and nothing more — to the default policy, to a fork policy
 *   written as `isPlatformAdmin(viewer)`, and to a handler that checks
 *   `isPlatformAdmin(session.user)`;
 * - refused on a platform-tier admin route, admitted on an org-tier one as an
 *   org ADMIN, refused on it as an org MEMBER;
 * - without owner standing as an org ADMIN, so they cannot make themselves
 *   OWNER through the members routes;
 * - never a support entry: no grant is read for a member;
 * - in the install org, and at `single`, a platform admin as before.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { DEFAULT_ORG_ROLE, ORG_ADMIN_ROLE, ORG_OWNER_ROLE } from '@/lib/tenancy/roles';

const mockEnv = vi.hoisted(() => ({ TENANCY_MODE: 'multi' }));
vi.mock('@/lib/env', () => ({ env: mockEnv }));

const mockFindUnique = vi.hoisted(() => vi.fn());
const mockFindFirst = vi.hoisted(() => vi.fn());
vi.mock('@/lib/db/client', () => ({
  prisma: {
    orgMembership: { findUnique: mockFindUnique },
    orgSupportGrant: { findFirst: mockFindFirst },
    org: { findMany: vi.fn() },
  },
}));

vi.mock('next/headers', () => ({ headers: vi.fn() }));
vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('@/lib/auth/api-keys', () => ({
  resolveApiKey: vi.fn().mockResolvedValue(null),
  hasScope: (scopes: string[], required: string) =>
    scopes.includes(required) || scopes.includes('admin'),
  listValidApiKeyScopes: vi.fn(() => ['chat', 'admin']),
}));
vi.mock('@/lib/logging', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { headers } from 'next/headers';
import { auth } from '@/lib/auth/config';
import { withAuth, withAdminAuth } from '@/lib/auth/guards';
import {
  DEFAULT_AUTHORIZATION_POLICY,
  registerAuthorizationPolicy,
  __resetAuthorizationPolicyForTests,
  type AuthorizationPrincipal,
} from '@/lib/auth/authorization';
import { isPlatformAdmin } from '@/lib/auth/roles';
import { getTenantContext, type TenantContext } from '@/lib/tenancy/context';
import { membershipActorOf } from '@/lib/tenancy/lifecycle';
import { hasOwnerStanding } from '@/lib/tenancy/membership';
import { TENANT_HEADER_NAME } from '@/lib/tenancy/resolver';

const CUSTOMER = 'cmorg00000000000customer1';
const NOT_ABOUT_OWNERSHIP = {
  ownership: { decidedBy: 'nothing', because: 'Fixture: about the guard, not the rows.' },
} as const;

function session(role: 'USER' | 'ADMIN', activeOrgId: string | null) {
  return {
    session: {
      id: 'session_1',
      userId: 'user_1',
      token: 'tok',
      expiresAt: new Date(Date.now() + 86_400_000),
      createdAt: new Date(),
      updatedAt: new Date(),
      activeOrgId,
    },
    user: {
      id: 'user_1',
      name: 'Vendor Staff',
      email: 'staff@vendor.example',
      emailVerified: true,
      image: null,
      role,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  };
}

function memberAs(orgRole: string) {
  mockFindUnique.mockResolvedValue({ role: orgRole, org: { status: 'ACTIVE' } });
}

const request = (method = 'GET') =>
  new NextRequest('http://localhost:3000/api/v1/test', { method });

interface Seen {
  context: TenantContext | null;
  principal: AuthorizationPrincipal;
  userRole: string | null | undefined;
  handlerSaysPlatformAdmin: boolean;
  ownerStanding: boolean;
}

function record(seen: Seen[]) {
  return (
    _req: NextRequest,
    s: { user: { role?: string | null }; principal: AuthorizationPrincipal }
  ) => {
    seen.push({
      context: getTenantContext(),
      principal: s.principal,
      userRole: s.user.role,
      handlerSaysPlatformAdmin: isPlatformAdmin(s.user),
      // What the members routes hand the lifecycle's owner-standing rule.
      ownerStanding: hasOwnerStanding(membershipActorOf(s)),
    });
    return Response.json({ success: true });
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEnv.TENANCY_MODE = 'multi';
  mockFindFirst.mockResolvedValue(null);
  vi.mocked(headers).mockResolvedValue(new Headers());
  vi.mocked(auth.api.getSession).mockResolvedValue(session('ADMIN', CUSTOMER));
});

afterEach(() => __resetAuthorizationPolicyForTests());

describe('a platform admin who is a member of a customer org, at multi', () => {
  it('runs in the org as a session member, presenting as their org role and not a platform admin', async () => {
    memberAs(ORG_ADMIN_ROLE);
    const seen: Seen[] = [];
    const res = await withAuth(record(seen), NOT_ABOUT_OWNERSHIP)(request());

    expect(res.status).toBe(200);
    expect(seen[0].context).toEqual({ orgId: CUSTOMER, source: 'session', role: ORG_ADMIN_ROLE });
    expect(seen[0].principal).toMatchObject({
      userId: 'user_1',
      role: 'USER',
      orgId: CUSTOMER,
      orgRole: ORG_ADMIN_ROLE,
    });
    expect(seen[0].userRole).toBe('USER');
    expect(seen[0].handlerSaysPlatformAdmin).toBe(false);
    // A member is never a support entry.
    expect(mockFindFirst).not.toHaveBeenCalled(); // test-review:accept no_arg_called — a member never falls through to the grant;
  });

  it('as an org ADMIN has no owner standing, so cannot make themselves OWNER', async () => {
    memberAs(ORG_ADMIN_ROLE);
    const seen: Seen[] = [];
    await withAuth(record(seen), NOT_ABOUT_OWNERSHIP)(request('PATCH'));

    expect(seen[0].ownerStanding).toBe(false);
  });

  it('as an org OWNER has owner standing, from the membership', async () => {
    memberAs(ORG_OWNER_ROLE);
    const seen: Seen[] = [];
    await withAuth(record(seen), NOT_ABOUT_OWNERSHIP)(request('PATCH'));

    expect(seen[0].ownerStanding).toBe(true);
    expect(seen[0].handlerSaysPlatformAdmin).toBe(false);
  });

  it('is refused on a platform-tier admin route, and the handler never runs', async () => {
    memberAs(ORG_OWNER_ROLE);
    const seen: Seen[] = [];
    const res = await withAdminAuth(record(seen), NOT_ABOUT_OWNERSHIP)(request());

    expect(res.status).toBe(403);
    expect(seen).toEqual([]);
  });

  it('is admitted on an org-tier admin route as an org ADMIN', async () => {
    memberAs(ORG_ADMIN_ROLE);
    const seen: Seen[] = [];
    const res = await withAdminAuth(record(seen), { ...NOT_ABOUT_OWNERSHIP, tier: 'org' })(
      request()
    );

    expect(res.status).toBe(200);
    expect(seen[0].principal).toMatchObject({ role: 'USER', orgRole: ORG_ADMIN_ROLE });
  });

  it('is refused on an org-tier admin route as an org MEMBER, as any member is', async () => {
    memberAs(DEFAULT_ORG_ROLE);
    const seen: Seen[] = [];
    const res = await withAdminAuth(record(seen), { ...NOT_ABOUT_OWNERSHIP, tier: 'org' })(
      request()
    );

    expect(res.status).toBe(403);
    expect(seen).toEqual([]);
  });

  it('a fork policy written as isPlatformAdmin(viewer) admits nothing, at either tier', async () => {
    registerAuthorizationPolicy({
      ...DEFAULT_AUTHORIZATION_POLICY,
      canAdminister: (viewer) => Promise.resolve(isPlatformAdmin(viewer)),
    });
    memberAs(ORG_OWNER_ROLE);
    const seen: Seen[] = [];

    const platform = await withAdminAuth(record(seen), NOT_ABOUT_OWNERSHIP)(request());
    const org = await withAdminAuth(record(seen), { ...NOT_ABOUT_OWNERSHIP, tier: 'org' })(
      request()
    );

    expect(platform.status).toBe(403);
    expect(org.status).toBe(403);
    expect(seen).toEqual([]);
  });

  it('entered through the resolver header is presented the same way', async () => {
    vi.mocked(headers).mockResolvedValue(new Headers({ [TENANT_HEADER_NAME]: CUSTOMER }));
    vi.mocked(auth.api.getSession).mockResolvedValue(session('ADMIN', INSTALL_ORG_ID));
    memberAs(ORG_ADMIN_ROLE);
    const seen: Seen[] = [];
    const res = await withAuth(record(seen), NOT_ABOUT_OWNERSHIP)(request());

    expect(res.status).toBe(200);
    expect(seen[0].context).toMatchObject({ orgId: CUSTOMER, source: 'resolver' });
    expect(seen[0].handlerSaysPlatformAdmin).toBe(false);
  });
});

describe('the same platform admin where the platform role is theirs (controls)', () => {
  it('in the install org at multi is a platform admin, with owner standing', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(session('ADMIN', INSTALL_ORG_ID));
    memberAs(ORG_ADMIN_ROLE);
    const seen: Seen[] = [];
    const res = await withAdminAuth(record(seen), NOT_ABOUT_OWNERSHIP)(request());

    expect(res.status).toBe(200);
    expect(seen[0].principal.role).toBe('ADMIN');
    expect(seen[0].handlerSaysPlatformAdmin).toBe(true);
    expect(seen[0].ownerStanding).toBe(true);
  });

  it('at single, in another org it is a member of, is a platform admin as before', async () => {
    mockEnv.TENANCY_MODE = 'single';
    memberAs(ORG_ADMIN_ROLE);
    const seen: Seen[] = [];
    const res = await withAdminAuth(record(seen), NOT_ABOUT_OWNERSHIP)(request());

    expect(res.status).toBe(200);
    expect(seen[0].principal).toMatchObject({ role: 'ADMIN', orgId: CUSTOMER });
    expect(seen[0].handlerSaysPlatformAdmin).toBe(true);
  });
});
