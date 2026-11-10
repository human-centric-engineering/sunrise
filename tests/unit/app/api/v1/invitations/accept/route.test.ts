/**
 * Unit Tests: POST /api/v1/invitations/accept (#1199, t-1006)
 *
 * Runs the REAL `withAuth`, so the route's `ownership: 'self'` declaration
 * and the API-key refusal are reached through the guard. The acceptance
 * rules are `acceptInvitationAsExistingUser`'s (its own test file); what is
 * asserted here is that the route hands it the SESSION's identity, never a
 * body-supplied one, and maps its refusals to the envelope.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { APIError } from '@/lib/api/errors';

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

const mockAccept = vi.hoisted(() => vi.fn());
vi.mock('@/lib/tenancy/accept-invitation', () => ({
  acceptInvitationAsExistingUser: mockAccept,
}));

const mockLimiter = vi.hoisted(() => ({ check: vi.fn() }));
vi.mock('@/lib/security/rate-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/security/rate-limit')>()),
  acceptInviteLimiter: mockLimiter,
}));
vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '127.0.0.1') }));

const mockLog = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock('@/lib/api/context', () => ({ getRouteLogger: vi.fn(async () => mockLog) }));

import { POST } from '@/app/api/v1/invitations/accept/route';
import { prisma } from '@/lib/db/client';
import { createMockAuthSession } from '@/tests/helpers/auth';

const USER_ID = 'cmjbv4i3x00003wsloputgwul';
const ORG = 'cmorg000000000000000other';

function post(body: unknown, headers: Record<string, string> = {}) {
  return POST(
    new Request('http://localhost/api/v1/invitations/accept', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }) as unknown as NextRequest
  );
}

const json = async (res: Response) => JSON.parse(await res.text());

describe('POST /api/v1/invitations/accept', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const base = createMockAuthSession();
    mockGetSession.mockResolvedValue({
      session: { ...base.session, activeOrgId: INSTALL_ORG_ID },
      user: { ...base.user, email: 'pat@example.com', emailVerified: true },
    });
    vi.mocked(prisma.aiApiKey.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.orgMembership.findUnique).mockResolvedValue({
      role: 'MEMBER',
      org: { status: 'ACTIVE' },
    } as never);
    mockLimiter.check.mockReturnValue({ success: true, limit: 10, remaining: 9, reset: 0 });
    mockAccept.mockResolvedValue({
      id: 'm1',
      orgId: ORG,
      userId: USER_ID,
      role: 'ADMIN',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  it('accepts as the signed-in account and answers the membership', async () => {
    const res = await post({ token: 'tok', email: 'Pat@Example.com ' });

    expect(res.status).toBe(200);
    expect((await json(res)).data.membership).toEqual({ orgId: ORG, role: 'ADMIN' });
    // The accepter is the session's user; the body only names the invitation
    // (its address normalised as every invitation is stored).
    expect(mockAccept).toHaveBeenCalledWith(
      { id: USER_ID, email: 'pat@example.com', emailVerified: true, role: 'USER' },
      'pat@example.com',
      'tok'
    );
  });

  it('passes a refusal through with its status and code', async () => {
    mockAccept.mockRejectedValue(
      new APIError('sent to a different address', 'INVITATION_WRONG_ACCOUNT', 403)
    );

    const res = await post({ token: 'tok', email: 'pat@example.com' });

    expect(res.status).toBe(403);
    expect((await json(res)).error.code).toBe('INVITATION_WRONG_ACCOUNT');
  });

  it('is rate limited per IP before reading the body', async () => {
    mockLimiter.check.mockReturnValue({ success: false, limit: 10, remaining: 0, reset: 0 });

    const res = await post({ token: 'tok', email: 'pat@example.com' });

    expect(res.status).toBe(429);
    expect(mockAccept).not.toHaveBeenCalled();
  });

  it.each([[{}], [{ token: '', email: 'pat@example.com' }], [{ token: 'tok', email: 'nope' }]])(
    'rejects a malformed body %j',
    async (body) => {
      const res = await post(body);

      expect(res.status).toBe(400);
      expect(mockAccept).not.toHaveBeenCalled();
    }
  );

  it('answers 401 with no session', async () => {
    mockGetSession.mockResolvedValue(null);

    const res = await post({ token: 'tok', email: 'pat@example.com' });

    expect(res.status).toBe(401);
    expect(mockAccept).not.toHaveBeenCalled();
  });

  it('refuses an API-key caller', async () => {
    mockGetSession.mockResolvedValue(null);
    vi.mocked(prisma.aiApiKey.findFirst).mockResolvedValue({
      id: 'cmkey000000000000000key1',
      userId: USER_ID,
      scopes: ['chat'],
      rateLimitRpm: null,
      expiresAt: null,
      createdAt: new Date(),
      user: {
        id: USER_ID,
        name: 'Key Owner',
        email: 'pat@example.com',
        emailVerified: true,
        image: null,
        role: 'USER',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    } as never);

    const res = await post(
      { token: 'tok', email: 'pat@example.com' },
      { authorization: 'Bearer sk_deadbeefdeadbeefdeadbeefdeadbeef' }
    );

    expect(res.status).toBe(403);
    expect(mockAccept).not.toHaveBeenCalled();
  });
});
