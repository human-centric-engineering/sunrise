/**
 * Tests: the guards admit a support session, and what it is once admitted
 * (§121 t-824)
 *
 * `lib/tenancy/entry.test.ts` covers when a grant admits; this file drives the
 * real guards with the membership and grant reads mocked at Prisma, and pins
 * what the support actor IS inside the org:
 *
 * - an org ADMIN who is not a platform admin — to the default policy, to a
 *   fork policy written as `isPlatformAdmin(viewer)`, and to a handler that
 *   checks `isPlatformAdmin(session.user)`;
 * - refused on a platform-tier admin route, admitted on an org-tier one;
 * - a READ_ONLY grant refuses a write before the handler runs, and admits a read;
 * - expiry between two requests on the same cookie refuses the second;
 * - at `single` nothing changes.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { ORG_ADMIN_ROLE, ORG_OWNER_ROLE } from '@/lib/tenancy/roles';

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

import { logger } from '@/lib/logging';
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

const CUSTOMER = 'cmorg00000000000customer1';
const GRANT_ID = 'cmgrant000000000000grant1';
const EXPIRES = new Date(Date.now() + 3_600_000);
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
      name: 'Support Person',
      email: 'support@vendor.example',
      emailVerified: true,
      image: null,
      role,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  };
}

function grantOpen(level: 'ADMIN' | 'READ_ONLY' = 'ADMIN') {
  mockFindFirst.mockResolvedValue({ id: GRANT_ID, level, expiresAt: EXPIRES });
}

const request = (method = 'GET') =>
  new NextRequest('http://localhost:3000/api/v1/test', { method });
const ok = () => Response.json({ success: true });

interface Seen {
  context: TenantContext | null;
  principal: AuthorizationPrincipal;
  userRole: string | null | undefined;
  handlerSaysPlatformAdmin: boolean;
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
    });
    return ok();
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEnv.TENANCY_MODE = 'multi';
  mockFindUnique.mockResolvedValue(null);
  mockFindFirst.mockResolvedValue(null);
  vi.mocked(headers).mockResolvedValue(new Headers());
  vi.mocked(auth.api.getSession).mockResolvedValue(session('ADMIN', CUSTOMER));
});

afterEach(() => __resetAuthorizationPolicyForTests());

describe('a support session as the handler and the policy see it', () => {
  it('runs in the org as source support, carrying the grant, presenting as an org ADMIN who is not a platform admin', async () => {
    grantOpen();
    const seen: Seen[] = [];
    const res = await withAuth(record(seen), NOT_ABOUT_OWNERSHIP)(request());

    expect(res.status).toBe(200);
    expect(seen[0].context).toEqual({
      orgId: CUSTOMER,
      source: 'support',
      role: ORG_ADMIN_ROLE,
      support: { grantId: GRANT_ID, level: 'ADMIN', expiresAt: EXPIRES },
    });
    expect(seen[0].principal).toMatchObject({
      userId: 'user_1',
      role: 'USER',
      orgId: CUSTOMER,
      orgRole: ORG_ADMIN_ROLE,
    });
    expect(seen[0].userRole).toBe('USER');
    expect(seen[0].handlerSaysPlatformAdmin).toBe(false);
  });

  it('is refused on a platform-tier admin route, and the handler never runs', async () => {
    grantOpen();
    const seen: Seen[] = [];
    const res = await withAdminAuth(record(seen), NOT_ABOUT_OWNERSHIP)(request());

    expect(res.status).toBe(403);
    expect(seen).toEqual([]);
  });

  it('is admitted on an org-tier admin route, as an org ADMIN', async () => {
    grantOpen();
    const seen: Seen[] = [];
    const res = await withAdminAuth(record(seen), { ...NOT_ABOUT_OWNERSHIP, tier: 'org' })(
      request()
    );

    expect(res.status).toBe(200);
    expect(seen[0].principal).toMatchObject({ role: 'USER', orgRole: ORG_ADMIN_ROLE });
    expect(seen[0].handlerSaysPlatformAdmin).toBe(false);
  });

  it('a fork policy written as isPlatformAdmin(viewer) admits nothing, at either tier', async () => {
    registerAuthorizationPolicy({
      ...DEFAULT_AUTHORIZATION_POLICY,
      canAdminister: (viewer) => Promise.resolve(isPlatformAdmin(viewer)),
    });
    grantOpen();
    const seen: Seen[] = [];

    const platform = await withAdminAuth(record(seen), NOT_ABOUT_OWNERSHIP)(request());
    const org = await withAdminAuth(record(seen), { ...NOT_ABOUT_OWNERSHIP, tier: 'org' })(
      request()
    );

    expect(platform.status).toBe(403);
    expect(org.status).toBe(403);
    expect(seen).toEqual([]);
  });

  it('the same platform admin, as a member of the install org, is still a platform admin (control)', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(session('ADMIN', INSTALL_ORG_ID));
    mockFindUnique.mockResolvedValue({ role: ORG_OWNER_ROLE, org: { status: 'ACTIVE' } });
    const seen: Seen[] = [];
    const res = await withAdminAuth(record(seen), NOT_ABOUT_OWNERSHIP)(request());

    expect(res.status).toBe(200);
    expect(seen[0].principal.role).toBe('ADMIN');
    expect(seen[0].handlerSaysPlatformAdmin).toBe(true);
    expect(mockFindFirst).not.toHaveBeenCalled();
  });
});

describe('a READ_ONLY grant', () => {
  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])(
    'refuses %s in withAuth before the handler runs',
    async (method) => {
      grantOpen('READ_ONLY');
      const seen: Seen[] = [];
      const res = await withAuth(record(seen), NOT_ABOUT_OWNERSHIP)(request(method));
      const body = await res.json();

      expect(res.status).toBe(403);
      expect(body.error.message).toBe('Support access to this organisation is read-only');
      expect(seen).toEqual([]);
      expect(logger.warn).toHaveBeenCalledWith(
        'tenancy: refused a write under a read-only support grant',
        expect.objectContaining({ guard: 'withAuth', method, grantId: GRANT_ID })
      );
    }
  );

  it('refuses a write in withAdminAuth on an org-tier route before the handler runs', async () => {
    grantOpen('READ_ONLY');
    const seen: Seen[] = [];
    const res = await withAdminAuth(record(seen), { ...NOT_ABOUT_OWNERSHIP, tier: 'org' })(
      request('POST')
    );

    expect(res.status).toBe(403);
    expect(seen).toEqual([]);
  });

  it('admits a read', async () => {
    grantOpen('READ_ONLY');
    const seen: Seen[] = [];
    const res = await withAdminAuth(record(seen), { ...NOT_ABOUT_OWNERSHIP, tier: 'org' })(
      request('GET')
    );

    expect(res.status).toBe(200);
    expect(seen[0].context?.support?.level).toBe('READ_ONLY');
  });

  it('an ADMIN-level grant admits the same write (control)', async () => {
    grantOpen('ADMIN');
    const seen: Seen[] = [];
    const res = await withAuth(record(seen), NOT_ABOUT_OWNERSHIP)(request('POST'));

    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
  });
});

describe('the grant is read on every request', () => {
  it('a grant that ends between two requests on the same cookie refuses the second', async () => {
    mockFindFirst
      .mockResolvedValueOnce({ id: GRANT_ID, level: 'ADMIN', expiresAt: EXPIRES })
      .mockResolvedValueOnce(null);
    const seen: Seen[] = [];
    const handler = withAuth(record(seen), NOT_ABOUT_OWNERSHIP);

    const first = await handler(request());
    const second = await handler(request());

    expect(first.status).toBe(200);
    expect(second.status).toBe(403);
    expect(seen).toHaveLength(1);
    expect(mockFindFirst).toHaveBeenCalledTimes(2);
  });

  it('an org with no grant refuses a platform admin who is not a member', async () => {
    const seen: Seen[] = [];
    const res = await withAuth(record(seen), NOT_ABOUT_OWNERSHIP)(request());

    expect(res.status).toBe(403);
    expect(seen).toEqual([]);
  });
});

describe('at single', () => {
  it('a platform admin enters the install org as themselves, and the grant is never read', async () => {
    mockEnv.TENANCY_MODE = 'single';
    vi.mocked(auth.api.getSession).mockResolvedValue(session('ADMIN', null));
    grantOpen();
    const seen: Seen[] = [];
    const res = await withAdminAuth(record(seen), NOT_ABOUT_OWNERSHIP)(request('POST'));

    expect(res.status).toBe(200);
    expect(seen[0].context?.source).toBe('session');
    expect(seen[0].principal.role).toBe('ADMIN');
    expect(mockFindFirst).not.toHaveBeenCalled();
  });
});
