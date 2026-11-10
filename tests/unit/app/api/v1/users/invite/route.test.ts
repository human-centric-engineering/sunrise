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

vi.mock('@/lib/utils/invitation-token', async (importOriginal) => ({
  // The real rules (invitationOrgSlot, isPlatformInvitation); only the
  // store calls are mocked.
  ...(await importOriginal<typeof import('@/lib/utils/invitation-token')>()),
  generateInvitationToken: vi.fn(async () => 'raw-token'),
  updateInvitationToken: vi.fn(async () => 'raw-token'),
  pendingInvitationsFor: vi.fn(async () => ({ readable: [], unreadable: 0 })),
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
  pendingInvitationsFor,
  updateInvitationToken,
} from '@/lib/utils/invitation-token';
import { mockAdminUser, mockAuthenticatedUser } from '@/tests/helpers/auth';
import { sendEmail } from '@/lib/email/send';
import {
  DEFAULT_AUTHORIZATION_POLICY,
  registerAuthorizationPolicy,
  __resetAuthorizationPolicyForTests,
} from '@/lib/auth/authorization';

/** Mock the address's pending invitations as this one (or none). */
function mockPending(inv: Parameters<typeof pendingOf>[0], once = true) {
  const m = vi.mocked(pendingInvitationsFor);
  if (once) m.mockResolvedValueOnce(pendingOf(inv));
  else m.mockResolvedValue(pendingOf(inv));
}
function pendingOf(inv: import('@/lib/utils/invitation-token').InvitationRecord | null) {
  return { readable: inv ? [inv] : [], unreadable: 0 };
}

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

  // A role in the install org follows the platform role, as it does on the
  // members screen, so the body cannot set one there (#871).
  it.each([{}, { orgId: 'install' }])(
    'refuses an orgRole for the install org (%j) and writes nothing',
    async (org) => {
      const res = await POST(request({ ...invitee, ...org, orgRole: 'ADMIN' }));

      expect(res.status).toBe(400);
      expect(JSON.parse(await res.text()).error.code).toBe('VALIDATION_ERROR');
      expect(generateInvitationToken).not.toHaveBeenCalled();
    }
  );

  it('still accepts an orgRole for another org', async () => {
    const res = await POST(request({ ...invitee, orgId: OTHER_ORG, orgRole: 'ADMIN' }));

    expect(res.status).toBe(201);
    expect(writtenMetadata()).toMatchObject({ orgId: OTHER_ORG, orgRole: 'ADMIN' });
  });

  it('writes the org and org role it was given', async () => {
    const res = await POST(request({ ...invitee, orgId: OTHER_ORG, orgRole: 'ADMIN' }));

    expect(res.status).toBe(201);
    expect(writtenMetadata()).toMatchObject({ orgId: OTHER_ORG, orgRole: 'ADMIN' });
    expect(prisma.org.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: OTHER_ORG } })
    );
  });

  it('names the org in the email, as the org route does (code review, t-1006)', async () => {
    vi.mocked(prisma.org.findUnique).mockResolvedValueOnce({
      id: OTHER_ORG,
      status: 'ACTIVE',
      name: 'Acme',
    } as never);

    await POST(request({ ...invitee, orgId: OTHER_ORG }));

    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ subject: "You've been invited to join Acme" })
    );
  });

  it('names the app, not the org, for an invitation into the install org', async () => {
    vi.mocked(prisma.org.findUnique).mockResolvedValueOnce({
      id: 'install',
      status: 'ACTIVE',
      name: 'Default organisation',
    } as never);

    await POST(request({ ...invitee, orgId: 'install' }));

    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: expect.not.stringContaining('Default organisation'),
      })
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

  it('returns the invitedAt it stored, the value the user-created seam later reports (#1136)', async () => {
    const res = await POST(request({ ...invitee }));
    const body = JSON.parse(await res.text());

    const stored = vi.mocked(generateInvitationToken).mock.calls.at(-1)?.[1];
    expect(stored?.invitedAt).toEqual(expect.any(String));
    expect(body.data.invitation.invitedAt).toBe(stored?.invitedAt);
  });

  it('the "already pending" response says where the pending invitation points', async () => {
    // A resend rewrites the metadata from the body, so an admin has to be
    // able to see the pending org before choosing to overwrite it.
    mockPending({
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

    // The org is named: an address holds one invitation per org (#1199).
    const res = await POST(request({ ...invitee, orgId: OTHER_ORG }));
    const body = JSON.parse(await res.text());

    expect(res.status).toBe(200);
    expect(body.data.emailStatus).toBe('pending');
    expect(body.data.invitation).toMatchObject({ orgId: OTHER_ORG, orgRole: 'ADMIN' });
    expect(generateInvitationToken).not.toHaveBeenCalled();
  });

  it('a legacy pending invitation (no org keys) reports null, not undefined', async () => {
    mockPending({
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
      mockPending({
        id: 'row-pending',
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

    it('re-sends the row the admin table names, keeping its org keys', async () => {
      // The table's Resend posts the row's orgId and orgRole (#1199).
      pending({ orgId: OTHER_ORG, orgRole: 'ADMIN' });

      const res = await POST(
        request({ ...invitee, role: 'USER', orgId: OTHER_ORG, orgRole: 'ADMIN' }, '?resend=true')
      );

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

    it('a body naming another org writes that org its own invitation, leaving the pending one', async () => {
      // One invitation per (email, org) (#1199): the pending row is OTHER_ORG's,
      // so it is not this request's to replace.
      pending({ orgId: OTHER_ORG, orgRole: 'ADMIN' });
      const another = 'cmorg00000000000000another';
      vi.mocked(prisma.org.findUnique).mockResolvedValueOnce({
        id: another,
        status: 'ACTIVE',
      } as never);

      const res = await POST(request({ ...invitee, orgId: another }, '?resend=true'));

      expect(res.status).toBe(201);
      expect(generateInvitationToken).toHaveBeenCalledWith(
        invitee.email,
        expect.objectContaining({ orgId: another })
      );
      expect(updateInvitationToken).not.toHaveBeenCalled();
    });

    it('re-sends the named org’s invitation, not the newest one for the address', async () => {
      const row = (id: string, orgId: string) => ({
        id,
        email: invitee.email,
        metadata: {
          name: 'Jane Doe',
          role: 'USER',
          invitedBy: 'admin-1',
          invitedAt: '2026-09-17T00:00:00.000Z',
          orgId,
        },
        expiresAt: new Date(Date.now() + 86400000),
        createdAt: new Date(),
      });
      const another = 'cmorg00000000000000another';
      // Newest first: another org's row, then OTHER_ORG's.
      vi.mocked(pendingInvitationsFor).mockResolvedValueOnce({
        readable: [row('row-another', another), row('row-other', OTHER_ORG)],
        unreadable: 0,
      });

      const res = await POST(request({ ...invitee, orgId: OTHER_ORG }, '?resend=true'));

      expect(res.status).toBe(201);
      expect(updateInvitationToken).toHaveBeenCalledWith(
        invitee.email,
        expect.objectContaining({ orgId: OTHER_ORG })
      );
    });

    it('with several pending and no org named, re-sends the install org’s, not the newest', async () => {
      const base = {
        email: invitee.email,
        expiresAt: new Date(Date.now() + 86400000),
        createdAt: new Date(),
      };
      const meta = { name: 'Jane Doe', role: 'USER', invitedBy: 'a', invitedAt: '2026-09-17' };
      vi.mocked(pendingInvitationsFor).mockResolvedValueOnce({
        readable: [
          { ...base, id: 'row-org', metadata: { ...meta, orgId: OTHER_ORG } },
          { ...base, id: 'row-install', metadata: meta },
        ],
        unreadable: 0,
      });

      const res = await POST(request({ ...invitee, role: 'USER' }, '?resend=true'));

      expect(res.status).toBe(201);
      const written = vi.mocked(updateInvitationToken).mock.calls[0]?.[1];
      expect(written?.orgId).toBeUndefined();
    });

    it('passes no replacing id when there is no pending invitation to re-send', async () => {
      const res = await POST(request({ ...invitee }));

      expect(res.status).toBe(201);
      expect(generateInvitationToken).toHaveBeenCalledTimes(1);
      expect(updateInvitationToken).not.toHaveBeenCalled();
    });

    it('drops an install-org orgRole a pending invitation carries from before #871', async () => {
      pending({ orgRole: 'ADMIN' });

      const res = await POST(request({ ...invitee }, '?resend=true'));

      expect(res.status).toBe(201);
      expect(rewritten()).toBeDefined();
      expect(rewritten()).not.toHaveProperty('orgRole');
      expect(rewritten()).not.toHaveProperty('orgId');
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
      // Another org's invitation is its own row (#1199): written fresh, with
      // the body's org and none of the pending row's org role.
      const written = vi.mocked(generateInvitationToken).mock.calls[0]?.[1];
      expect(written).toMatchObject({ orgId: another });
      expect(written).not.toHaveProperty('orgRole');
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

      const res = await POST(request({ ...invitee, orgId: OTHER_ORG }, '?resend=true'));

      expect(res.status).toBe(400);
      expect(updateInvitationToken).not.toHaveBeenCalled();
    });

    it('a body naming no org does not adopt a lone org invitation (code review, t-1006)', async () => {
      // Naming no org means the install org. With only OTHER_ORG's invitation
      // pending, that is a new platform invitation beside an org one, which is
      // refused: the platform one could never be redeemed once the org one
      // creates the account.
      pending({ orgId: OTHER_ORG, orgRole: 'ADMIN' });

      const res = await POST(request({ ...invitee, role: 'ADMIN' }, '?resend=true'));

      expect(res.status).toBe(409);
      expect(JSON.parse(await res.text()).error.code).toBe('CONFLICT');
      expect(updateInvitationToken).not.toHaveBeenCalled();
      expect(generateInvitationToken).not.toHaveBeenCalled();
    });

    it('re-sends a pending platform invitation even with an org invitation beside it', async () => {
      const base = {
        email: invitee.email,
        expiresAt: new Date(Date.now() + 86400000),
        createdAt: new Date(),
      };
      const meta = { name: 'Jane Doe', role: 'ADMIN', invitedBy: 'a', invitedAt: '2026-09-17' };
      vi.mocked(pendingInvitationsFor).mockResolvedValueOnce({
        readable: [
          { ...base, id: 'row-org', metadata: { ...meta, role: 'USER', orgId: OTHER_ORG } },
          { ...base, id: 'row-install', metadata: meta },
        ],
        unreadable: 0,
      });

      const res = await POST(request({ ...invitee, role: 'ADMIN' }, '?resend=true'));

      expect(res.status).toBe(201);
      expect(updateInvitationToken).toHaveBeenCalledTimes(1);
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

// t-833: the platform role is platform standing. A fork's policy may admit an
// org's OWNER/ADMIN to the admin guard, but that must not let them mint a
// platform ADMIN through the invitation — only a platform admin sets a role
// above the default, whatever the policy said.
describe('POST /api/v1/users/invite — platform role floor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  /**
   * A fork policy that lets a non-platform-admin through every admin question
   * and reads them unrestricted, as one admitting an org's admins to the admin
   * surfaces would (the guard insists on an ownership decision otherwise).
   */
  function registerWideningPolicy() {
    registerAuthorizationPolicy({
      ...DEFAULT_AUTHORIZATION_POLICY,
      canAdminister: async () => true,
      subjectScope: async () => ({}),
    });
  }

  it('refuses a non-platform-admin setting the ADMIN role, even when the policy admits them', async () => {
    registerWideningPolicy();
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

    const res = await POST(request({ ...invitee, role: 'ADMIN', orgId: OTHER_ORG }));

    expect(res.status).toBe(403);
    expect(JSON.parse(await res.text()).error.code).toBe('FORBIDDEN');
    expect(generateInvitationToken).not.toHaveBeenCalled();
    expect(updateInvitationToken).not.toHaveBeenCalled();
  });

  it('still lets that caller invite at the default role', async () => {
    registerWideningPolicy();
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

    const res = await POST(request({ ...invitee, orgId: OTHER_ORG }));

    expect(res.status).toBe(201);
    expect(vi.mocked(generateInvitationToken).mock.calls[0]?.[1]).toMatchObject({
      role: 'USER',
      orgId: OTHER_ORG,
    });
  });

  function pendingInvitation(role: string) {
    return {
      email: invitee.email,
      metadata: {
        name: 'Jane Doe',
        role,
        invitedBy: 'admin-1',
        invitedAt: '2026-10-01T00:00:00.000Z',
      },
      expiresAt: new Date(Date.now() + 86400000),
      createdAt: new Date(),
    };
  }

  it('refuses that caller re-sending a pending ADMIN invitation, even at the default role', async () => {
    registerWideningPolicy();
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));
    mockPending(pendingInvitation('ADMIN'));

    const res = await POST(request({ ...invitee, orgId: OTHER_ORG }, '?resend=true'));

    expect(res.status).toBe(403);
    expect(generateInvitationToken).not.toHaveBeenCalled();
    expect(updateInvitationToken).not.toHaveBeenCalled();
  });

  it('refuses that caller when the ADMIN invitation is older than a default-role one', async () => {
    // Code review finding (t-1006): the floor read only the newest row.
    registerWideningPolicy();
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));
    const userRow = { ...pendingInvitation('USER'), id: 'row-user' };
    userRow.metadata = { ...userRow.metadata, orgId: OTHER_ORG } as typeof userRow.metadata;
    vi.mocked(pendingInvitationsFor).mockResolvedValueOnce({
      readable: [userRow, { ...pendingInvitation('ADMIN'), id: 'row-admin' }],
      unreadable: 0,
    });

    const res = await POST(request({ ...invitee, orgId: OTHER_ORG }, '?resend=true'));

    expect(res.status).toBe(403);
    expect(updateInvitationToken).not.toHaveBeenCalled();
    expect(generateInvitationToken).not.toHaveBeenCalled();
  });

  it('still lets that caller re-send a pending default-role invitation', async () => {
    registerWideningPolicy();
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));
    // Pending in the org it re-sends: one invitation per (email, org) (#1199).
    const row = pendingInvitation('USER');
    mockPending({ ...row, metadata: { ...row.metadata, orgId: OTHER_ORG } });

    const res = await POST(request({ ...invitee, orgId: OTHER_ORG }, '?resend=true'));

    expect(res.status).toBe(201);
    expect(updateInvitationToken).toHaveBeenCalledTimes(1);
  });

  it('refuses an org invitation beside a pending platform invitation (code review, t-1006)', async () => {
    // The mirror of the org route: accepting the org one first would strand
    // the platform one.
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    mockPending(pendingInvitation('USER')); // install org: a platform invitation

    const res = await POST(request({ ...invitee, orgId: OTHER_ORG }));

    expect(res.status).toBe(409);
    expect(generateInvitationToken).not.toHaveBeenCalled();
  });

  it('refuses a resend that turns an org invitation into a platform one beside another org’s', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    const base = pendingInvitation('USER');
    vi.mocked(pendingInvitationsFor).mockResolvedValueOnce({
      readable: [
        { ...base, id: 'row-x', metadata: { ...base.metadata, orgId: OTHER_ORG } },
        {
          ...base,
          id: 'row-y',
          metadata: { ...base.metadata, orgId: 'cmorg00000000000000000orgy' },
        },
      ],
      unreadable: 0,
    });

    const res = await POST(
      request({ ...invitee, role: 'ADMIN', orgId: OTHER_ORG }, '?resend=true')
    );

    expect(res.status).toBe(409);
    expect(updateInvitationToken).not.toHaveBeenCalled();
  });

  it('lets a platform admin set the ADMIN role', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    const res = await POST(request({ ...invitee, role: 'ADMIN' }));

    expect(res.status).toBe(201);
    expect(vi.mocked(generateInvitationToken).mock.calls[0]?.[1]).toMatchObject({
      role: 'ADMIN',
    });
  });
});

describe('POST /api/v1/users/invite — an address that already has an account (t-1008)', () => {
  // The admin invitations table re-sends an org invitation the org route
  // wrote to an existing account (#1199) through this route. It goes out as
  // the org route sends it; a platform invitation to that address is still
  // refused, since an existing account cannot redeem one.
  const ORG_Y = 'cmorg00000000000000000orgy';

  function row(id: string, metadata: Record<string, unknown>) {
    return {
      id,
      email: invitee.email,
      metadata: {
        name: 'Jane Doe',
        role: 'USER',
        invitedBy: 'org-admin-1',
        invitedAt: '2026-11-01T00:00:00.000Z',
        ...metadata,
      },
      expiresAt: new Date(Date.now() + 86400000),
      createdAt: new Date(),
    };
  }

  function accountExists(memberOfTarget = false) {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: 'user-jane',
      orgMemberships: memberOfTarget ? [{ id: 'm-1' }] : [],
    } as never);
  }

  /** What the table's Resend posts for an org row. */
  const resendOrgRow = () =>
    POST(
      request({ ...invitee, role: 'USER', orgId: OTHER_ORG, orgRole: 'MEMBER' }, '?resend=true')
    );

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiApiKey.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.org.findUnique).mockResolvedValue({
      id: OTHER_ORG,
      status: 'ACTIVE',
      name: 'Other Org',
    } as never);
  });

  it("re-sends an existing account's org invitation with a new token, asking them to sign in", async () => {
    accountExists();
    mockPending(row('row-other', { orgId: OTHER_ORG, orgRole: 'MEMBER' }));

    const res = await resendOrgRow();

    expect(res.status).toBe(201);
    expect(updateInvitationToken).toHaveBeenCalledTimes(1);
    expect(vi.mocked(updateInvitationToken).mock.calls[0]).toEqual([
      invitee.email,
      expect.objectContaining({ role: 'USER', orgId: OTHER_ORG, orgRole: 'MEMBER' }),
    ]);
    expect(generateInvitationToken).not.toHaveBeenCalled();
    const { resolveEmailTemplate } = await import('@/lib/email/registry');
    expect(vi.mocked(resolveEmailTemplate)).toHaveBeenCalledWith(
      'invitation',
      expect.objectContaining({ hasAccount: true, orgName: 'Other Org' })
    );
    // The membership looked up is the target org's, not any org's.
    expect(prisma.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { email: invitee.email },
        select: expect.objectContaining({
          orgMemberships: expect.objectContaining({ where: { orgId: OTHER_ORG } }),
        }),
      })
    );
  });

  it("replaces only that org's invitation, leaving the address's other org's alone", async () => {
    accountExists();
    vi.mocked(pendingInvitationsFor).mockResolvedValueOnce({
      readable: [
        row('row-y', { orgId: ORG_Y }), // newest: another org's
        row('row-other', { orgId: OTHER_ORG, orgRole: 'MEMBER' }),
      ],
      unreadable: 0,
    });

    const res = await resendOrgRow();

    expect(res.status).toBe(201);
    // One replacement, keyed on the target org; the store replaces by
    // (email, org), so ORG_Y's row is not what it was told to rewrite.
    expect(updateInvitationToken).toHaveBeenCalledTimes(1);
    expect(vi.mocked(updateInvitationToken).mock.calls[0]?.[1]).toMatchObject({
      orgId: OTHER_ORG,
    });
    expect(generateInvitationToken).not.toHaveBeenCalled();
  });

  it('answers the same whether or not the account exists', async () => {
    const strip = (body: { data: { invitation: Record<string, unknown> } }) => {
      const { invitedAt: _i, expiresAt: _e, ...rest } = body.data.invitation;
      return { ...body, data: { ...body.data, invitation: rest } };
    };

    mockPending(row('row-other', { orgId: OTHER_ORG, orgRole: 'MEMBER' }));
    const without = await resendOrgRow();

    accountExists();
    mockPending(row('row-other', { orgId: OTHER_ORG, orgRole: 'MEMBER' }));
    const withAccount = await resendOrgRow();

    expect(withAccount.status).toBe(without.status);
    expect(strip(JSON.parse(await withAccount.text()))).toEqual(
      strip(JSON.parse(await without.text()))
    );
  });

  it('still answers "already pending" without a resend, as for a new address', async () => {
    accountExists();
    mockPending(row('row-other', { orgId: OTHER_ORG, orgRole: 'MEMBER' }));

    const res = await POST(request({ ...invitee, orgId: OTHER_ORG }));

    expect(res.status).toBe(200);
    expect(JSON.parse(await res.text()).data.emailStatus).toBe('pending');
    expect(updateInvitationToken).not.toHaveBeenCalled();
  });

  it('invites an existing account into an org for the first time', async () => {
    accountExists();

    const res = await POST(request({ ...invitee, orgId: OTHER_ORG }));

    expect(res.status).toBe(201);
    expect(vi.mocked(generateInvitationToken).mock.calls[0]?.[1]).toMatchObject({
      orgId: OTHER_ORG,
    });
  });

  it('refuses someone already a member of that org, as the org route does', async () => {
    accountExists(true);
    mockPending(row('row-other', { orgId: OTHER_ORG, orgRole: 'MEMBER' }));

    const res = await resendOrgRow();

    expect(res.status).toBe(409);
    expect(JSON.parse(await res.text()).error.code).toBe('ALREADY_MEMBER');
    expect(updateInvitationToken).not.toHaveBeenCalled();
  });

  describe('the org and the policy are checked before anything about the address', () => {
    afterEach(() => {
      __resetAuthorizationPolicyForTests();
    });

    it('a caller the policy refuses for the org gets 403, not whether they are a member', async () => {
      accountExists(true);
      const canAdminister = vi.fn(async () => false);
      registerAuthorizationPolicy({ ...DEFAULT_AUTHORIZATION_POLICY, canAdminister });
      // Let the guard's own canAdminister(principal, null) pass.
      canAdminister.mockImplementationOnce(async () => true);

      const res = await POST(request({ ...invitee, orgId: OTHER_ORG }));

      expect(res.status).toBe(403);
      expect(JSON.parse(await res.text()).error.code).not.toBe('ALREADY_MEMBER');
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
    });

    it('a member of a suspended org gets the same 400 as anyone else', async () => {
      accountExists(true);
      vi.mocked(prisma.org.findUnique).mockResolvedValue({
        id: OTHER_ORG,
        status: 'SUSPENDED',
        name: 'Other Org',
      } as never);

      const res = await POST(request({ ...invitee, orgId: OTHER_ORG }));

      expect(res.status).toBe(400);
      expect(JSON.parse(await res.text()).error.message).toBe(
        'Cannot invite into that organisation'
      );
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('an OWNER org invitation needs owner standing, as on the org route', () => {
    afterEach(() => {
      __resetAuthorizationPolicyForTests();
    });

    /** A fork policy admitting a non-platform-admin, as t-671 will an org's admins. */
    function asAdmittedNonPlatformAdmin() {
      registerAuthorizationPolicy({
        ...DEFAULT_AUTHORIZATION_POLICY,
        canAdminister: async () => true,
        subjectScope: async () => ({}),
      });
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));
    }

    it('refuses inviting an existing account as OWNER without it', async () => {
      asAdmittedNonPlatformAdmin();
      accountExists();

      const res = await POST(request({ ...invitee, orgId: OTHER_ORG, orgRole: 'OWNER' }));

      expect(res.status).toBe(403);
      expect(JSON.parse(await res.text()).error.code).toBe('OWNER_STANDING');
      expect(generateInvitationToken).not.toHaveBeenCalled();
    });

    it('refuses re-sending a pending OWNER invitation without it, whatever role the body names', async () => {
      asAdmittedNonPlatformAdmin();
      accountExists();
      mockPending(row('row-other', { orgId: OTHER_ORG, orgRole: 'OWNER' }));

      const res = await resendOrgRow(); // the body names MEMBER

      expect(res.status).toBe(403);
      expect(JSON.parse(await res.text()).error.code).toBe('OWNER_STANDING');
      expect(updateInvitationToken).not.toHaveBeenCalled();
    });

    it('still answers "already pending" for a pending OWNER invitation without a resend', async () => {
      asAdmittedNonPlatformAdmin();
      accountExists();
      mockPending(row('row-other', { orgId: OTHER_ORG, orgRole: 'OWNER' }));

      const res = await POST(request({ ...invitee, orgId: OTHER_ORG }));

      expect(res.status).toBe(200);
      expect(JSON.parse(await res.text()).data.emailStatus).toBe('pending');
    });

    it('lets a platform admin invite an existing account as OWNER', async () => {
      accountExists();

      const res = await POST(request({ ...invitee, orgId: OTHER_ORG, orgRole: 'OWNER' }));

      expect(res.status).toBe(201);
      expect(vi.mocked(generateInvitationToken).mock.calls[0]?.[1]).toMatchObject({
        orgId: OTHER_ORG,
        orgRole: 'OWNER',
      });
    });
  });

  it('refuses re-sending an org invitation while another pending one cannot be read', async () => {
    accountExists();
    vi.mocked(pendingInvitationsFor).mockResolvedValueOnce({
      readable: [row('row-other', { orgId: OTHER_ORG, orgRole: 'MEMBER' })],
      unreadable: 1,
    });

    const res = await resendOrgRow();

    expect(res.status).toBe(409);
    expect(JSON.parse(await res.text()).error.code).toBe('CONFLICT');
    expect(updateInvitationToken).not.toHaveBeenCalled();
  });

  it('lets a platform invitation through beside a row it cannot read, as before', async () => {
    vi.mocked(pendingInvitationsFor).mockResolvedValueOnce({ readable: [], unreadable: 1 });

    const res = await POST(request({ ...invitee }));

    expect(res.status).toBe(201);
  });

  it('refuses a new invitation while a pending one cannot be read, as the org route does', async () => {
    accountExists();
    vi.mocked(pendingInvitationsFor).mockResolvedValueOnce({ readable: [], unreadable: 1 });

    const res = await POST(request({ ...invitee, orgId: OTHER_ORG }));

    expect(res.status).toBe(409);
    expect(JSON.parse(await res.text()).error.code).toBe('CONFLICT');
    expect(generateInvitationToken).not.toHaveBeenCalled();
  });

  describe('a platform invitation to an existing account is still refused', () => {
    it('an install-org invitation (no org named)', async () => {
      accountExists();
      mockPending(row('row-install', {}));

      const res = await POST(request({ ...invitee, role: 'USER' }, '?resend=true'));

      expect(res.status).toBe(409);
      expect(JSON.parse(await res.text()).error.code).toBe('EMAIL_TAKEN');
      expect(updateInvitationToken).not.toHaveBeenCalled();
      expect(generateInvitationToken).not.toHaveBeenCalled();
    });

    it('the install org named explicitly', async () => {
      accountExists();
      const { INSTALL_ORG_ID } = await import('@/lib/tenancy/constants');

      const res = await POST(request({ ...invitee, orgId: INSTALL_ORG_ID }));

      expect(res.status).toBe(409);
      expect(JSON.parse(await res.text()).error.code).toBe('EMAIL_TAKEN');
      expect(generateInvitationToken).not.toHaveBeenCalled();
    });

    it('a platform role into another org', async () => {
      accountExists();
      mockPending(row('row-other', { orgId: OTHER_ORG, role: 'ADMIN' }));

      const res = await POST(
        request({ ...invitee, role: 'ADMIN', orgId: OTHER_ORG }, '?resend=true')
      );

      expect(res.status).toBe(409);
      expect(JSON.parse(await res.text()).error.code).toBe('EMAIL_TAKEN');
      expect(updateInvitationToken).not.toHaveBeenCalled();
    });
  });
});
