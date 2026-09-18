/**
 * Tests: the guards enter an org for every request they admit (§106)
 *
 * `guards-authorization.test.ts` pins WHAT the policy is told; this file pins
 * where the org came from and what the handler runs inside:
 *
 * - each of the three sources enters the right org — the session's
 *   `activeOrgId`, the API key's org, the proxy-written resolver header —
 *   and the header wins for that request only;
 * - a non-member and a suspended org are refused with one 403 that names
 *   nothing, and the handler never runs;
 * - the API-key read rule's three arms (admin ⇒ no org; no org ⇒ install at
 *   single; bound ⇒ that org, verified);
 * - the handler runs INSIDE the tenant context, with the same org and role
 *   the policy was given, and nothing leaks after the response.
 *
 * `lib/tenancy/entry.ts` is real — its own test covers its arms; here it is
 * driven through the guards with the membership read mocked at Prisma.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { DEFAULT_ORG_ROLE, ORG_ADMIN_ROLE, ORG_OWNER_ROLE } from '@/lib/tenancy/roles';

const mockEnv = vi.hoisted(() => ({ TENANCY_MODE: 'single' }));
vi.mock('@/lib/env', () => ({ env: mockEnv }));

const mockFindUnique = vi.hoisted(() => vi.fn());
vi.mock('@/lib/db/client', () => ({
  prisma: { orgMembership: { findUnique: mockFindUnique }, org: { findMany: vi.fn() } },
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
import { resolveApiKey } from '@/lib/auth/api-keys';
import { withAuth, withAdminAuth } from '@/lib/auth/guards';
import {
  DEFAULT_AUTHORIZATION_POLICY,
  registerAuthorizationPolicy,
  __resetAuthorizationPolicyForTests,
  type AuthorizationPrincipal,
} from '@/lib/auth/authorization';
import { getTenantContext, type TenantContext } from '@/lib/tenancy/context';
import { TENANT_HEADER_NAME } from '@/lib/tenancy/resolver';

const OTHER = 'cmorg000000000000000other';
const NOT_ABOUT_OWNERSHIP = {
  ownership: { decidedBy: 'nothing', because: 'Fixture: about the guard, not the rows.' },
} as const;

function session(role: 'USER' | 'ADMIN' = 'USER', activeOrgId: string | null = null) {
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
      name: 'Test User',
      email: 'test@example.com',
      emailVerified: true,
      image: null,
      role,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  };
}

function apiKey(scopes: string[], orgId: string | null) {
  return { session: session('USER'), scopes, rateLimitRpm: null, orgId, ownerAccountType: 'HUMAN' };
}

function memberOf(role: string, status: 'ACTIVE' | 'SUSPENDED' = 'ACTIVE') {
  mockFindUnique.mockResolvedValue({ role, org: { status } });
}

const request = () => new NextRequest('http://localhost:3000/api/v1/test');
const ok = () => Response.json({ success: true });

/** A handler that reports the context it ran inside and the principal it got. */
function probe() {
  const seen: { context: TenantContext | null; principal: AuthorizationPrincipal }[] = [];
  const handler = withAuth((_req, s) => {
    seen.push({ context: getTenantContext(), principal: s.principal });
    return ok();
  }, NOT_ABOUT_OWNERSHIP);
  return { handler, seen };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEnv.TENANCY_MODE = 'single';
  mockFindUnique.mockResolvedValue(null);
  vi.mocked(headers).mockResolvedValue(new Headers());
  vi.mocked(resolveApiKey).mockResolvedValue(null);
});

afterEach(() => __resetAuthorizationPolicyForTests());

describe('the session source', () => {
  it('enters the install org for a null activeOrgId at single, with no membership read', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(session('USER', null));
    const { handler, seen } = probe();

    const res = await handler(request());

    expect(res.status).toBe(200);
    expect(seen[0].context).toEqual({
      orgId: INSTALL_ORG_ID,
      source: 'session',
      role: DEFAULT_ORG_ROLE,
    });
    expect(seen[0].principal).toMatchObject({ orgId: INSTALL_ORG_ID, orgRole: DEFAULT_ORG_ROLE });
    expect(mockFindUnique).not.toHaveBeenCalled();
  });

  it('enters the org the session names, verified, with the membership’s role', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(session('USER', OTHER));
    memberOf(ORG_ADMIN_ROLE);
    const { handler, seen } = probe();

    await handler(request());

    expect(seen[0].context).toEqual({ orgId: OTHER, source: 'session', role: ORG_ADMIN_ROLE });
    expect(seen[0].principal).toMatchObject({ orgId: OTHER, orgRole: ORG_ADMIN_ROLE });
  });

  it('refuses a non-member with a 403 that names nothing, and never runs the handler', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(session('USER', OTHER));
    const { handler, seen } = probe();

    const res = await handler(request());
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error.message).toBe('Access denied');
    expect(body.error.message).not.toMatch(/member|org/i);
    expect(seen).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      'tenancy: refused to enter an org for a request',
      expect.objectContaining({ guard: 'withAuth', refused: 'not-a-member' })
    );
  });

  it('refuses a suspended org with the same message — no enumeration', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(session('ADMIN', OTHER));
    memberOf(ORG_OWNER_ROLE, 'SUSPENDED');

    const res = await withAdminAuth(() => ok())(request());
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error.message).toBe('Access denied');
    expect(logger.warn).toHaveBeenCalledWith(
      'tenancy: refused to enter an org for a request',
      expect.objectContaining({ guard: 'withAdminAuth', refused: 'org-suspended' })
    );
  });

  it('at multi a session with no org is refused, even a platform admin', async () => {
    mockEnv.TENANCY_MODE = 'multi';
    vi.mocked(auth.api.getSession).mockResolvedValue(session('ADMIN', null));

    const res = await withAdminAuth(() => ok())(request());

    expect(res.status).toBe(403);
  });
});

describe('the resolver header', () => {
  it('wins over the session’s org for this request, verified against membership', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(session('USER', INSTALL_ORG_ID));
    vi.mocked(headers).mockResolvedValue(new Headers({ [TENANT_HEADER_NAME]: OTHER }));
    memberOf(DEFAULT_ORG_ROLE);
    const { handler, seen } = probe();

    await handler(request());

    expect(seen[0].context).toEqual({ orgId: OTHER, source: 'resolver', role: DEFAULT_ORG_ROLE });
    expect(mockFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { orgId_userId: { orgId: OTHER, userId: 'user_1' } } })
    );
  });

  it('is refused when the caller is not a member of the org it names — it picks, it never grants', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(session('ADMIN', INSTALL_ORG_ID));
    vi.mocked(headers).mockResolvedValue(new Headers({ [TENANT_HEADER_NAME]: OTHER }));

    const res = await withAdminAuth(() => ok())(request());

    expect(res.status).toBe(403);
  });
});

describe('the API-key source', () => {
  it('an admin-scoped key enters no org: the handler runs outside any context', async () => {
    vi.mocked(resolveApiKey).mockResolvedValue(apiKey(['admin'], OTHER));
    const { handler, seen } = probe();

    await handler(request());

    expect(seen[0].context).toBeNull();
    expect(seen[0].principal).not.toHaveProperty('orgId');
    expect(mockFindUnique).not.toHaveBeenCalled();
  });

  it('a key with no org enters the install org at single, as its owner would', async () => {
    vi.mocked(resolveApiKey).mockResolvedValue(apiKey(['chat'], null));
    const { handler, seen } = probe();

    await handler(request());

    expect(seen[0].context).toEqual({
      orgId: INSTALL_ORG_ID,
      source: 'api-key',
      role: DEFAULT_ORG_ROLE,
    });
  });

  it('a key bound to an org enters it, verified against the owner’s membership', async () => {
    vi.mocked(resolveApiKey).mockResolvedValue(apiKey(['chat'], OTHER));
    memberOf(DEFAULT_ORG_ROLE);
    const { handler, seen } = probe();

    await handler(request());

    expect(seen[0].context).toMatchObject({ orgId: OTHER, source: 'api-key' });
  });

  it('a key whose owner has left the org is refused', async () => {
    vi.mocked(resolveApiKey).mockResolvedValue(apiKey(['chat'], OTHER));
    const { handler, seen } = probe();

    const res = await handler(request());

    expect(res.status).toBe(403);
    expect(seen).toEqual([]);
  });

  it('withAdminAuth enters no org for an admin key, by the same rule', async () => {
    vi.mocked(resolveApiKey).mockResolvedValue(apiKey(['admin'], null));
    let context: TenantContext | null | undefined;

    const res = await withAdminAuth(() => {
      context = getTenantContext();
      return ok();
    })(request());

    expect(res.status).toBe(200);
    expect(context).toBeNull();
  });

  it('withAdminAuth refuses an org-bound key whatever its scopes — the floor the seam promised (t-673)', async () => {
    // Mint forbids `admin` + org and the backfill leaves admin keys unbound,
    // so no honest row has both; a row that does is refused here, before the
    // policy is asked, rather than admitted to every org's admin surface.
    const seen: (TenantContext | null)[] = [];
    const handler = withAdminAuth(() => {
      seen.push(getTenantContext());
      return ok();
    });

    vi.mocked(resolveApiKey).mockResolvedValue(apiKey(['admin'], OTHER));
    expect((await handler(request())).status).toBe(403);
    vi.mocked(resolveApiKey).mockResolvedValue(apiKey(['admin'], INSTALL_ORG_ID));
    expect((await handler(request())).status).toBe(403);
    vi.mocked(resolveApiKey).mockResolvedValue(apiKey(['chat'], OTHER));
    expect((await handler(request())).status).toBe(403);

    expect(seen).toEqual([]);
    // And the control: the same key with no org is the platform credential.
    vi.mocked(resolveApiKey).mockResolvedValue(apiKey(['admin'], null));
    expect((await handler(request())).status).toBe(200);
    expect(seen).toEqual([null]);
  });
});

describe('a route that declares it does not enter an org', () => {
  const LEAVES_ORG = {
    ...NOT_ABOUT_OWNERSHIP,
    tenancy: { entersOrg: false, because: 'Fixture: the way out of a refused org.' },
  } as const;

  it('is reachable from a suspended active org — the switch must not be behind the refusal', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(session('USER', OTHER));
    memberOf(ORG_OWNER_ROLE, 'SUSPENDED');
    let context: TenantContext | null | undefined;
    let principal: AuthorizationPrincipal | undefined;

    const res = await withAuth((_req, s) => {
      context = getTenantContext();
      principal = s.principal;
      return ok();
    }, LEAVES_ORG)(request());

    expect(res.status).toBe(200);
    // No membership read either: the route did not ask which org.
    expect(mockFindUnique).not.toHaveBeenCalled();
    expect(context).toBeNull();
    expect(principal).not.toHaveProperty('orgId');
  });

  it('is reachable from an org the caller was removed from', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(session('USER', OTHER));
    mockFindUnique.mockResolvedValue(null);

    const res = await withAuth(() => ok(), LEAVES_ORG)(request());

    expect(res.status).toBe(200);
  });

  it('control: the same session on an ordinary route is refused', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(session('USER', OTHER));
    memberOf(ORG_OWNER_ROLE, 'SUSPENDED');

    const res = await withAuth(() => ok(), NOT_ABOUT_OWNERSHIP)(request());

    expect(res.status).toBe(403);
  });
});

describe('the scope', () => {
  it('covers the resource resolver and the policy, not only the handler', async () => {
    // §107's data layer will read the context inside the resolver's own query;
    // a resolver outside the scope would throw "No tenant context" at multi.
    vi.mocked(auth.api.getSession).mockResolvedValue(session('USER', OTHER));
    memberOf(ORG_ADMIN_ROLE);
    const seen: string[] = [];
    __resetAuthorizationPolicyForTests();
    registerAuthorizationPolicy({
      ...DEFAULT_AUTHORIZATION_POLICY,
      canRead: (viewer, target, scope) => {
        seen.push(`policy:${getTenantContext()?.orgId}`);
        return DEFAULT_AUTHORIZATION_POLICY.canRead(viewer, target, scope);
      },
    });

    await withAuth(
      () => {
        seen.push(`handler:${getTenantContext()?.orgId}`);
        return ok();
      },
      {
        ownership: { decidedBy: 'resource', because: 'Fixture.' },
        resource: () => {
          seen.push(`resolver:${getTenantContext()?.orgId}`);
          return { kind: 'thing', id: 't1', ownerId: 'user_1' };
        },
      }
    )(request());

    // The guard asks the policy more than once per request (the ownerless-read
    // capability question, per kind); every ask, the resolver and the handler
    // must all be inside the same scope.
    expect(seen[0]).toBe(`resolver:${OTHER}`);
    expect(seen.at(-1)).toBe(`handler:${OTHER}`);
    expect(seen.filter((entry) => entry.startsWith('policy:'))).not.toHaveLength(0);
    expect(new Set(seen.map((entry) => entry.split(':')[1]))).toEqual(new Set([OTHER]));
  });

  it('does not leak past the response', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(session('USER', null));
    const { handler } = probe();

    await handler(request());

    expect(getTenantContext()).toBeNull();
  });

  it('is entered before the handler and the policy alike: the policy sees the same org', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(session('USER', OTHER));
    memberOf(ORG_ADMIN_ROLE);
    const askedWith: unknown[] = [];
    __resetAuthorizationPolicyForTests();
    registerAuthorizationPolicy({
      ...DEFAULT_AUTHORIZATION_POLICY,
      canRead: (viewer, target, scope) => {
        askedWith.push({ orgId: viewer.orgId, orgRole: viewer.orgRole, scope });
        return DEFAULT_AUTHORIZATION_POLICY.canRead(viewer, target, scope);
      },
    });
    const { handler, seen } = probe();

    await handler(request());

    expect(askedWith[0]).toEqual({ orgId: OTHER, orgRole: ORG_ADMIN_ROLE, scope: { org: OTHER } });
    expect(seen[0].context?.orgId).toBe(OTHER);
  });
});
