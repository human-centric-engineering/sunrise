/**
 * Unit Tests: POST /api/v1/users/invite — the org an invitation names (§106)
 *
 * The route existed long before this file; what it pins is the org axis
 * t-670 added, through the REAL `withAdminAuth` and the REAL default
 * authorization policy:
 *
 * - an invitation without an org writes metadata byte-identical to one
 *   written before the org keys existed (no `orgId`/`orgRole` key at all)
 * - an invitation naming an org writes both keys
 * - the org must exist and be ACTIVE, with one answer for both failures
 * - the policy is asked about the org (`canAdminister` on an org resource):
 *   a platform admin passes today; a policy that says no is a 403
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    org: { findUnique: vi.fn() },
    aiApiKey: { findFirst: vi.fn(), update: vi.fn() },
  },
}));

vi.mock('@/lib/utils/invitation-token', () => ({
  generateInvitationToken: vi.fn(async () => 'raw-token'),
  updateInvitationToken: vi.fn(async () => 'raw-token'),
  getValidInvitation: vi.fn(async () => null),
}));

vi.mock('@/lib/email/send', () => ({
  sendEmail: vi.fn(async () => ({ success: true, status: 'sent', id: 'email-1' })),
}));

vi.mock('@/lib/email/registry', () => ({
  resolveEmailTemplate: vi.fn(() => null),
}));

vi.mock('@/lib/security/rate-limit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/security/rate-limit')>();
  return {
    ...actual,
    inviteLimiter: { check: vi.fn(() => ({ success: true, remaining: 9, reset: 0 })) },
  };
});

vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '127.0.0.1') }));

const mockLog = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock('@/lib/api/context', () => ({ getRouteLogger: vi.fn(async () => mockLog) }));

import { POST } from '@/app/api/v1/users/invite/route';
import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import {
  generateInvitationToken,
  getValidInvitation,
  updateInvitationToken,
} from '@/lib/utils/invitation-token';
import { mockAdminUser, mockAuthenticatedUser } from '@/tests/helpers/auth';
import {
  DEFAULT_AUTHORIZATION_POLICY,
  registerAuthorizationPolicy,
  __resetAuthorizationPolicyForTests,
} from '@/lib/auth/authorization';

const OTHER_ORG = 'cmorg000000000000000other';

function request(body: unknown, query = ''): NextRequest {
  return new Request(`http://localhost/api/v1/users/invite${query}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

const invitee = { name: 'Jane Doe', email: 'jane@example.com' };

describe('POST /api/v1/users/invite — org axis', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiApiKey.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.org.findUnique).mockResolvedValue({
      id: OTHER_ORG,
      status: 'ACTIVE',
    } as never);
  });

  afterEach(() => {
    __resetAuthorizationPolicyForTests();
  });

  function writtenMetadata() {
    const [, metadata] = vi.mocked(generateInvitationToken).mock.calls[0] ?? [];
    return metadata;
  }

  it('writes no org keys at all when none is named (byte-identical to before)', async () => {
    const res = await POST(request({ ...invitee, role: 'USER' }));

    expect(res.status).toBe(201);
    expect(writtenMetadata()).toEqual({
      name: 'Jane Doe',
      role: 'USER',
      invitedBy: expect.any(String),
      invitedAt: expect.any(String),
    });
    expect(writtenMetadata()).not.toHaveProperty('orgId');
    expect(writtenMetadata()).not.toHaveProperty('orgRole');
    // And the org table was never consulted.
    expect(prisma.org.findUnique).not.toHaveBeenCalled();
  });

  it('writes the org and org role it was given', async () => {
    const res = await POST(request({ ...invitee, orgId: OTHER_ORG, orgRole: 'ADMIN' }));

    expect(res.status).toBe(201);
    expect(writtenMetadata()).toMatchObject({ orgId: OTHER_ORG, orgRole: 'ADMIN' });
    expect(prisma.org.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: OTHER_ORG } })
    );
  });

  it('refuses an org that does not exist, and a suspended one, with the same answer', async () => {
    vi.mocked(prisma.org.findUnique).mockResolvedValueOnce(null);
    const missing = await POST(request({ ...invitee, orgId: OTHER_ORG }));

    vi.mocked(prisma.org.findUnique).mockResolvedValueOnce({
      id: OTHER_ORG,
      status: 'SUSPENDED',
    } as never);
    const suspended = await POST(request({ ...invitee, orgId: OTHER_ORG }));

    expect(missing.status).toBe(400);
    expect(suspended.status).toBe(400);
    expect(JSON.parse(await missing.text()).error.message).toBe(
      JSON.parse(await suspended.text()).error.message
    );
    expect(generateInvitationToken).not.toHaveBeenCalled();
  });

  it('asks the authorization policy about the org, and a refusal is a 403', async () => {
    const canAdminister = vi.fn(async () => false);
    registerAuthorizationPolicy({ ...DEFAULT_AUTHORIZATION_POLICY, canAdminister });
    // The admin guard itself asks canAdminister(principal, null) first; let
    // that pass so the refusal under test is the route's own org question.
    canAdminister.mockImplementationOnce(async () => true);

    const res = await POST(request({ ...invitee, orgId: OTHER_ORG }));

    expect(res.status).toBe(403);
    expect(canAdminister).toHaveBeenLastCalledWith(
      expect.objectContaining({ userId: expect.any(String), credential: 'session' }),
      { kind: 'org', id: OTHER_ORG, orgId: OTHER_ORG },
      expect.anything()
    );
    expect(generateInvitationToken).not.toHaveBeenCalled();
  });

  it('echoes the org keys in the created response, null when none was named', async () => {
    const plain = await POST(request({ ...invitee }));
    expect(JSON.parse(await plain.text()).data.invitation).toMatchObject({
      orgId: null,
      orgRole: null,
    });

    const scoped = await POST(request({ ...invitee, orgId: OTHER_ORG, orgRole: 'MEMBER' }));
    expect(JSON.parse(await scoped.text()).data.invitation).toMatchObject({
      orgId: OTHER_ORG,
      orgRole: 'MEMBER',
    });
  });

  it('the "already pending" response says where the pending invitation points', async () => {
    // A resend rewrites the metadata from the body, so an admin has to be
    // able to see the pending org before choosing to overwrite it.
    vi.mocked(getValidInvitation).mockResolvedValueOnce({
      email: invitee.email,
      metadata: {
        name: 'Jane Doe',
        role: 'USER',
        invitedBy: 'admin-1',
        invitedAt: '2026-09-17T00:00:00.000Z',
        orgId: OTHER_ORG,
        orgRole: 'ADMIN',
      },
      expiresAt: new Date(Date.now() + 86400000),
      createdAt: new Date(),
    });

    const res = await POST(request({ ...invitee }));
    const body = JSON.parse(await res.text());

    expect(res.status).toBe(200);
    expect(body.data.emailStatus).toBe('pending');
    expect(body.data.invitation).toMatchObject({ orgId: OTHER_ORG, orgRole: 'ADMIN' });
    expect(generateInvitationToken).not.toHaveBeenCalled();
  });

  it('a legacy pending invitation (no org keys) reports null, not undefined', async () => {
    vi.mocked(getValidInvitation).mockResolvedValueOnce({
      email: invitee.email,
      metadata: {
        name: 'Jane Doe',
        role: 'USER',
        invitedBy: 'admin-1',
        invitedAt: '2026-09-17T00:00:00.000Z',
      },
      expiresAt: new Date(Date.now() + 86400000),
      createdAt: new Date(),
    });

    const res = await POST(request({ ...invitee }));
    const body = JSON.parse(await res.text());

    expect(body.data.invitation).toMatchObject({ orgId: null, orgRole: null });
  });

  describe('resend (?resend=true) re-sends THIS invitation', () => {
    // The admin table's Resend button posts `{ name, email, role }` only, so
    // the pending row's org keys must survive a resend that does not name one.
    function pending(metadata: Record<string, unknown>) {
      vi.mocked(getValidInvitation).mockResolvedValueOnce({
        email: invitee.email,
        metadata: {
          name: 'Jane Doe',
          role: 'USER',
          invitedBy: 'admin-1',
          invitedAt: '2026-09-17T00:00:00.000Z',
          ...metadata,
        },
        expiresAt: new Date(Date.now() + 86400000),
        createdAt: new Date(),
      });
    }
    const rewritten = () => vi.mocked(updateInvitationToken).mock.calls[0]?.[1];

    it('keeps the pending org keys when the body names none', async () => {
      pending({ orgId: OTHER_ORG, orgRole: 'ADMIN' });

      const res = await POST(request({ ...invitee, role: 'USER' }, '?resend=true'));

      expect(res.status).toBe(201);
      expect(rewritten()).toMatchObject({ orgId: OTHER_ORG, orgRole: 'ADMIN' });
      expect(JSON.parse(await res.text()).data.invitation).toMatchObject({
        orgId: OTHER_ORG,
        orgRole: 'ADMIN',
      });
      // And the inherited org still went through the existence/policy check.
      expect(prisma.org.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: OTHER_ORG } })
      );
    });

    it("takes the body's org when it names one — the override is explicit", async () => {
      pending({ orgId: OTHER_ORG, orgRole: 'ADMIN' });
      const another = 'cmorg00000000000000another';
      vi.mocked(prisma.org.findUnique).mockResolvedValueOnce({
        id: another,
        status: 'ACTIVE',
      } as never);

      const res = await POST(request({ ...invitee, orgId: another }, '?resend=true'));

      expect(res.status).toBe(201);
      expect(rewritten()).toMatchObject({ orgId: another });
      expect(rewritten()).not.toHaveProperty('orgRole');
    });

    it('a legacy pending invitation resent without org keys stays keyless', async () => {
      pending({});

      await POST(request({ ...invitee }, '?resend=true'));

      expect(rewritten()).not.toHaveProperty('orgId');
      expect(rewritten()).not.toHaveProperty('orgRole');
      expect(prisma.org.findUnique).not.toHaveBeenCalled();
    });

    it('refuses to resend into a pending org that has since been suspended', async () => {
      pending({ orgId: OTHER_ORG });
      vi.mocked(prisma.org.findUnique).mockResolvedValueOnce({
        id: OTHER_ORG,
        status: 'SUSPENDED',
      } as never);

      const res = await POST(request({ ...invitee }, '?resend=true'));

      expect(res.status).toBe(400);
      expect(updateInvitationToken).not.toHaveBeenCalled();
    });
  });

  it('rejects an org role outside the vocabulary at the boundary', async () => {
    const res = await POST(request({ ...invitee, orgId: OTHER_ORG, orgRole: 'BILLING' }));

    expect(res.status).toBe(400);
    expect(prisma.org.findUnique).not.toHaveBeenCalled();
  });

  it('is still admin-only: a plain member is refused by the guard', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

    const res = await POST(request({ ...invitee, orgId: OTHER_ORG }));

    expect(res.status).toBe(403);
    expect(prisma.org.findUnique).not.toHaveBeenCalled();
  });
});
