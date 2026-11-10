/**
 * Unit Tests: GET /api/v1/orgs/[id]/audit-log (t-1005, #1181)
 *
 * Runs the REAL `withAuth`, the REAL default policy, the REAL entry rule, the
 * REAL `resolveOrgResource` and the REAL `listOrgAuditLog`, with Prisma mocked
 * at the delegates. The audit-log delegate answers from an in-memory table of
 * rows made in one org or another, filtered by the `where` the read builds, so
 * "B's reader never sees A's rows" is decided by the filter the code wrote,
 * not by what a mock was told to return.
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

import { GET } from '@/app/api/v1/orgs/[id]/audit-log/route';
import { createMockAuthSession } from '@/tests/helpers/auth';

const ORG_A = 'cmorg00000000000000orga01';
const ORG_B = 'cmorg00000000000000orgb01';
const GRANT = 'cmgrant00000000000000one';
const USER_ID = 'cmjbv4i3x00003wsloputgwul';

interface Row {
  id: string;
  actingOrgId: string | null;
  supportGrantId: string | null;
  supportOrgId: string | null;
  clientIp: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  entityName: string | null;
  changes: unknown;
  metadata: unknown;
  createdAt: Date;
  user: { id: string; name: string | null } | null;
}

function row(id: string, actingOrgId: string | null, at: number, extra: Partial<Row> = {}): Row {
  return {
    id,
    actingOrgId,
    supportGrantId: null,
    supportOrgId: null,
    clientIp: '203.0.113.7',
    action: 'agent.update',
    entityType: 'agent',
    entityId: 'cmagent00000000000agent01',
    entityName: `Agent ${id}`,
    changes: { name: { from: 'Old', to: 'New' } },
    metadata: null,
    createdAt: new Date(at),
    user: { id: 'cmmember0000000000person1', name: 'Member Person' },
    ...extra,
  };
}

/** A's members, support in A, B's member, and a system-scope write made in no org. */
const TABLE: Row[] = [
  row('a1', ORG_A, 3_000, {
    entityType: 'app_page_design',
    user: { id: 'cmagency0000000000person1', name: 'Agency Person' },
  }),
  row('a2', ORG_A, 1_000, { supportGrantId: GRANT, supportOrgId: ORG_A }),
  // Support row whose grant went when its org was erased: still support.
  row('a3', ORG_A, 500, { supportGrantId: null, supportOrgId: ORG_A }),
  row('b1', ORG_B, 2_000),
  row('s1', null, 4_000, { user: null }),
];

type Where = {
  actingOrgId?: string | null;
  userId?: string;
  entityType?: { in: string[] };
};

/** Answers the delegate's `where` the way Postgres would, for the keys the read may use. */
function matching(where: Where): Row[] {
  return TABLE.filter(
    (r) =>
      (!('actingOrgId' in where) || r.actingOrgId === where.actingOrgId) &&
      (where.userId === undefined || r.user?.id === where.userId) &&
      (where.entityType === undefined || where.entityType.in.includes(r.entityType))
  );
}

/** Applies a Prisma `select` to a row, so a field the read did not ask for is absent. */
function selected(r: Row, select: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.keys(select).map((key) => [key, (r as unknown as Record<string, unknown>)[key]])
  );
}

function session(role: 'USER' | 'ADMIN', activeOrgId: string | null) {
  const base = createMockAuthSession();
  return { session: { ...base.session, activeOrgId }, user: { ...base.user, role } };
}

function memberOf(role: string) {
  mockDb.orgMembership.findUnique.mockResolvedValue({ role, org: { status: 'ACTIVE' } });
}

function get(orgId: string, query = '', headers: Record<string, string> = {}) {
  const request = new Request(
    `http://localhost/api/v1/orgs/${orgId}/audit-log${query ? `?${query}` : ''}`,
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
  mockDb.org.findUnique.mockImplementation(async (args: { where: { id: string } }) => ({
    id: args.where.id,
    status: 'ACTIVE',
    name: 'Org',
  }));
  mockDb.orgSupportGrant.findFirst.mockResolvedValue(null);
  mockDb.aiAdminAuditLog.findMany.mockImplementation(
    async (args: { where: Where; skip: number; take: number; select: Record<string, unknown> }) =>
      matching(args.where)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(args.skip, args.skip + args.take)
        .map((r) => selected(r, args.select))
  );
  mockDb.aiAdminAuditLog.count.mockImplementation(
    async (args: { where: Where }) => matching(args.where).length
  );
});

describe('GET — an org’s own admin history', () => {
  it('lists the rows made in the org, newest first, and nothing from another org or none', async () => {
    mockGetSession.mockResolvedValue(session('USER', ORG_A));
    memberOf(ORG_OWNER_ROLE);

    const res = await get(ORG_A);
    const json = await body(res);

    expect(res.status).toBe(200);
    // b1 is B's; s1 was a system-scope write made in no org.
    expect(json.data.map((e: { id: string }) => e.id)).toEqual(['a1', 'a2', 'a3']);
    expect(json.meta).toEqual(expect.objectContaining({ total: 3, page: 1 }));
    expect(json.data[0]).toEqual({
      id: 'a1',
      action: 'agent.update',
      entityType: 'app_page_design',
      entityId: 'cmagent00000000000agent01',
      entityName: 'Agent a1',
      changes: { name: { from: 'Old', to: 'New' } },
      metadata: null,
      createdAt: new Date(3_000).toISOString(),
      actor: { id: 'cmagency0000000000person1', name: 'Agency Person' },
      support: null,
    });
  });

  it('marks support rows, including one whose grant was erased', async () => {
    mockGetSession.mockResolvedValue(session('USER', ORG_A));
    memberOf(ORG_ADMIN_ROLE);

    const json = await body(await get(ORG_A));
    const byId = Object.fromEntries(
      json.data.map((e: { id: string; support: unknown }) => [e.id, e.support])
    );

    expect(byId).toEqual({ a1: null, a2: { grantId: GRANT }, a3: { grantId: null } });
  });

  it('does not mark a row as this org’s support when its support session was another org’s', async () => {
    mockGetSession.mockResolvedValue(session('USER', ORG_A));
    memberOf(ORG_OWNER_ROLE);
    // Filed under A explicitly while its actor was in B's support session.
    TABLE.push(
      row('a4', ORG_A, 100, { supportGrantId: 'cmgrant000000000000000bb', supportOrgId: ORG_B })
    );
    try {
      const json = await body(await get(ORG_A));
      const a4 = json.data.find((e: { id: string }) => e.id === 'a4');
      expect(a4).toBeDefined();
      expect(a4.support).toBeNull();
      expect(JSON.stringify(json)).not.toContain('cmgrant000000000000000bb');
    } finally {
      TABLE.pop();
    }
  });

  it('never returns the client IP, which every row in the table carries', async () => {
    mockGetSession.mockResolvedValue(session('USER', ORG_A));
    memberOf(ORG_OWNER_ROLE);
    expect(TABLE.every((r) => r.clientIp)).toBe(true);

    const json = await body(await get(ORG_A));

    expect(json.data).toHaveLength(3);
    for (const entry of json.data) expect(entry).not.toHaveProperty('clientIp');
  });

  it('gives B’s admin B’s rows only', async () => {
    mockGetSession.mockResolvedValue(session('USER', ORG_B));
    memberOf(ORG_ADMIN_ROLE);

    const json = await body(await get(ORG_B));

    expect(json.data.map((e: { id: string }) => e.id)).toEqual(['b1']);
  });

  it('refuses B’s OWNER asking for A’s history, reading nothing', async () => {
    mockGetSession.mockResolvedValue(session('USER', ORG_B));
    memberOf(ORG_OWNER_ROLE);

    expect((await get(ORG_A)).status).toBe(403);
    expect(mockDb.aiAdminAuditLog.findMany).not.toHaveBeenCalled();
  });

  it('refuses a MEMBER of the org at the policy, reading nothing', async () => {
    mockGetSession.mockResolvedValue(session('USER', ORG_A));
    memberOf(DEFAULT_ORG_ROLE);

    expect((await get(ORG_A)).status).toBe(403);
    expect(mockDb.aiAdminAuditLog.findMany).not.toHaveBeenCalled();
  });

  it('lets a platform admin in the install org read an org’s history', async () => {
    mockGetSession.mockResolvedValue(session(PLATFORM_ADMIN_ROLE, INSTALL_ORG_ID));
    memberOf(ORG_OWNER_ROLE);

    const res = await get(ORG_A);

    expect(res.status).toBe(200);
    expect((await body(res)).data).toHaveLength(3);
  });

  it('answers an org that does not exist as it answers a non-member, reading nothing', async () => {
    mockGetSession.mockResolvedValue(session(PLATFORM_ADMIN_ROLE, INSTALL_ORG_ID));
    memberOf(ORG_OWNER_ROLE);
    mockDb.org.findUnique.mockImplementation(async (args: { where: { id: string } }) =>
      args.where.id === ORG_A ? null : { id: args.where.id, status: 'ACTIVE', name: 'Org' }
    );

    const res = await get(ORG_A);

    // No enumeration: the members route answers the same way.
    expect(res.status).toBe(403);
    expect(mockDb.aiAdminAuditLog.findMany).not.toHaveBeenCalled();
  });

  it('narrows to one person, and to a set of entity types, within the org only', async () => {
    mockGetSession.mockResolvedValue(session('USER', ORG_A));
    memberOf(ORG_OWNER_ROLE);
    // B holds a row of the same type: the filter must not reach it.
    expect(TABLE.some((r) => r.actingOrgId === ORG_B && r.entityType === 'agent')).toBe(true);

    const byPerson = await body(await get(ORG_A, 'userId=cmagency0000000000person1'));
    const byType = await body(await get(ORG_A, 'entityType=agent,%20app_media_asset'));
    const both = await body(await get(ORG_A, 'userId=cmagency0000000000person1&entityType=agent'));

    expect(byPerson.data.map((e: { id: string }) => e.id)).toEqual(['a1']);
    expect(byType.data.map((e: { id: string }) => e.id)).toEqual(['a2', 'a3']);
    expect(both.data).toEqual([]);
    expect(mockDb.aiAdminAuditLog.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: {
          actingOrgId: ORG_A,
          userId: 'cmagency0000000000person1',
          entityType: { in: ['agent'] },
        },
      })
    );
  });

  it('reads an empty entity-type selection as no filter', async () => {
    mockGetSession.mockResolvedValue(session('USER', ORG_A));
    memberOf(ORG_OWNER_ROLE);

    for (const query of ['entityType=', 'entityType=,']) {
      const json = await body(await get(ORG_A, query));
      expect(json.data.map((e: { id: string }) => e.id)).toEqual(['a1', 'a2', 'a3']);
    }
    expect(mockDb.aiAdminAuditLog.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { actingOrgId: ORG_A } })
    );
  });

  it('rejects more than twenty entity types', async () => {
    mockGetSession.mockResolvedValue(session('USER', ORG_A));
    memberOf(ORG_OWNER_ROLE);
    const tooMany = Array.from({ length: 21 }, (_, i) => `t${i}`).join(',');

    expect((await get(ORG_A, `entityType=${tooMany}`)).status).toBe(400);
    expect(mockDb.aiAdminAuditLog.findMany).not.toHaveBeenCalled();
  });

  it('pages', async () => {
    mockGetSession.mockResolvedValue(session('USER', ORG_A));
    memberOf(ORG_OWNER_ROLE);

    const json = await body(await get(ORG_A, 'page=2&limit=2'));

    expect(json.data.map((e: { id: string }) => e.id)).toEqual(['a3']);
    expect(json.meta).toEqual(expect.objectContaining({ total: 3, page: 2, limit: 2 }));
  });

  it('refuses an admin-scoped API key, which the policy alone would admit', async () => {
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
    memberOf(ORG_OWNER_ROLE);

    const res = await get(ORG_A, '', {
      authorization: 'Bearer sk_deadbeefdeadbeefdeadbeefdeadbeef',
    });

    expect(res.status).toBe(403);
    expect(mockDb.aiAdminAuditLog.findMany).not.toHaveBeenCalled();
    expect(mockLog.warn).toHaveBeenCalledWith(
      'Rejected API-key attempt to read an org audit log',
      expect.anything()
    );
  });
});

describe('GET — at TENANCY_MODE=single', () => {
  it('lets the install org’s admin read the install org’s history', async () => {
    mockEnv.TENANCY_MODE = 'single';
    mockGetSession.mockResolvedValue(session(PLATFORM_ADMIN_ROLE, null));
    memberOf(ORG_OWNER_ROLE);

    const res = await get(INSTALL_ORG_ID);

    expect(res.status).toBe(200);
    expect(mockDb.aiAdminAuditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { actingOrgId: INSTALL_ORG_ID } })
    );
  });
});
