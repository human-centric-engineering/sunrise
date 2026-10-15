/**
 * Unit Tests: POST /api/v1/orgs/[id]/invitations (§111 t-813)
 *
 * Runs the REAL `withAuth`, default policy, entry rule, `resolveOrgResource`
 * and `checkInvitationInto`, with Prisma mocked at the delegates. The token
 * store, mailer and invite limiter are mocked at the module edge.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import { DEFAULT_ORG_ROLE, ORG_ADMIN_ROLE, ORG_OWNER_ROLE } from '@/lib/tenancy/roles';
import { PLATFORM_ADMIN_ROLE } from '@/lib/auth/roles';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';

const mockEnv = vi.hoisted(() => ({
  TENANCY_MODE: 'single',
  NEXT_PUBLIC_APP_URL: 'http://app.test',
}));
vi.mock('@/lib/env', () => ({ env: mockEnv }));

const mockGetSession = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: mockGetSession } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    org: { findUnique: vi.fn() },
    orgMembership: { findUnique: vi.fn(), findMany: vi.fn() },
    aiApiKey: { findFirst: vi.fn(), update: vi.fn() },
    verification: { count: vi.fn() },
  },
}));

vi.mock('@/lib/utils/invitation-token', () => ({
  generateInvitationToken: vi.fn(),
  updateInvitationToken: vi.fn(),
  getValidInvitation: vi.fn(),
  INVITATION_IDENTIFIER_PREFIX: 'invitation:',
}));
vi.mock('@/lib/email/send', () => ({ sendEmail: vi.fn() }));
vi.mock('@/lib/email/registry', () => ({ resolveEmailTemplate: vi.fn(() => null) }));
vi.mock('@/lib/security/rate-limit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/security/rate-limit')>();
  return { ...actual, inviteLimiter: { check: vi.fn() } };
});
vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '127.0.0.1') }));

const mockLog = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock('@/lib/api/context', () => ({ getRouteLogger: vi.fn(async () => mockLog) }));
vi.mock('@/lib/logging', () => ({ logger: mockLog }));

import { POST } from '@/app/api/v1/orgs/[id]/invitations/route';
import { prisma } from '@/lib/db/client';
import {
  generateInvitationToken,
  getValidInvitation,
  updateInvitationToken,
} from '@/lib/utils/invitation-token';
import { sendEmail } from '@/lib/email/send';
import { inviteLimiter } from '@/lib/security/rate-limit';
import { createMockAuthSession } from '@/tests/helpers/auth';

const ORG = 'cmorg000000000000000other';
const OTHER_ORG = 'cmorg0000000000000000org2';
const USER_ID = 'cmjbv4i3x00003wsloputgwul';
const invitee = { name: 'Jane Doe', email: 'jane@example.com' };

function session(role: 'USER' | 'ADMIN', activeOrgId: string | null) {
  const base = createMockAuthSession();
  return {
    session: { ...base.session, activeOrgId },
    user: { ...base.user, role },
  };
}

function memberOf(role: string) {
  vi.mocked(prisma.orgMembership.findUnique).mockResolvedValue({
    role,
    org: { status: 'ACTIVE' },
  } as never);
}

function post(body: unknown, orgId = ORG, query = '', headers: Record<string, string> = {}) {
  const request = new Request(`http://localhost/api/v1/orgs/${orgId}/invitations${query}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
  return POST(request, { params: Promise.resolve({ id: orgId }) });
}

const json = async (res: Response) => JSON.parse(await res.text());

function writtenMetadata() {
  return vi.mocked(generateInvitationToken).mock.calls[0]?.[1];
}

function pending(metadata: Record<string, unknown>) {
  vi.mocked(getValidInvitation).mockResolvedValue({
    expiresAt: new Date('2026-12-01T00:00:00.000Z'),
    metadata: {
      name: 'Jane Doe',
      role: 'USER',
      invitedBy: USER_ID,
      invitedAt: '2026-10-01T00:00:00.000Z',
      ...metadata,
    },
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEnv.TENANCY_MODE = 'single';
  vi.mocked(prisma.aiApiKey.findFirst).mockResolvedValue(null);
  vi.mocked(prisma.user.findUnique).mockResolvedValue(null);
  vi.mocked(prisma.org.findUnique).mockResolvedValue({ id: ORG, status: 'ACTIVE' } as never);
  vi.mocked(getValidInvitation).mockResolvedValue(null);
  vi.mocked(prisma.verification.count).mockResolvedValue(0);
  vi.mocked(generateInvitationToken).mockResolvedValue('tok-new');
  vi.mocked(updateInvitationToken).mockResolvedValue('tok-re');
  vi.mocked(sendEmail).mockResolvedValue({ success: true, status: 'sent', id: 'e1' });
  vi.mocked(inviteLimiter.check).mockReturnValue({
    success: true,
    remaining: 9,
    reset: 0,
  } as never);
});

describe('POST /api/v1/orgs/[id]/invitations — admission', () => {
  it('lets an org ADMIN invite into the org: platform role USER, orgId from the URL, orgRole as sent', async () => {
    mockGetSession.mockResolvedValue(session('USER', ORG));
    memberOf(ORG_ADMIN_ROLE);

    const res = await post({ ...invitee, orgRole: ORG_ADMIN_ROLE });
    const body = await json(res);

    expect(res.status).toBe(201);
    expect(writtenMetadata()).toMatchObject({
      role: 'USER',
      orgId: ORG,
      orgRole: ORG_ADMIN_ROLE,
      name: 'Jane Doe',
    });
    expect(body.data.invitation).toMatchObject({ orgId: ORG, orgRole: ORG_ADMIN_ROLE });
    // The token goes to the invitee by email only: an inviter holding it could
    // accept in the invitee's place and get a verified account for their address.
    expect(body.data.invitation).not.toHaveProperty('link');
    expect(JSON.stringify(body)).not.toContain('tok-new');
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: 'jane@example.com' }));
    expect(body.data.emailStatus).toBe('sent');
  });

  it('omits orgRole from the stored metadata when none was sent', async () => {
    mockGetSession.mockResolvedValue(session('USER', ORG));
    memberOf(ORG_ADMIN_ROLE);

    await post(invitee);

    expect(writtenMetadata()).not.toHaveProperty('orgRole');
    expect(writtenMetadata()).toMatchObject({ role: 'USER', orgId: ORG });
  });

  it('ignores a platform role in the body — the invitee is always a USER', async () => {
    mockGetSession.mockResolvedValue(session('USER', ORG));
    memberOf(ORG_ADMIN_ROLE);

    const res = await post({ ...invitee, role: 'ADMIN' });

    expect(res.status).toBe(201);
    expect(writtenMetadata()).toMatchObject({ role: 'USER' });
  });

  it('ignores an orgId in the body — the URL decides the org', async () => {
    mockGetSession.mockResolvedValue(session('USER', ORG));
    memberOf(ORG_ADMIN_ROLE);

    await post({ ...invitee, orgId: OTHER_ORG });

    expect(writtenMetadata()).toMatchObject({ orgId: ORG });
  });

  it('lets an org OWNER invite another OWNER', async () => {
    mockGetSession.mockResolvedValue(session('USER', ORG));
    memberOf(ORG_OWNER_ROLE);

    const res = await post({ ...invitee, orgRole: ORG_OWNER_ROLE });

    expect(res.status).toBe(201);
    expect(writtenMetadata()).toMatchObject({ orgRole: ORG_OWNER_ROLE });
  });

  it('refuses an org ADMIN inviting an OWNER with OWNER_STANDING, writing nothing', async () => {
    mockGetSession.mockResolvedValue(session('USER', ORG));
    memberOf(ORG_ADMIN_ROLE);

    const res = await post({ ...invitee, orgRole: ORG_OWNER_ROLE });

    expect(res.status).toBe(403);
    expect((await json(res)).error.code).toBe('OWNER_STANDING');
    expect(generateInvitationToken).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('refuses a MEMBER of the org', async () => {
    mockGetSession.mockResolvedValue(session('USER', ORG));
    memberOf(DEFAULT_ORG_ROLE);

    const res = await post(invitee);

    expect(res.status).toBe(403);
    expect(generateInvitationToken).not.toHaveBeenCalled();
  });

  it('refuses an ADMIN of org A who names org B in the URL', async () => {
    mockGetSession.mockResolvedValue(session('USER', OTHER_ORG));
    memberOf(ORG_ADMIN_ROLE);

    const res = await post(invitee, ORG);

    expect(res.status).toBe(403);
    expect(generateInvitationToken).not.toHaveBeenCalled();
    expect(updateInvitationToken).not.toHaveBeenCalled();
  });

  it('returns 401 without a session', async () => {
    mockGetSession.mockResolvedValue(null);
    expect((await post(invitee)).status).toBe(401);
  });

  it('refuses an API-key caller even if the policy admits the key', async () => {
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

    const res = await post(invitee, ORG, '', {
      authorization: 'Bearer sk_deadbeefdeadbeefdeadbeefdeadbeef',
    });

    expect(res.status).toBe(403);
    expect((await json(res)).error.message).toMatch(/browser session/);
    expect(generateInvitationToken).not.toHaveBeenCalled();
  });
});

describe('POST /api/v1/orgs/[id]/invitations — org rules', () => {
  it('refuses the install org with INSTALL_ORG_MEMBERSHIP for a platform admin', async () => {
    mockGetSession.mockResolvedValue(session(PLATFORM_ADMIN_ROLE, null));
    vi.mocked(prisma.org.findUnique).mockResolvedValue({ id: INSTALL_ORG_ID } as never);

    const res = await post(invitee, INSTALL_ORG_ID);

    expect(res.status).toBe(400);
    expect((await json(res)).error.code).toBe('INSTALL_ORG_MEMBERSHIP');
    expect(generateInvitationToken).not.toHaveBeenCalled();
  });

  it('refuses a suspended org with ORG_NOT_ACTIVE for a platform admin', async () => {
    mockGetSession.mockResolvedValue(session(PLATFORM_ADMIN_ROLE, null));
    vi.mocked(prisma.org.findUnique).mockResolvedValue({ id: ORG, status: 'SUSPENDED' } as never);

    const res = await post(invitee);

    expect(res.status).toBe(400);
    expect((await json(res)).error.code).toBe('ORG_NOT_ACTIVE');
    expect(generateInvitationToken).not.toHaveBeenCalled();
  });
});

describe('POST /api/v1/orgs/[id]/invitations — existing accounts and invitations', () => {
  beforeEach(() => {
    mockGetSession.mockResolvedValue(session('USER', ORG));
    memberOf(ORG_ADMIN_ROLE);
  });

  it('answers 409 EMAIL_TAKEN for an email that has an account, writing nothing', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'u9' } as never);

    const res = await post(invitee);

    expect(res.status).toBe(409);
    expect((await json(res)).error.code).toBe('EMAIL_TAKEN');
    expect(prisma.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { email: 'jane@example.com' } })
    );
    expect(generateInvitationToken).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it.each([
    ['another org', { orgId: OTHER_ORG }],
    ['no org', {}],
    ['a platform ADMIN role', { orgId: ORG, role: 'ADMIN' }],
  ])(
    'leaves a pending invitation into %s alone and names neither org',
    async (_label, metadata) => {
      pending(metadata);

      const res = await post(invitee, ORG, '?resend=true');
      const text = await res.text();

      expect(res.status).toBe(409);
      expect(JSON.parse(text).error.code).toBe('CONFLICT');
      expect(text).not.toContain(OTHER_ORG);
      expect(generateInvitationToken).not.toHaveBeenCalled();
      expect(updateInvitationToken).not.toHaveBeenCalled();
      expect(sendEmail).not.toHaveBeenCalled();
    }
  );

  it('refuses, rather than replaces, a pending invitation it cannot read', async () => {
    // getValidInvitation answers null for unparseable metadata or a failed
    // read; a row that is still there belongs to someone this route cannot see.
    vi.mocked(getValidInvitation).mockResolvedValue(null);
    vi.mocked(prisma.verification.count).mockResolvedValue(1);

    const res = await post(invitee, ORG, '?resend=true');

    expect(res.status).toBe(409);
    expect((await json(res)).error.code).toBe('CONFLICT');
    expect(prisma.verification.count).toHaveBeenCalledWith({
      where: {
        identifier: 'invitation:jane@example.com',
        expiresAt: { gt: expect.any(Date) },
      },
    });
    expect(generateInvitationToken).not.toHaveBeenCalled();
    expect(updateInvitationToken).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('reports this org’s own pending invitation without writing when not resending', async () => {
    pending({ orgId: ORG, orgRole: ORG_ADMIN_ROLE });

    const res = await post(invitee);
    const body = await json(res);

    expect(res.status).toBe(200);
    expect(body.data.emailStatus).toBe('pending');
    expect(body.data.invitation).toMatchObject({
      orgId: ORG,
      orgRole: ORG_ADMIN_ROLE,
      expiresAt: '2026-12-01T00:00:00.000Z',
    });
    expect(generateInvitationToken).not.toHaveBeenCalled();
    expect(updateInvitationToken).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('replaces the token, rather than generating one, on ?resend=true', async () => {
    pending({ orgId: ORG });

    const res = await post(invitee, ORG, '?resend=true');
    const body = await json(res);

    expect(res.status).toBe(201);
    expect(updateInvitationToken).toHaveBeenCalledWith(
      'jane@example.com',
      expect.objectContaining({ role: 'USER', orgId: ORG })
    );
    expect(generateInvitationToken).not.toHaveBeenCalled();
    expect(JSON.stringify(body)).not.toContain('tok-re');
    expect(body.data.message).toMatch(/resent/);
  });

  it('keeps the pending org role on a resend that names none', async () => {
    pending({ orgId: ORG, orgRole: ORG_ADMIN_ROLE });

    const res = await post(invitee, ORG, '?resend=true');

    expect(res.status).toBe(201);
    expect(updateInvitationToken).toHaveBeenCalledWith(
      'jane@example.com',
      expect.objectContaining({ orgId: ORG, orgRole: ORG_ADMIN_ROLE })
    );
    expect((await json(res)).data.invitation.orgRole).toBe(ORG_ADMIN_ROLE);
  });

  it('refuses an org ADMIN replacing a pending OWNER invitation, whatever role they send', async () => {
    mockGetSession.mockResolvedValue(session('USER', ORG));
    memberOf(ORG_ADMIN_ROLE);
    pending({ orgId: ORG, orgRole: ORG_OWNER_ROLE });

    const res = await post({ ...invitee, orgRole: DEFAULT_ORG_ROLE }, ORG, '?resend=true');

    expect(res.status).toBe(403);
    expect((await json(res)).error.code).toBe('OWNER_STANDING');
    expect(updateInvitationToken).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('lets an org OWNER re-send a pending OWNER invitation', async () => {
    mockGetSession.mockResolvedValue(session('USER', ORG));
    memberOf(ORG_OWNER_ROLE);
    pending({ orgId: ORG, orgRole: ORG_OWNER_ROLE });

    const res = await post(invitee, ORG, '?resend=true');

    expect(res.status).toBe(201);
    expect(updateInvitationToken).toHaveBeenCalledWith(
      'jane@example.com',
      expect.objectContaining({ orgRole: ORG_OWNER_ROLE })
    );
  });
});

describe('POST /api/v1/orgs/[id]/invitations — limits and delivery', () => {
  beforeEach(() => {
    mockGetSession.mockResolvedValue(session('USER', ORG));
    memberOf(ORG_ADMIN_ROLE);
  });

  it('answers 429 when the invite limiter says no, before anything is written', async () => {
    vi.mocked(inviteLimiter.check).mockReturnValue({
      success: false,
      limit: 10,
      remaining: 0,
      reset: Math.floor(Date.now() / 1000) + 60,
    });

    const res = await post(invitee);

    expect(res.status).toBe(429);
    expect(inviteLimiter.check).toHaveBeenCalledWith('127.0.0.1');
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(generateInvitationToken).not.toHaveBeenCalled();
  });

  it('still creates the invitation when the email fails, and still withholds the link', async () => {
    vi.mocked(sendEmail).mockResolvedValue({ success: false, status: 'failed', error: 'down' });

    const res = await post(invitee);
    const body = await json(res);

    expect(res.status).toBe(201);
    expect(body.data.emailStatus).toBe('failed');
    expect(body.data.invitation).not.toHaveProperty('link');
    expect(JSON.stringify(body)).not.toContain('tok-new');
    expect(generateInvitationToken).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ name: '', email: 'a@b.co' }],
    [{ name: 'X', email: 'nope' }],
    [{ name: 'X', email: 'a@b.co', orgRole: 'ROOT' }],
  ])('rejects malformed body %j with 400 before writing', async (bad) => {
    const res = await post(bad);
    expect(res.status).toBe(400);
    expect(generateInvitationToken).not.toHaveBeenCalled();
  });
});
