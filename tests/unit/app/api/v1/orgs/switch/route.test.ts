/**
 * Unit Tests: POST /api/v1/orgs/switch (§106)
 *
 * Runs the REAL `withAuth` — the route's `ownership: 'self'` declaration is
 * part of what is under test (an undeclared route 500s for a narrowed
 * caller), and the API-key refusal is reached through the guard's own key
 * path rather than a stubbed session shape.
 *
 * Coverage:
 * - a member switches: the row is written and the cookie is re-issued from a
 *   `getSession` that bypasses the cookie cache (the 5-minute trap), with its
 *   Set-Cookie headers forwarded
 * - a non-member is refused with the same message whether the org exists or
 *   not (no enumeration)
 * - a suspended org is refused to its own member
 * - an API-key caller is refused before any read
 * - a malformed body is a 400 before any read
 * - unauthenticated is 401
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';

const mockGetSession = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: mockGetSession } },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    orgMembership: { findUnique: vi.fn() },
    session: { update: vi.fn() },
    aiApiKey: { findFirst: vi.fn(), update: vi.fn() },
  },
}));

const mockLog = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock('@/lib/api/context', () => ({
  getRouteLogger: vi.fn(async () => mockLog),
}));

import { POST } from '@/app/api/v1/orgs/switch/route';
import { prisma } from '@/lib/db/client';
import { createMockAuthSession } from '@/tests/helpers/auth';

const USER_ID = 'cmjbv4i3x00003wsloputgwul';
const OTHER_ORG = 'cmorg000000000000000other';

function request(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new Request('http://localhost/api/v1/orgs/switch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

function membershipIn(status: 'ACTIVE' | 'SUSPENDED', id = OTHER_ORG) {
  return { org: { id, slug: 'other', name: 'Other Org', status } };
}

/** What `auth.api.getSession({ asResponse: true })` hands back after a switch. */
function refreshedSessionResponse(cookies: string[]): Response {
  const response = new Response(JSON.stringify({ session: {}, user: {} }), { status: 200 });
  for (const cookie of cookies) response.headers.append('Set-Cookie', cookie);
  return response;
}

describe('POST /api/v1/orgs/switch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.aiApiKey.findFirst).mockResolvedValue(null);
    // The guard's own session lookup (no options) is the first call; the
    // route's cache-bypassing refresh is the second. Distinguished by args.
    mockGetSession.mockImplementation(async (args: { asResponse?: boolean }) =>
      args?.asResponse
        ? refreshedSessionResponse(['better-auth.session_data=refreshed; Path=/; HttpOnly'])
        : createMockAuthSession()
    );
    vi.mocked(prisma.session.update).mockResolvedValue({} as never);
  });

  it('switches a member: writes the row and re-issues the cookie past the cache', async () => {
    vi.mocked(prisma.orgMembership.findUnique).mockResolvedValue(membershipIn('ACTIVE') as never);

    const res = await POST(request({ orgId: OTHER_ORG }));
    const json = JSON.parse(await res.text());

    expect(res.status).toBe(200);
    expect(json.data).toEqual({
      activeOrgId: OTHER_ORG,
      org: { id: OTHER_ORG, slug: 'other', name: 'Other Org' },
    });

    // The membership was looked up for THIS caller, not for a body-supplied user.
    expect(prisma.orgMembership.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { orgId_userId: { orgId: OTHER_ORG, userId: USER_ID } },
      })
    );
    // The caller's own session row.
    expect(prisma.session.update).toHaveBeenCalledWith({
      where: { id: 'session_123' },
      data: { activeOrgId: OTHER_ORG },
    });
    // The cookie cache is what the guards read; a row update alone leaves the
    // old org live for up to five minutes. The refresh must bypass the cache…
    expect(mockGetSession).toHaveBeenCalledWith(
      expect.objectContaining({ query: { disableCookieCache: true }, asResponse: true })
    );
    // …and its cookies must reach the browser.
    expect(res.headers.getSetCookie()).toEqual([
      'better-auth.session_data=refreshed; Path=/; HttpOnly',
    ]);
  });

  it('refuses a non-member, and says the same thing when the org does not exist', async () => {
    vi.mocked(prisma.orgMembership.findUnique).mockResolvedValue(null);

    const notMember = await POST(request({ orgId: OTHER_ORG }));
    const noSuchOrg = await POST(request({ orgId: 'cmorg00000000000000nowhere' }));

    expect(notMember.status).toBe(403);
    expect(noSuchOrg.status).toBe(403);
    const a = JSON.parse(await notMember.text());
    const b = JSON.parse(await noSuchOrg.text());
    expect(a.error.message).toBe(b.error.message);
    expect(a.error.message).not.toMatch(/exist|found/i);
    expect(prisma.session.update).not.toHaveBeenCalled();
  });

  it('refuses a suspended org to its own member, and writes nothing', async () => {
    vi.mocked(prisma.orgMembership.findUnique).mockResolvedValue(
      membershipIn('SUSPENDED') as never
    );

    const res = await POST(request({ orgId: OTHER_ORG }));

    expect(res.status).toBe(403);
    expect(JSON.parse(await res.text()).error.message).toMatch(/suspended/i);
    expect(prisma.session.update).not.toHaveBeenCalled();
    // No refresh either: the only getSession call is the guard's.
    expect(mockGetSession).toHaveBeenCalledTimes(1);
  });

  it('switching to the install org is an ordinary switch', async () => {
    vi.mocked(prisma.orgMembership.findUnique).mockResolvedValue(
      membershipIn('ACTIVE', INSTALL_ORG_ID) as never
    );

    const res = await POST(request({ orgId: INSTALL_ORG_ID }));

    expect(res.status).toBe(200);
    expect(prisma.session.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { activeOrgId: INSTALL_ORG_ID } })
    );
  });

  it('refuses an API-key caller before reading anything', async () => {
    // Through the real `resolveApiKey`: a credential's org is fixed at mint.
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
        email: 'owner@example.com',
        emailVerified: true,
        image: null,
        role: 'USER',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    } as never);

    const res = await POST(
      request({ orgId: OTHER_ORG }, { authorization: 'Bearer sk_deadbeefdeadbeefdeadbeefdeadbeef' })
    );

    expect(res.status).toBe(403);
    expect(prisma.orgMembership.findUnique).not.toHaveBeenCalled();
    expect(prisma.session.update).not.toHaveBeenCalled();
    expect(mockLog.warn).toHaveBeenCalledWith(
      'Rejected API-key attempt to switch org',
      expect.objectContaining({ userId: USER_ID })
    );
  });

  it.each([[{}], [{ orgId: '' }], [{ orgId: 42 }]])(
    'rejects a malformed body %j before reading anything',
    async (body) => {
      const res = await POST(request(body));

      expect(res.status).toBe(400);
      expect(prisma.orgMembership.findUnique).not.toHaveBeenCalled();
    }
  );

  it('returns 401 without a session', async () => {
    mockGetSession.mockResolvedValue(null);

    const res = await POST(request({ orgId: OTHER_ORG }));

    expect(res.status).toBe(401);
  });
});
