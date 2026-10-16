/**
 * Unit Tests: /api/v1/orgs/[id]/support-grants (§121 t-823)
 *
 * Runs the REAL `withAuth`, the REAL default policy, the REAL entry rule, the
 * REAL `resolveOrgResource` and the REAL grant rules
 * (`lib/tenancy/support-grants.ts`), with Prisma mocked at the delegates. Who
 * reaches a handler is the policy's decision, and who may *grant* is the
 * grant rules' — both are under test, so neither is mocked.
 *
 * The case that matters most is the vendor: a platform admin is admitted to
 * every org's routes, and in the install org their role is OWNER. They may
 * read and revoke an org's grants. They may not grant one, and the refusal is
 * asserted to reach no write.
 *
 * `TENANCY_MODE=multi` unless a case says otherwise, so the guard reads and
 * verifies the membership on every request (`memberOf` arms that read).
 */
import { Prisma } from '@prisma/client';
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

const mockDb = vi.hoisted(() => {
  const db = {
    org: { findUnique: vi.fn() },
    orgMembership: { findUnique: vi.fn() },
    aiApiKey: { findFirst: vi.fn(), update: vi.fn() },
    orgSupportGrant: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
    },
    $transaction: vi.fn(),
  };
  return db;
});
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

import { GET, POST } from '@/app/api/v1/orgs/[id]/support-grants/route';
import { DELETE } from '@/app/api/v1/orgs/[id]/support-grants/[grantId]/route';
import { createMockAuthSession } from '@/tests/helpers/auth';

const ORG = 'cmorg000000000000000other';
const ELSEWHERE = 'cmorg00000000000000elsewh';
const GRANT = 'cmgrant00000000000000one';
const USER_ID = 'cmjbv4i3x00003wsloputgwul';

function session(role: 'USER' | 'ADMIN', activeOrgId: string | null) {
  const base = createMockAuthSession();
  return {
    session: { ...base.session, activeOrgId },
    user: { ...base.user, role },
  };
}

/** The guard's membership read: this role in whichever org the session names. */
function memberOf(role: string) {
  mockDb.orgMembership.findUnique.mockResolvedValue({ role, org: { status: 'ACTIVE' } });
}

const grantRow = (over: Partial<{ revokedAt: Date | null; expiresAt: Date }> = {}) => ({
  id: GRANT,
  orgId: ORG,
  level: 'ADMIN',
  reason: 'Ticket 42',
  expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  createdAt: new Date(),
  revokedAt: null,
  grantedBy: { id: USER_ID, name: 'Test User' },
  revokedBy: null,
  ...over,
});

const params = (id = ORG) => ({ params: Promise.resolve({ id }) });

function get(orgId = ORG, headers: Record<string, string> = {}) {
  const request = new Request(`http://localhost/api/v1/orgs/${orgId}/support-grants`, {
    headers,
  }) as unknown as NextRequest;
  return GET(request, params(orgId));
}

function post(body: unknown, orgId = ORG, headers: Record<string, string> = {}) {
  const request = new Request(`http://localhost/api/v1/orgs/${orgId}/support-grants`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
  return POST(request, params(orgId));
}

function del(orgId = ORG, grantId = GRANT, headers: Record<string, string> = {}) {
  const request = new Request(`http://localhost/api/v1/orgs/${orgId}/support-grants/${grantId}`, {
    method: 'DELETE',
    headers,
  }) as unknown as NextRequest;
  return DELETE(request, { params: Promise.resolve({ id: orgId, grantId }) });
}

async function body(res: Response) {
  return JSON.parse(await res.text());
}

function expectNoGrantWritten() {
  expect(mockDb.orgSupportGrant.create).not.toHaveBeenCalled();
  expect(mockDb.orgSupportGrant.updateMany).not.toHaveBeenCalled();
  expect(mockAudit).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEnv.TENANCY_MODE = 'multi';
  mockDb.aiApiKey.findFirst.mockResolvedValue(null);
  // One row serves the resolver (`id`), the grant rule (`status`) and the
  // audit entry (`name`).
  mockDb.org.findUnique.mockResolvedValue({ id: ORG, status: 'ACTIVE', name: 'Acme' });
  mockDb.$transaction.mockImplementation(async (fn: (tx: typeof mockDb) => unknown) => fn(mockDb));
  mockDb.orgSupportGrant.findMany.mockResolvedValue([]);
  mockDb.orgSupportGrant.create.mockResolvedValue(grantRow());
});

describe('POST — granting', () => {
  it('lets an OWNER acting in the org grant, as themselves, and audits it', async () => {
    mockGetSession.mockResolvedValue(session('USER', ORG));
    memberOf(ORG_OWNER_ROLE);

    const res = await post({ reason: 'Ticket 42', level: 'READ_ONLY', durationHours: 4 });
    const json = await body(res);

    expect(res.status).toBe(201);
    expect(json.data.grant).toEqual(expect.objectContaining({ id: GRANT, open: true }));
    expect(mockDb.orgSupportGrant.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          orgId: ORG,
          level: 'READ_ONLY',
          reason: 'Ticket 42',
          grantedById: USER_ID,
        }),
      })
    );
    expect(mockAudit).toHaveBeenCalledTimes(1);
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER_ID,
        action: 'support_grant.create',
        entityType: 'support_grant',
        entityId: GRANT,
        entityName: 'Acme',
        metadata: expect.objectContaining({ orgId: ORG, reason: 'Ticket 42' }),
      })
    );
  });

  it('audits the replaced grant as well as the new one', async () => {
    mockGetSession.mockResolvedValue(session('USER', ORG));
    memberOf(ORG_OWNER_ROLE);
    mockDb.orgSupportGrant.findMany.mockResolvedValue([{ id: 'cmgrant0000000000000older' }]);
    mockDb.orgSupportGrant.updateMany.mockResolvedValue({ count: 1 });

    const res = await post({ reason: 'New ticket' });

    expect(res.status).toBe(201);
    expect((await body(res)).data.replacedGrantIds).toEqual(['cmgrant0000000000000older']);
    expect(mockAudit.mock.calls.map(([entry]) => [entry.action, entry.entityId])).toEqual([
      ['support_grant.replace', 'cmgrant0000000000000older'],
      ['support_grant.create', GRANT],
    ]);
  });

  it('audits every open grant the replacement revoked, not only the first', async () => {
    mockGetSession.mockResolvedValue(session('USER', ORG));
    memberOf(ORG_OWNER_ROLE);
    mockDb.orgSupportGrant.findMany.mockResolvedValue([
      { id: 'cmgrant0000000000000older' },
      { id: 'cmgrant000000000000oldest' },
    ]);
    mockDb.orgSupportGrant.updateMany.mockResolvedValue({ count: 2 });

    const res = await post({ reason: 'New ticket' });

    expect(res.status).toBe(201);
    expect(mockAudit.mock.calls.map(([entry]) => [entry.action, entry.entityId])).toEqual([
      ['support_grant.replace', 'cmgrant0000000000000older'],
      ['support_grant.replace', 'cmgrant000000000000oldest'],
      ['support_grant.create', GRANT],
    ]);
  });

  it('answers 409 when a concurrent grant for the org won the transaction, and audits nothing', async () => {
    mockGetSession.mockResolvedValue(session('USER', ORG));
    memberOf(ORG_OWNER_ROLE);
    mockDb.$transaction.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('could not serialize access', {
        code: 'P2034',
        clientVersion: 'test',
      })
    );

    const res = await post({ reason: 'Ticket 42' });

    expect(res.status).toBe(409);
    expect((await body(res)).error.code).toBe('GRANT_CONFLICT');
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('refuses an ADMIN of the org: granting is an owner’s act', async () => {
    mockGetSession.mockResolvedValue(session('USER', ORG));
    memberOf(ORG_ADMIN_ROLE);

    const res = await post({ reason: 'Ticket 42' });

    expect(res.status).toBe(403);
    expect((await body(res)).error.code).toBe('OWNER_REQUIRED');
    expectNoGrantWritten();
  });

  it('refuses a platform admin acting in the install org, where their role is OWNER', async () => {
    mockGetSession.mockResolvedValue(session(PLATFORM_ADMIN_ROLE, INSTALL_ORG_ID));
    memberOf(ORG_OWNER_ROLE);

    const res = await post({ reason: 'Let ourselves in' });

    expect(res.status).toBe(403);
    expect((await body(res)).error.code).toBe('OWNER_REQUIRED');
    expectNoGrantWritten();
  });

  it('refuses a MEMBER, and an OWNER acting in another org, at the policy', async () => {
    mockGetSession.mockResolvedValue(session('USER', ORG));
    memberOf(DEFAULT_ORG_ROLE);
    expect((await post({ reason: 'x' })).status).toBe(403);

    mockGetSession.mockResolvedValue(session('USER', ELSEWHERE));
    memberOf(ORG_OWNER_ROLE);
    expect((await post({ reason: 'x' })).status).toBe(403);

    expectNoGrantWritten();
  });

  it('refuses at single, before any write', async () => {
    mockEnv.TENANCY_MODE = 'single';
    mockGetSession.mockResolvedValue(session('USER', ORG));
    memberOf(ORG_OWNER_ROLE);

    const res = await post({ reason: 'Ticket 42' });

    expect(res.status).toBe(400);
    expect((await body(res)).error.code).toBe('SUPPORT_NOT_AVAILABLE');
    expectNoGrantWritten();
  });

  it('refuses a body with no reason, or a duration past the bound', async () => {
    mockGetSession.mockResolvedValue(session('USER', ORG));
    memberOf(ORG_OWNER_ROLE);

    expect((await post({ reason: '   ' })).status).toBe(400);
    expect((await post({ reason: 'x', durationHours: 7 * 24 + 1 })).status).toBe(400);
    expect((await post({ reason: 'x', level: 'OWNER' })).status).toBe(400);
    expectNoGrantWritten();
  });
});

describe('GET — reading', () => {
  it('lists the org’s grants for an ADMIN acting in it', async () => {
    mockGetSession.mockResolvedValue(session('USER', ORG));
    memberOf(ORG_ADMIN_ROLE);
    mockDb.orgSupportGrant.findMany.mockResolvedValue([grantRow()]);

    const res = await get();
    const json = await body(res);

    expect(res.status).toBe(200);
    expect(json.data.orgId).toBe(ORG);
    expect(json.data.grants).toEqual([expect.objectContaining({ id: GRANT, open: true })]);
    expect(mockDb.orgSupportGrant.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { orgId: ORG } })
    );
  });

  it('lets a platform admin read them from the install org', async () => {
    mockGetSession.mockResolvedValue(session(PLATFORM_ADMIN_ROLE, INSTALL_ORG_ID));
    memberOf(ORG_OWNER_ROLE);
    expect((await get()).status).toBe(200);
  });

  it('refuses a MEMBER', async () => {
    mockGetSession.mockResolvedValue(session('USER', ORG));
    memberOf(DEFAULT_ORG_ROLE);
    expect((await get()).status).toBe(403);
    expect(mockDb.orgSupportGrant.findMany).not.toHaveBeenCalled();
  });
});

describe('DELETE — revoking', () => {
  it('lets an ADMIN of the org revoke the open grant, and audits it', async () => {
    mockGetSession.mockResolvedValue(session('USER', ORG));
    memberOf(ORG_ADMIN_ROLE);
    mockDb.orgSupportGrant.updateMany.mockResolvedValue({ count: 1 });
    mockDb.orgSupportGrant.findFirst.mockResolvedValue(grantRow({ revokedAt: new Date() }));

    const res = await del();
    const json = await body(res);

    expect(res.status).toBe(200);
    expect(json.data.revoked).toBe(true);
    expect(json.data.grant.open).toBe(false);
    expect(mockDb.orgSupportGrant.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: GRANT, orgId: ORG }),
        data: expect.objectContaining({ revokedById: USER_ID }),
      })
    );
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'support_grant.revoke', entityId: GRANT })
    );
  });

  it('lets a platform admin revoke: ending access is always safe', async () => {
    mockGetSession.mockResolvedValue(session(PLATFORM_ADMIN_ROLE, INSTALL_ORG_ID));
    memberOf(ORG_OWNER_ROLE);
    mockDb.orgSupportGrant.updateMany.mockResolvedValue({ count: 1 });
    mockDb.orgSupportGrant.findFirst.mockResolvedValue(grantRow({ revokedAt: new Date() }));

    expect((await del()).status).toBe(200);
  });

  it('answers an already-ended grant without writing or auditing', async () => {
    mockGetSession.mockResolvedValue(session('USER', ORG));
    memberOf(ORG_OWNER_ROLE);
    mockDb.orgSupportGrant.updateMany.mockResolvedValue({ count: 0 });
    mockDb.orgSupportGrant.findFirst.mockResolvedValue(grantRow({ revokedAt: new Date() }));

    const res = await del();

    expect(res.status).toBe(200);
    expect((await body(res)).data.revoked).toBe(false);
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('does not find another org’s grant', async () => {
    mockGetSession.mockResolvedValue(session('USER', ORG));
    memberOf(ORG_OWNER_ROLE);
    mockDb.orgSupportGrant.updateMany.mockResolvedValue({ count: 0 });
    mockDb.orgSupportGrant.findFirst.mockResolvedValue(null);

    const res = await del();

    expect(res.status).toBe(404);
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('refuses a MEMBER at the policy', async () => {
    mockGetSession.mockResolvedValue(session('USER', ORG));
    memberOf(DEFAULT_ORG_ROLE);
    expect((await del()).status).toBe(403);
    expect(mockDb.orgSupportGrant.updateMany).not.toHaveBeenCalled();
  });
});

describe('credentials and the audit entry', () => {
  const BEARER = { authorization: 'Bearer sk_deadbeefdeadbeefdeadbeefdeadbeef' };

  /**
   * An `admin`-scoped key minted by a platform admin: the policy admits it to
   * every org's routes, so it is the key the routes themselves must refuse.
   */
  function adminKey() {
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
  }

  it('refuses an admin-scoped API key on every route: consent is a person’s act', async () => {
    adminKey();

    expect((await get(ORG, BEARER)).status).toBe(403);
    expect((await post({ reason: 'x' }, ORG, BEARER)).status).toBe(403);
    expect((await del(ORG, GRANT, BEARER)).status).toBe(403);

    expect(mockDb.orgSupportGrant.findMany).not.toHaveBeenCalled();
    expectNoGrantWritten();
  });

  it('still audits a grant and a revocation when the org’s name cannot be read', async () => {
    mockGetSession.mockResolvedValue(session('USER', ORG));
    memberOf(ORG_OWNER_ROLE);
    // Resolver, then the grant rule's status read, then the audit's name read.
    mockDb.org.findUnique
      .mockResolvedValueOnce({ id: ORG })
      .mockResolvedValueOnce({ status: 'ACTIVE' })
      .mockResolvedValueOnce(null);

    expect((await post({ reason: 'Ticket 42' })).status).toBe(201);
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'support_grant.create', entityName: null })
    );

    mockDb.org.findUnique.mockResolvedValueOnce({ id: ORG }).mockResolvedValueOnce(null);
    mockDb.orgSupportGrant.updateMany.mockResolvedValue({ count: 1 });
    mockDb.orgSupportGrant.findFirst.mockResolvedValue(grantRow({ revokedAt: new Date() }));

    expect((await del()).status).toBe(200);
    expect(mockAudit).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: 'support_grant.revoke', entityName: null })
    );
  });
});
