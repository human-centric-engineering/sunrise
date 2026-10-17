/**
 * Unit Tests: GET /api/v1/orgs/[id]/support-grants/activity (§121 t-825)
 *
 * Runs the REAL `withAuth`, the REAL default policy, the REAL entry rule, the
 * REAL `resolveOrgResource` and the REAL `listSupportActivity`, with Prisma
 * mocked at the delegates. The audit-log delegate answers from an in-memory
 * table of rows, each made under a grant of one org or another, filtered by
 * the `where` the read builds — so "another org's grant id returns nothing"
 * is decided by the filter the code wrote, not by what a mock was told to
 * return. `scripts/smoke/tenancy-isolation.ts` [19d] proves the same read
 * against Postgres.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import { DEFAULT_ORG_ROLE, ORG_ADMIN_ROLE, ORG_OWNER_ROLE } from '@/lib/tenancy/roles';
import { PLATFORM_ADMIN_ROLE } from '@/lib/auth/roles';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';

const mockEnv = vi.hoisted(() => ({ TENANCY_MODE: 'multi' }));
vi.mock('@/lib/env', () => ({ env: mockEnv }));

const mockGetSession = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: mockGetSession } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));

const mockDb = vi.hoisted(() => ({
  org: { findUnique: vi.fn() },
  orgMembership: { findUnique: vi.fn() },
  orgSupportGrant: { findFirst: vi.fn() },
  aiApiKey: { findFirst: vi.fn(), update: vi.fn() },
  aiAdminAuditLog: { findMany: vi.fn(), count: vi.fn() },
}));
vi.mock('@/lib/db/client', () => ({ prisma: mockDb }));

const mockLog = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock('@/lib/api/context', () => ({ getRouteLogger: vi.fn(async () => mockLog) }));
vi.mock('@/lib/logging', () => ({ logger: mockLog }));

import { GET } from '@/app/api/v1/orgs/[id]/support-grants/activity/route';
import { createMockAuthSession } from '@/tests/helpers/auth';

const ORG = 'cmorg000000000000000other';
const ELSEWHERE = 'cmorg00000000000000elsewh';
const GRANT = 'cmgrant00000000000000one';
const OLDER_GRANT = 'cmgrant000000000000older';
const ELSEWHERE_GRANT = 'cmgrant00000000000elsewh';
const USER_ID = 'cmjbv4i3x00003wsloputgwul';

interface Row {
  id: string;
  supportGrantId: string | null;
  grantOrgId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  entityName: string | null;
  createdAt: Date;
  user: { id: string; name: string | null } | null;
}

const row = (id: string, supportGrantId: string | null, grantOrgId: string | null, at: number) => ({
  id,
  supportGrantId,
  grantOrgId,
  action: 'agent.update',
  entityType: 'agent',
  entityId: 'cmagent00000000000agent01',
  entityName: `Agent ${id}`,
  createdAt: new Date(at),
  user: { id: 'cmsupport000000000person1', name: 'Support Person' },
});

/** The audit table: this org's grants, another org's grant, and a row made outside support. */
const TABLE: Row[] = [
  row('r1', GRANT, ORG, 3_000),
  row('r2', OLDER_GRANT, ORG, 1_000),
  row('r3', ELSEWHERE_GRANT, ELSEWHERE, 2_000),
  row('r4', null, null, 4_000),
];

type Where = {
  supportGrantId?: string | { not: null };
  supportGrant?: { orgId?: string };
  supportOrgId?: string;
};

/** Answers the delegate's `where` the way Postgres would, for the keys the read may use. */
function matching(where: Where): Row[] {
  return TABLE.filter((r) => {
    const g = where.supportGrantId;
    if (typeof g === 'string' && r.supportGrantId !== g) return false;
    if (g && typeof g === 'object' && r.supportGrantId === null) return false;
    if (where.supportGrant?.orgId !== undefined && r.grantOrgId !== where.supportGrant.orgId)
      return false;
    // A support row's `supportOrgId` is its grant's org (both come from the tenant context).
    if (where.supportOrgId !== undefined && r.grantOrgId !== where.supportOrgId) return false;
    return true;
  });
}

function session(role: 'USER' | 'ADMIN', activeOrgId: string | null) {
  const base = createMockAuthSession();
  return { session: { ...base.session, activeOrgId }, user: { ...base.user, role } };
}

function memberOf(role: string) {
  mockDb.orgMembership.findUnique.mockResolvedValue({ role, org: { status: 'ACTIVE' } });
}

function get(query = '', orgId = ORG, headers: Record<string, string> = {}) {
  const request = new Request(
    `http://localhost/api/v1/orgs/${orgId}/support-grants/activity${query ? `?${query}` : ''}`,
    { headers }
  ) as unknown as NextRequest;
  return GET(request, { params: Promise.resolve({ id: orgId }) });
}

async function body(res: Response) {
  return JSON.parse(await res.text());
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEnv.TENANCY_MODE = 'multi';
  mockDb.aiApiKey.findFirst.mockResolvedValue(null);
  mockDb.org.findUnique.mockResolvedValue({ id: ORG, status: 'ACTIVE', name: 'Acme' });
  mockDb.orgSupportGrant.findFirst.mockResolvedValue(null);
  mockDb.aiAdminAuditLog.findMany.mockImplementation(
    async (args: { where: Where; skip: number; take: number }) =>
      matching(args.where)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(args.skip, args.skip + args.take)
        .map(({ grantOrgId: _org, ...r }) => r)
  );
  mockDb.aiAdminAuditLog.count.mockImplementation(
    async (args: { where: Where }) => matching(args.where).length
  );
});

describe('GET — what support did in the org', () => {
  it('lists the rows made under the org’s own grants, newest first, and nothing else', async () => {
    mockGetSession.mockResolvedValue(session('USER', ORG));
    memberOf(ORG_OWNER_ROLE);

    const res = await get();
    const json = await body(res);

    expect(res.status).toBe(200);
    // r3 is another org's grant; r4 was made outside any support session.
    expect(json.data.map((e: { id: string }) => e.id)).toEqual(['r1', 'r2']);
    expect(json.meta).toEqual(expect.objectContaining({ total: 2, page: 1 }));
    expect(json.data[0]).toEqual({
      id: 'r1',
      grantId: GRANT,
      action: 'agent.update',
      entityType: 'agent',
      entityId: 'cmagent00000000000agent01',
      entityName: 'Agent r1',
      createdAt: new Date(3_000).toISOString(),
      actor: { id: 'cmsupport000000000person1', name: 'Support Person' },
    });
  });

  it('narrows to one of the org’s grants', async () => {
    mockGetSession.mockResolvedValue(session('USER', ORG));
    memberOf(ORG_ADMIN_ROLE);

    const json = await body(await get(`grantId=${OLDER_GRANT}`));

    expect(json.data.map((e: { id: string }) => e.id)).toEqual(['r2']);
  });

  it('returns nothing for a grant id that belongs to another org', async () => {
    mockGetSession.mockResolvedValue(session('USER', ORG));
    memberOf(ORG_OWNER_ROLE);
    // The other org's grant has a row — the population is not empty.
    expect(matching({ supportGrantId: ELSEWHERE_GRANT })).toHaveLength(1);

    const res = await get(`grantId=${ELSEWHERE_GRANT}`);
    const json = await body(res);

    expect(res.status).toBe(200);
    expect(json.data).toEqual([]);
    expect(json.meta).toEqual(expect.objectContaining({ total: 0 }));
  });

  it('lets a platform admin in the install org read it, as the grant list does', async () => {
    mockGetSession.mockResolvedValue(session(PLATFORM_ADMIN_ROLE, INSTALL_ORG_ID));
    memberOf(ORG_OWNER_ROLE);

    const res = await get();

    expect(res.status).toBe(200);
    expect((await body(res)).data).toHaveLength(2);
  });

  it('refuses a MEMBER of the org at the policy, reading nothing', async () => {
    mockGetSession.mockResolvedValue(session('USER', ORG));
    memberOf(DEFAULT_ORG_ROLE);

    expect((await get()).status).toBe(403);
    expect(mockDb.aiAdminAuditLog.findMany).not.toHaveBeenCalled();
  });

  it('refuses an OWNER acting in another org, reading nothing', async () => {
    mockGetSession.mockResolvedValue(session('USER', ELSEWHERE));
    memberOf(ORG_OWNER_ROLE);

    expect((await get()).status).toBe(403);
    expect(mockDb.aiAdminAuditLog.findMany).not.toHaveBeenCalled();
  });

  it('rejects a malformed grant id', async () => {
    mockGetSession.mockResolvedValue(session('USER', ORG));
    memberOf(ORG_OWNER_ROLE);

    expect((await get('grantId=not-a-cuid')).status).toBe(400);
    expect(mockDb.aiAdminAuditLog.findMany).not.toHaveBeenCalled();
  });

  it('refuses an admin-scoped API key', async () => {
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
        role: PLATFORM_ADMIN_ROLE,
        accountType: 'HUMAN',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

    const res = await get('', ORG, {
      authorization: 'Bearer sk_deadbeefdeadbeefdeadbeefdeadbeef',
    });

    expect(res.status).toBe(403);
    expect(mockDb.aiAdminAuditLog.findMany).not.toHaveBeenCalled();
  });
});
