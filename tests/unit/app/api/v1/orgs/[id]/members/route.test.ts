/**
 * Unit Tests: GET/POST /api/v1/orgs/[id]/members (§106 t-672)
 *
 * Runs the REAL `withAuth`, the REAL default policy, the REAL entry rule and
 * the REAL `resolveOrgResource`, with Prisma mocked at the delegates — because
 * the claim under test is "who reaches this handler is the policy's decision,
 * not a role check in the route". So: an org ADMIN acting in the org is
 * admitted, a MEMBER is not, an ADMIN acting in the WRONG org is not, a
 * platform admin is from anywhere, and a non-member / a missing org get one
 * 403 that names nothing. The lifecycle write is mocked at the module (its
 * own test covers the rules); the resolver is not.
 *
 * `TENANCY_MODE=single` and the session names the org: the guard reads and
 * verifies the membership for any non-install org, which is the read these
 * cases arm.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import { DEFAULT_ORG_ROLE, ORG_ADMIN_ROLE, ORG_OWNER_ROLE } from '@/lib/tenancy/roles';
import { PLATFORM_ADMIN_ROLE } from '@/lib/auth/roles';

const mockEnv = vi.hoisted(() => ({ TENANCY_MODE: 'single' }));
vi.mock('@/lib/env', () => ({ env: mockEnv }));

const mockGetSession = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: mockGetSession } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    org: { findUnique: vi.fn() },
    orgMembership: { findUnique: vi.fn(), findMany: vi.fn() },
    aiApiKey: { findFirst: vi.fn(), update: vi.fn() },
  },
}));

const mockAddMember = vi.hoisted(() => vi.fn());
vi.mock('@/lib/tenancy/lifecycle', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tenancy/lifecycle')>()),
  addMember: mockAddMember,
}));

const mockLog = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock('@/lib/api/context', () => ({ getRouteLogger: vi.fn(async () => mockLog) }));
vi.mock('@/lib/logging', () => ({ logger: mockLog }));

import { GET, POST } from '@/app/api/v1/orgs/[id]/members/route';
import { prisma } from '@/lib/db/client';
import { createMockAuthSession } from '@/tests/helpers/auth';

const ORG = 'cmorg000000000000000other';
const USER_ID = 'cmjbv4i3x00003wsloputgwul';
const NEW_MEMBER = 'cmjbv4i3x00005wsloputgwuy';

function session(role: 'USER' | 'ADMIN', activeOrgId: string | null) {
  const base = createMockAuthSession();
  return {
    session: { ...base.session, activeOrgId },
    user: { ...base.user, role },
  };
}

/** The guard's membership read for a non-install org. */
function memberOf(role: string, status: 'ACTIVE' | 'SUSPENDED' = 'ACTIVE') {
  vi.mocked(prisma.orgMembership.findUnique).mockResolvedValue({ role, org: { status } } as never);
}

function get(orgId = ORG, headers: Record<string, string> = {}) {
  const request = new Request(`http://localhost/api/v1/orgs/${orgId}/members`, {
    headers,
  }) as unknown as NextRequest;
  return GET(request, { params: Promise.resolve({ id: orgId }) });
}

function post(body: unknown, orgId = ORG, headers: Record<string, string> = {}) {
  const request = new Request(`http://localhost/api/v1/orgs/${orgId}/members`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
  return POST(request, { params: Promise.resolve({ id: orgId }) });
}

const roster = [
  {
    role: ORG_OWNER_ROLE,
    createdAt: new Date('2026-09-01'),
    user: { id: USER_ID, name: 'Owner', email: 'owner@example.com', image: null },
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockEnv.TENANCY_MODE = 'single';
  vi.mocked(prisma.aiApiKey.findFirst).mockResolvedValue(null);
  vi.mocked(prisma.org.findUnique).mockResolvedValue({ id: ORG } as never);
  vi.mocked(prisma.orgMembership.findMany).mockResolvedValue(roster as never);
  mockAddMember.mockResolvedValue({
    id: 'm2',
    orgId: ORG,
    userId: NEW_MEMBER,
    role: DEFAULT_ORG_ROLE,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
});

describe('GET /api/v1/orgs/[id]/members — who the policy admits', () => {
  it('admits an org ADMIN acting in the org, and lists the roster filtered by the resolved id', async () => {
    mockGetSession.mockResolvedValue(session('USER', ORG));
    memberOf(ORG_ADMIN_ROLE);

    const res = await get();
    const json = JSON.parse(await res.text());

    expect(res.status).toBe(200);
    expect(json.data.orgId).toBe(ORG);
    expect(json.data.members).toEqual([
      expect.objectContaining({ id: USER_ID, email: 'owner@example.com', role: ORG_OWNER_ROLE }),
    ]);
    expect(prisma.orgMembership.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { orgId: ORG } })
    );
  });

  it('admits an org OWNER the same way', async () => {
    mockGetSession.mockResolvedValue(session('USER', ORG));
    memberOf(ORG_OWNER_ROLE);
    expect((await get()).status).toBe(200);
  });

  it('refuses a MEMBER acting in the org — the org arm admits OWNER/ADMIN only', async () => {
    mockGetSession.mockResolvedValue(session('USER', ORG));
    memberOf(DEFAULT_ORG_ROLE);

    const res = await get();

    expect(res.status).toBe(403);
    expect(JSON.parse(await res.text()).error.message).toBe('Access denied');
    expect(prisma.orgMembership.findMany).not.toHaveBeenCalled();
  });

  it('refuses an org ADMIN who is acting in a DIFFERENT org — the arm compares the entered org', async () => {
    // Session in the install org (null ⇒ install at single, no read); the
    // URL names the other org. Their ADMIN role there is never consulted.
    mockGetSession.mockResolvedValue(session('USER', null));

    const res = await get();

    expect(res.status).toBe(403);
    expect(prisma.orgMembership.findUnique).not.toHaveBeenCalled();
    expect(prisma.orgMembership.findMany).not.toHaveBeenCalled();
  });

  it('admits a platform admin from any org', async () => {
    mockGetSession.mockResolvedValue(session(PLATFORM_ADMIN_ROLE, null));
    expect((await get()).status).toBe(200);
  });

  it('says the same thing for a non-member and for an org that does not exist', async () => {
    mockGetSession.mockResolvedValue(session('USER', ORG));
    vi.mocked(prisma.orgMembership.findUnique).mockResolvedValue(null); // the entry refuses
    const notMember = await get();

    mockGetSession.mockResolvedValue(session(PLATFORM_ADMIN_ROLE, null));
    vi.mocked(prisma.org.findUnique).mockResolvedValue(null); // the resolver names nothing
    const noSuchOrg = await get('cmorg00000000000000nowhere');

    expect(notMember.status).toBe(403);
    expect(noSuchOrg.status).toBe(403);
    const a = JSON.parse(await notMember.text());
    const b = JSON.parse(await noSuchOrg.text());
    expect(a.error.message).toBe(b.error.message);
    expect(a.error.message).not.toMatch(/exist|found|member/i);
  });

  it('refuses a member of a SUSPENDED org at entry', async () => {
    mockGetSession.mockResolvedValue(session('USER', ORG));
    memberOf(ORG_OWNER_ROLE, 'SUSPENDED');
    const res = await get();
    expect(res.status).toBe(403);
    expect(prisma.orgMembership.findMany).not.toHaveBeenCalled();
  });

  it('returns 401 without a session', async () => {
    mockGetSession.mockResolvedValue(null);
    expect((await get()).status).toBe(401);
  });
});

describe('POST /api/v1/orgs/[id]/members', () => {
  it('adds a member through the lifecycle, keyed on the resolved org', async () => {
    mockGetSession.mockResolvedValue(session('USER', ORG));
    memberOf(ORG_ADMIN_ROLE);

    const res = await post({ userId: NEW_MEMBER, role: ORG_ADMIN_ROLE });
    const json = JSON.parse(await res.text());

    expect(res.status).toBe(201);
    expect(json.data).toEqual(expect.objectContaining({ userId: NEW_MEMBER }));
    expect(mockAddMember).toHaveBeenCalledWith(ORG, NEW_MEMBER, ORG_ADMIN_ROLE);
  });

  it('passes an absent role through as undefined so the lifecycle defaults it', async () => {
    mockGetSession.mockResolvedValue(session('USER', ORG));
    memberOf(ORG_OWNER_ROLE);
    await post({ userId: NEW_MEMBER });
    expect(mockAddMember).toHaveBeenCalledWith(ORG, NEW_MEMBER, undefined);
  });

  it('answers a lifecycle refusal with its own status and code', async () => {
    mockGetSession.mockResolvedValue(session('USER', ORG));
    memberOf(ORG_ADMIN_ROLE);
    const { OrgLifecycleError } = await import('@/lib/tenancy/lifecycle');
    mockAddMember.mockRejectedValue(new OrgLifecycleError('ALREADY_MEMBER', 'already'));

    const res = await post({ userId: NEW_MEMBER });
    const json = JSON.parse(await res.text());

    expect(res.status).toBe(409);
    expect(json.error.code).toBe('ALREADY_MEMBER');
  });

  it('refuses a MEMBER before validating the body', async () => {
    mockGetSession.mockResolvedValue(session('USER', ORG));
    memberOf(DEFAULT_ORG_ROLE);
    const res = await post({ nonsense: true });
    expect(res.status).toBe(403);
    expect(mockAddMember).not.toHaveBeenCalled();
  });

  it.each([[{}], [{ userId: 'not-a-cuid' }], [{ userId: NEW_MEMBER, role: 'ROOT' }]])(
    'rejects a malformed body %j before writing',
    async (body) => {
      mockGetSession.mockResolvedValue(session('USER', ORG));
      memberOf(ORG_ADMIN_ROLE);
      const res = await post(body);
      expect(res.status).toBe(400);
      expect(mockAddMember).not.toHaveBeenCalled();
    }
  );

  it('refuses an API-key caller even when the key would otherwise be admitted', async () => {
    // Through the real `resolveApiKey`: an admin-scoped key is a platform
    // credential the policy admits, and this route still wants a person.
    vi.mocked(prisma.aiApiKey.findFirst).mockResolvedValue({
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
        role: PLATFORM_ADMIN_ROLE,
        accountType: 'HUMAN',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    } as never);

    const res = await post({ userId: NEW_MEMBER }, ORG, {
      authorization: 'Bearer sk_deadbeefdeadbeefdeadbeefdeadbeef',
    });

    expect(res.status).toBe(403);
    expect(JSON.parse(await res.text()).error.message).toMatch(/browser session/);
    expect(mockAddMember).not.toHaveBeenCalled();
  });
});
