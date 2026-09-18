/**
 * Unit Tests: PATCH/DELETE /api/v1/orgs/[id]/members/[userId] (§106 t-672)
 *
 * Same harness as the sibling members route: real guard, real policy, real
 * entry, real resolver; the lifecycle writes mocked at the module. Pins that
 * the handler hands the lifecycle the URL's org and user (never a body's),
 * that a lifecycle refusal — the last-OWNER guard — reaches the client with
 * its own status and code, and that a MEMBER and an API key are refused.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import { DEFAULT_ORG_ROLE, ORG_ADMIN_ROLE, ORG_OWNER_ROLE } from '@/lib/tenancy/roles';

const mockEnv = vi.hoisted(() => ({ TENANCY_MODE: 'single' }));
vi.mock('@/lib/env', () => ({ env: mockEnv }));

const mockGetSession = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: mockGetSession } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    org: { findUnique: vi.fn() },
    orgMembership: { findUnique: vi.fn() },
    aiApiKey: { findFirst: vi.fn(), update: vi.fn() },
  },
}));

const lifecycle = vi.hoisted(() => ({ changeMemberRole: vi.fn(), removeMember: vi.fn() }));
vi.mock('@/lib/tenancy/lifecycle', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tenancy/lifecycle')>()),
  ...lifecycle,
}));

const mockLog = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock('@/lib/api/context', () => ({ getRouteLogger: vi.fn(async () => mockLog) }));
vi.mock('@/lib/logging', () => ({ logger: mockLog }));

import { PATCH, DELETE } from '@/app/api/v1/orgs/[id]/members/[userId]/route';
import { OrgLifecycleError } from '@/lib/tenancy/lifecycle';
import { prisma } from '@/lib/db/client';
import { createMockAuthSession } from '@/tests/helpers/auth';

const ORG = 'cmorg000000000000000other';
const USER_ID = 'cmjbv4i3x00003wsloputgwul';
const TARGET = 'cmjbv4i3x00005wsloputgwuy';

function session(role: 'USER' | 'ADMIN', activeOrgId: string | null) {
  const base = createMockAuthSession();
  return { session: { ...base.session, activeOrgId }, user: { ...base.user, role } };
}

function memberOf(role: string) {
  vi.mocked(prisma.orgMembership.findUnique).mockResolvedValue({
    role,
    org: { status: 'ACTIVE' },
  } as never);
}

const params = (userId = TARGET) => ({ params: Promise.resolve({ id: ORG, userId }) });

function patch(body: unknown, headers: Record<string, string> = {}, userId = TARGET) {
  const request = new Request(`http://localhost/api/v1/orgs/${ORG}/members/${userId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
  return PATCH(request, params(userId));
}

function del(headers: Record<string, string> = {}, userId = TARGET) {
  const request = new Request(`http://localhost/api/v1/orgs/${ORG}/members/${userId}`, {
    method: 'DELETE',
    headers,
  }) as unknown as NextRequest;
  return DELETE(request, params(userId));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEnv.TENANCY_MODE = 'single';
  vi.mocked(prisma.aiApiKey.findFirst).mockResolvedValue(null);
  vi.mocked(prisma.org.findUnique).mockResolvedValue({ id: ORG } as never);
  mockGetSession.mockResolvedValue(session('USER', ORG));
  memberOf(ORG_ADMIN_ROLE);
  lifecycle.changeMemberRole.mockResolvedValue({
    id: 'm2',
    orgId: ORG,
    userId: TARGET,
    role: ORG_ADMIN_ROLE,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  lifecycle.removeMember.mockResolvedValue({ revokedSessions: 1 });
});

describe('PATCH /api/v1/orgs/[id]/members/[userId]', () => {
  it('changes the role through the lifecycle, keyed on the URL', async () => {
    const res = await patch({ role: ORG_ADMIN_ROLE });
    const json = JSON.parse(await res.text());

    expect(res.status).toBe(200);
    expect(json.data.role).toBe(ORG_ADMIN_ROLE);
    expect(lifecycle.changeMemberRole).toHaveBeenCalledWith(ORG, TARGET, ORG_ADMIN_ROLE, {
      platformAdmin: false,
      orgRole: ORG_ADMIN_ROLE,
    });
  });

  it('surfaces the owner-standing refusal as a 403 with its code — an ADMIN cannot crown themself', async () => {
    lifecycle.changeMemberRole.mockRejectedValue(
      new OrgLifecycleError('OWNER_STANDING', 'Only an owner may make a member an owner')
    );
    const res = await patch({ role: ORG_OWNER_ROLE }, {}, USER_ID);
    const json = JSON.parse(await res.text());
    expect(res.status).toBe(403);
    expect(json.error.code).toBe('OWNER_STANDING');
    // The lifecycle was told the caller is an ADMIN, which is what it refused on.
    expect(lifecycle.changeMemberRole).toHaveBeenCalledWith(
      ORG,
      USER_ID,
      ORG_OWNER_ROLE,
      expect.objectContaining({ platformAdmin: false, orgRole: ORG_ADMIN_ROLE })
    );
  });

  it('surfaces the last-OWNER refusal as a 400 with its code', async () => {
    lifecycle.changeMemberRole.mockRejectedValue(
      new OrgLifecycleError('LAST_OWNER', 'Cannot demote the last owner.')
    );

    const res = await patch({ role: DEFAULT_ORG_ROLE });
    const json = JSON.parse(await res.text());

    expect(res.status).toBe(400);
    expect(json.error.code).toBe('LAST_OWNER');
    expect(json.error.message).toMatch(/last owner/i);
  });

  it('refuses a MEMBER without touching the lifecycle', async () => {
    memberOf(DEFAULT_ORG_ROLE);
    const res = await patch({ role: ORG_OWNER_ROLE });
    expect(res.status).toBe(403);
    expect(lifecycle.changeMemberRole).not.toHaveBeenCalled();
  });

  it.each([[{}], [{ role: 'ROOT' }], [{ role: '' }]])(
    'rejects a malformed body %j',
    async (body) => {
      const res = await patch(body);
      expect(res.status).toBe(400);
      expect(lifecycle.changeMemberRole).not.toHaveBeenCalled();
    }
  );

  it('rejects a user id that is not a cuid before writing', async () => {
    const res = await patch({ role: ORG_ADMIN_ROLE }, {}, 'not-a-cuid');
    expect(res.status).toBe(400);
    expect(lifecycle.changeMemberRole).not.toHaveBeenCalled();
  });

  it('refuses an API-key caller', async () => {
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
        role: 'ADMIN',
        accountType: 'HUMAN',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    } as never);

    const res = await patch(
      { role: ORG_ADMIN_ROLE },
      { authorization: 'Bearer sk_deadbeefdeadbeefdeadbeefdeadbeef' }
    );

    expect(res.status).toBe(403);
    expect(lifecycle.changeMemberRole).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/v1/orgs/[id]/members/[userId]', () => {
  it('removes the member through the lifecycle and reports the revoked sessions', async () => {
    const res = await del();
    const json = JSON.parse(await res.text());

    expect(res.status).toBe(200);
    expect(json.data).toEqual({ orgId: ORG, userId: TARGET, removed: true, revokedSessions: 1 });
    expect(lifecycle.removeMember).toHaveBeenCalledWith(ORG, TARGET, {
      platformAdmin: false,
      orgRole: ORG_ADMIN_ROLE,
    });
  });

  it('surfaces the last-OWNER refusal', async () => {
    lifecycle.removeMember.mockRejectedValue(
      new OrgLifecycleError('LAST_OWNER', 'Cannot remove the last owner.')
    );
    const res = await del();
    expect(res.status).toBe(400);
    expect(JSON.parse(await res.text()).error.code).toBe('LAST_OWNER');
  });

  it('surfaces a non-member as a 404 — inside an org you administer, that is not enumeration', async () => {
    lifecycle.removeMember.mockRejectedValue(
      new OrgLifecycleError('NOT_A_MEMBER', 'Member not found')
    );
    expect((await del()).status).toBe(404);
  });

  it('refuses a MEMBER, and a platform-admin-less non-member, without touching the lifecycle', async () => {
    memberOf(DEFAULT_ORG_ROLE);
    expect((await del()).status).toBe(403);

    vi.mocked(prisma.orgMembership.findUnique).mockResolvedValue(null);
    expect((await del()).status).toBe(403);

    expect(lifecycle.removeMember).not.toHaveBeenCalled();
  });

  it('returns 401 without a session', async () => {
    mockGetSession.mockResolvedValue(null);
    expect((await del()).status).toBe(401);
  });
});
