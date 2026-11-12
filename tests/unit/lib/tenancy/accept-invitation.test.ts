/**
 * Tests: lib/tenancy/accept-invitation.ts — an existing account accepting or
 * declining an org invitation (#1199, t-1006).
 *
 * The invitation store is a small in-memory `verification` table behind the
 * real `lib/utils/invitation-token.ts`, so token matching, expiry and
 * one-row-per-(email, org) are the shipped code's, not a mock's answer. The
 * membership role comes from the real `membershipForNewUser` over a mocked
 * member count. `addMember` is mocked: its own rules are `lifecycle.test.ts`'s.
 * What is asserted here is what acceptance hands it, and what it leaves in
 * the store.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'crypto';
import { DEFAULT_USER_ROLE, PLATFORM_ADMIN_ROLE } from '@/lib/auth/roles';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { DEFAULT_ORG_ROLE, ORG_ADMIN_ROLE, ORG_OWNER_ROLE } from '@/lib/tenancy/roles';

interface Row {
  id: string;
  identifier: string;
  value: string;
  expiresAt: Date;
  createdAt: Date;
  metadata: unknown;
}

const store = vi.hoisted(() => ({
  rows: [] as Row[],
  memberCount: 1,
  // The invitation's issuer: a platform admin unless a test says otherwise.
  issuer: { role: 'ADMIN', orgMemberships: [] as { role: string }[] },
}));

type Where = {
  id?: string;
  identifier?: string;
  value?: string;
  expiresAt?: { gt: Date };
};

function matches(row: Row, where: Where): boolean {
  if (where.id !== undefined && row.id !== where.id) return false;
  if (where.identifier !== undefined && row.identifier !== where.identifier) return false;
  if (where.value !== undefined && row.value !== where.value) return false;
  if (where.expiresAt && !(row.expiresAt > where.expiresAt.gt)) return false;
  return true;
}

vi.mock('@/lib/db/client', () => ({
  prisma: {
    verification: {
      findFirst: vi.fn(({ where }: { where: Where }) =>
        Promise.resolve(
          store.rows
            .filter((r) => matches(r, where))
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null
        )
      ),
      count: vi.fn(({ where }: { where: Where }) =>
        Promise.resolve(store.rows.filter((r) => matches(r, where)).length)
      ),
      deleteMany: vi.fn(({ where }: { where: Where }) => {
        const before = store.rows.length;
        store.rows = store.rows.filter((r) => !matches(r, where));
        return Promise.resolve({ count: before - store.rows.length });
      }),
    },
    orgMembership: {
      count: vi.fn(() => Promise.resolve(store.memberCount)),
    },
    // The issuer ('inviter-1'), asked about by the first-owner bootstrap.
    user: {
      findUnique: vi.fn(() => Promise.resolve(store.issuer)),
    },
  },
}));

const addMember = vi.hoisted(() => vi.fn());
vi.mock('@/lib/tenancy/lifecycle', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tenancy/lifecycle')>()),
  addMember,
}));

import {
  acceptInvitationAsExistingUser,
  declineInvitation,
  INVITATION_ERROR_CODES,
} from '@/lib/tenancy/accept-invitation';
import { APIError } from '@/lib/api/errors';
import { OrgLifecycleError } from '@/lib/tenancy/lifecycle';

const EMAIL = 'pat@example.com';
const ORG_A = 'org-a';
const ORG_B = 'org-b';
const DAY = 24 * 60 * 60 * 1000;

let seq = 0;
function invite(
  token: string,
  metadata: Record<string, unknown>,
  opts: { email?: string; expiresInMs?: number } = {}
): void {
  seq += 1;
  store.rows.push({
    id: `row-${seq}`,
    identifier: `invitation:${opts.email ?? EMAIL}`,
    value: createHash('sha256').update(token).digest('hex'),
    expiresAt: new Date(Date.now() + (opts.expiresInMs ?? 7 * DAY)),
    createdAt: new Date(Date.now() + seq),
    metadata: {
      name: 'Pat',
      role: DEFAULT_USER_ROLE,
      invitedBy: 'inviter-1',
      invitedAt: new Date().toISOString(),
      ...metadata,
    },
  });
}

const accepter = { id: 'user-1', email: EMAIL, emailVerified: true, role: DEFAULT_USER_ROLE };

function membershipFor(orgId: string, role: string) {
  return {
    id: `m-${orgId}`,
    orgId,
    userId: accepter.id,
    role,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

/** Run `fn` and answer the APIError it threw, failing if it threw none. */
async function refusal(fn: () => Promise<unknown>): Promise<APIError> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof APIError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

beforeEach(() => {
  store.rows = [];
  store.memberCount = 1;
  store.issuer = { role: 'ADMIN', orgMemberships: [] };
  seq = 0;
  addMember.mockReset();
  addMember.mockImplementation((orgId: string, _userId: string, role: string) =>
    Promise.resolve(membershipFor(orgId, role))
  );
});

describe('acceptInvitationAsExistingUser', () => {
  it('writes the membership with the invitation’s org role and consumes only that invitation', async () => {
    invite('tok-a', { orgId: ORG_A, orgRole: ORG_ADMIN_ROLE });
    invite('tok-b', { orgId: ORG_B });

    const membership = await acceptInvitationAsExistingUser(accepter, EMAIL, 'tok-a');

    expect(addMember).toHaveBeenCalledTimes(1);
    const [orgId, userId, role, actor] = addMember.mock.calls[0];
    expect([orgId, userId, role]).toEqual([ORG_A, 'user-1', ORG_ADMIN_ROLE]);
    // Issue-time standing: an OWNER role (bootstrap or invitation) must not
    // be refused by `addMember` for want of the invitee's own standing.
    expect(actor).toEqual({ platformAdmin: false, orgRole: ORG_OWNER_ROLE });
    expect(membership).toMatchObject({ orgId: ORG_A, role: ORG_ADMIN_ROLE });

    // The other org's invitation is untouched and still redeemable.
    expect(store.rows.map((r) => (r.metadata as { orgId: string }).orgId)).toEqual([ORG_B]);
    await acceptInvitationAsExistingUser(accepter, EMAIL, 'tok-b');
    expect(addMember).toHaveBeenLastCalledWith(
      ORG_B,
      'user-1',
      DEFAULT_ORG_ROLE,
      expect.anything()
    );
    expect(store.rows).toHaveLength(0);
  });

  it('makes the first member of an empty org its OWNER, as the new-account path does', async () => {
    store.memberCount = 0;
    invite('tok-a', { orgId: ORG_A, orgRole: DEFAULT_ORG_ROLE });

    await acceptInvitationAsExistingUser(accepter, EMAIL, 'tok-a');

    expect(addMember).toHaveBeenCalledWith(ORG_A, 'user-1', ORG_OWNER_ROLE, expect.anything());
  });

  // Security review of #1178: an org ADMIN could invite a second account of
  // theirs, then empty the org of non-staff members and leave. The bootstrap
  // needs the issuer's owner standing when the invitation is accepted.
  it('does not make the invitee OWNER when the issuer no longer holds owner standing', async () => {
    store.memberCount = 0;
    store.issuer = { role: DEFAULT_USER_ROLE, orgMemberships: [] }; // not a platform admin, and not a member
    invite('tok-a', { orgId: ORG_A, orgRole: DEFAULT_ORG_ROLE });

    await acceptInvitationAsExistingUser(accepter, EMAIL, 'tok-a');

    expect(addMember).toHaveBeenCalledWith(ORG_A, 'user-1', DEFAULT_ORG_ROLE, expect.anything());
  });

  // #1235: an OWNER invitation outlives the issue-time standing check. Its
  // issuer demoted since, it lands the invitee as MEMBER, and is consumed.
  it('accepts an OWNER invitation as MEMBER once its issuer has lost owner standing', async () => {
    store.issuer = { role: DEFAULT_USER_ROLE, orgMemberships: [{ role: ORG_ADMIN_ROLE }] };
    invite('tok-a', { orgId: ORG_A, orgRole: ORG_OWNER_ROLE });

    const membership = await acceptInvitationAsExistingUser(accepter, EMAIL, 'tok-a');

    expect(addMember).toHaveBeenCalledWith(ORG_A, 'user-1', DEFAULT_ORG_ROLE, expect.anything());
    expect(membership.role).toBe(DEFAULT_ORG_ROLE);
    expect(store.rows).toHaveLength(0);
  });

  it('accepts an OWNER invitation as OWNER while its issuer is still an OWNER', async () => {
    store.issuer = { role: DEFAULT_USER_ROLE, orgMemberships: [{ role: ORG_OWNER_ROLE }] };
    invite('tok-a', { orgId: ORG_A, orgRole: ORG_OWNER_ROLE });

    await acceptInvitationAsExistingUser(accepter, EMAIL, 'tok-a');

    expect(addMember).toHaveBeenCalledWith(ORG_A, 'user-1', ORG_OWNER_ROLE, expect.anything());
  });

  it('matches the address case-insensitively', async () => {
    invite('tok-a', { orgId: ORG_A });

    await acceptInvitationAsExistingUser({ ...accepter, email: 'Pat@Example.com' }, EMAIL, 'tok-a');

    expect(addMember).toHaveBeenCalledTimes(1);
  });

  it('refuses a session signed in as a different account, and leaves the invitation', async () => {
    invite('tok-a', { orgId: ORG_A });

    const error = await refusal(() =>
      acceptInvitationAsExistingUser({ ...accepter, email: 'someone@else.com' }, EMAIL, 'tok-a')
    );

    expect(error.code).toBe(INVITATION_ERROR_CODES.WRONG_ACCOUNT);
    expect(error.status).toBe(403);
    expect(addMember).not.toHaveBeenCalled();
    expect(store.rows).toHaveLength(1);
  });

  it('refuses an unverified address', async () => {
    invite('tok-a', { orgId: ORG_A });

    const error = await refusal(() =>
      acceptInvitationAsExistingUser({ ...accepter, emailVerified: false }, EMAIL, 'tok-a')
    );

    expect(error.code).toBe(INVITATION_ERROR_CODES.EMAIL_NOT_VERIFIED);
    expect(addMember).not.toHaveBeenCalled();
    expect(store.rows).toHaveLength(1);
  });

  it('answers 410 INVITATION_EXPIRED for an expired invitation, writing nothing', async () => {
    invite('tok-a', { orgId: ORG_A }, { expiresInMs: -1000 });

    const error = await refusal(() => acceptInvitationAsExistingUser(accepter, EMAIL, 'tok-a'));

    expect(error.code).toBe('INVITATION_EXPIRED');
    expect(error.status).toBe(410);
    expect(addMember).not.toHaveBeenCalled();
  });

  it('answers 404 for a token that redeems nothing — including another address’s token', async () => {
    invite('tok-other', { orgId: ORG_A }, { email: 'other@example.com' });

    const error = await refusal(() => acceptInvitationAsExistingUser(accepter, EMAIL, 'tok-other'));

    expect(error.status).toBe(404);
    expect(addMember).not.toHaveBeenCalled();
    expect(store.rows).toHaveLength(1);
  });

  it.each([
    ['grants a platform role', { orgId: ORG_A, role: PLATFORM_ADMIN_ROLE }],
    ['names no org', {}],
    ['names the install org', { orgId: INSTALL_ORG_ID }],
    ['names an empty org id', { orgId: '' }],
  ])('refuses a platform invitation that %s, leaving it', async (_label, metadata) => {
    invite('tok-a', metadata);

    const error = await refusal(() => acceptInvitationAsExistingUser(accepter, EMAIL, 'tok-a'));

    expect(error.code).toBe(INVITATION_ERROR_CODES.NEEDS_NEW_ACCOUNT);
    expect(error.status).toBe(409);
    expect(addMember).not.toHaveBeenCalled();
    expect(store.rows).toHaveLength(1);
  });

  it('deletes the moot invitation when the account is already a member', async () => {
    invite('tok-a', { orgId: ORG_A });
    addMember.mockRejectedValueOnce(
      new OrgLifecycleError('ALREADY_MEMBER', 'That user is already a member')
    );

    const error = await refusal(() => acceptInvitationAsExistingUser(accepter, EMAIL, 'tok-a'));

    expect(error.code).toBe('ALREADY_MEMBER');
    expect(store.rows).toHaveLength(0);
  });

  it('keeps the invitation when writing the membership fails for any other reason', async () => {
    invite('tok-a', { orgId: ORG_A });
    addMember.mockRejectedValueOnce(new Error('connection reset'));

    await expect(acceptInvitationAsExistingUser(accepter, EMAIL, 'tok-a')).rejects.toThrow(
      'connection reset'
    );

    expect(store.rows).toHaveLength(1);
  });

  it('cannot be redeemed twice', async () => {
    invite('tok-a', { orgId: ORG_A });

    await acceptInvitationAsExistingUser(accepter, EMAIL, 'tok-a');
    const error = await refusal(() => acceptInvitationAsExistingUser(accepter, EMAIL, 'tok-a'));

    expect(error.status).toBe(404);
    expect(addMember).toHaveBeenCalledTimes(1);
  });
});

describe('declineInvitation', () => {
  it('deletes only the invitation the token redeems', async () => {
    invite('tok-a', { orgId: ORG_A });
    invite('tok-b', { orgId: ORG_B });

    await declineInvitation(EMAIL, 'tok-a');

    expect(store.rows.map((r) => (r.metadata as { orgId: string }).orgId)).toEqual([ORG_B]);
  });

  it('deletes an expired invitation too', async () => {
    invite('tok-a', { orgId: ORG_A }, { expiresInMs: -1000 });

    await declineInvitation(EMAIL, 'tok-a');

    expect(store.rows).toHaveLength(0);
  });

  it('answers 404 when the token redeems nothing, deleting nothing', async () => {
    invite('tok-a', { orgId: ORG_A });

    const error = await refusal(() => declineInvitation(EMAIL, 'wrong'));

    expect(error.status).toBe(404);
    expect(store.rows).toHaveLength(1);
  });
});
