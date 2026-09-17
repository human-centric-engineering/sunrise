/**
 * Tests: lib/tenancy/membership.ts — where a new user lands, and which org a
 * new session starts in.
 *
 * `initialMembershipFor` is covered from the migration side
 * (`migration.test.ts` asserts it agrees with the SQL `CASE`). This file is
 * the two functions §106 t-670 added on top of it:
 *
 * - `membershipForNewUser` — the one answer for `(user, invitation)`, with the
 *   case t-669 found missing: an invitation that GRANTS platform ADMIN must
 *   make its user the install org's OWNER even though the row was created
 *   as USER. And the per-org bootstrap: the first member of a non-install
 *   org is its OWNER, whatever the invitation said.
 * - `activeOrgForSession` — the four arms, and the self-heal, which must
 *   write for a memberless user and must NOT write for anyone else.
 *
 * Prisma is a hand-built mock with only the three calls these functions make,
 * so a new query shows up as a TypeError rather than an unexplained pass.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { DEFAULT_ORG_ROLE, ORG_ADMIN_ROLE, ORG_OWNER_ROLE } from '@/lib/tenancy/roles';
import { PLATFORM_ADMIN_ROLE, DEFAULT_USER_ROLE } from '@/lib/auth/roles';

vi.mock('@/lib/db/client', () => ({ prisma: {} }));

import {
  activeOrgForSession,
  initialMembershipFor,
  membershipForNewUser,
} from '@/lib/tenancy/membership';

const mocks = {
  orgMembership: {
    count: vi.fn(),
    findMany: vi.fn(),
    upsert: vi.fn(),
  },
  user: {
    findUnique: vi.fn(),
  },
};
// The three delegates' three methods are all these functions call; anything
// else is a TypeError at the call site, which is the point of not mocking more.
const db = mocks as unknown as Pick<PrismaClient, 'orgMembership' | 'user'>;

const OTHER_ORG = 'cmorg000000000000000other';
const USER_ID = 'cmuser00000000000000user1';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.orgMembership.count.mockResolvedValue(0);
  mocks.orgMembership.findMany.mockResolvedValue([]);
  mocks.orgMembership.upsert.mockResolvedValue(undefined);
  mocks.user.findUnique.mockResolvedValue(null);
});

describe('membershipForNewUser', () => {
  it('with no invitation answers exactly what initialMembershipFor answers', async () => {
    for (const user of [
      { role: DEFAULT_USER_ROLE, accountType: 'HUMAN' },
      { role: PLATFORM_ADMIN_ROLE, accountType: 'HUMAN' },
      { role: PLATFORM_ADMIN_ROLE, accountType: 'SERVICE' },
    ]) {
      expect(await membershipForNewUser(user, null, db)).toEqual(initialMembershipFor(user));
    }
    // The install arm never reads the database.
    expect(mocks.orgMembership.count).not.toHaveBeenCalled();
  });

  it('judges the install-org role on the role the invitation GRANTS, not the row (t-669 finding)', async () => {
    // The password accept-invite path creates the row as USER and promotes it
    // afterwards; the hook sees USER. The invitation says ADMIN. OWNER.
    const row = { role: DEFAULT_USER_ROLE, accountType: 'HUMAN' };
    expect(await membershipForNewUser(row, { role: PLATFORM_ADMIN_ROLE }, db)).toEqual({
      orgId: INSTALL_ORG_ID,
      role: ORG_OWNER_ROLE,
    });
    // Control: the same row with a USER invitation is a MEMBER — so the OWNER
    // above came from the invitation, not from something else in the input.
    expect(await membershipForNewUser(row, { role: DEFAULT_USER_ROLE }, db)).toEqual({
      orgId: INSTALL_ORG_ID,
      role: DEFAULT_ORG_ROLE,
    });
  });

  it('honours an explicit orgRole on the install org as written', async () => {
    const row = { role: DEFAULT_USER_ROLE, accountType: 'HUMAN' };
    expect(
      await membershipForNewUser(row, { orgId: INSTALL_ORG_ID, orgRole: ORG_ADMIN_ROLE }, db)
    ).toEqual({ orgId: INSTALL_ORG_ID, role: ORG_ADMIN_ROLE });
  });

  it('an invitation naming another org lands there with its orgRole, MEMBER by default', async () => {
    mocks.orgMembership.count.mockResolvedValue(3);
    const row = { role: DEFAULT_USER_ROLE, accountType: 'HUMAN' };

    expect(await membershipForNewUser(row, { orgId: OTHER_ORG }, db)).toEqual({
      orgId: OTHER_ORG,
      role: DEFAULT_ORG_ROLE,
    });
    expect(
      await membershipForNewUser(row, { orgId: OTHER_ORG, orgRole: ORG_ADMIN_ROLE }, db)
    ).toEqual({ orgId: OTHER_ORG, role: ORG_ADMIN_ROLE });
    expect(mocks.orgMembership.count).toHaveBeenCalledWith({ where: { orgId: OTHER_ORG } });
  });

  it('the first member of a new org is its OWNER, whatever the invitation said', async () => {
    mocks.orgMembership.count.mockResolvedValue(0);
    const row = { role: DEFAULT_USER_ROLE, accountType: 'HUMAN' };

    expect(
      await membershipForNewUser(row, { orgId: OTHER_ORG, orgRole: DEFAULT_ORG_ROLE }, db)
    ).toEqual({ orgId: OTHER_ORG, role: ORG_OWNER_ROLE });
  });

  it('the per-org bootstrap does not apply to the install org', async () => {
    // On a fresh database the install org's first member is the seeded
    // SERVICE account. Zero members must not make it an OWNER.
    mocks.orgMembership.count.mockResolvedValue(0);
    const service = { role: PLATFORM_ADMIN_ROLE, accountType: 'SERVICE' };

    expect(await membershipForNewUser(service, { orgId: INSTALL_ORG_ID }, db)).toEqual({
      orgId: INSTALL_ORG_ID,
      role: DEFAULT_ORG_ROLE,
    });
  });

  it('a platform ADMIN invited into another org is a plain member there', async () => {
    // The platform role decides the INSTALL org's role only.
    mocks.orgMembership.count.mockResolvedValue(2);
    const row = { role: DEFAULT_USER_ROLE, accountType: 'HUMAN' };

    expect(
      await membershipForNewUser(row, { role: PLATFORM_ADMIN_ROLE, orgId: OTHER_ORG }, db)
    ).toEqual({ orgId: OTHER_ORG, role: DEFAULT_ORG_ROLE });
  });
});

describe('activeOrgForSession', () => {
  const membership = (
    orgId: string,
    joined: string,
    status: 'ACTIVE' | 'SUSPENDED' = 'ACTIVE'
  ) => ({
    orgId,
    createdAt: new Date(joined),
    org: { status },
  });

  it('a single membership is the answer, whichever org it is', async () => {
    mocks.orgMembership.findMany.mockResolvedValue([membership(OTHER_ORG, '2026-01-01')]);

    expect(await activeOrgForSession(USER_ID, db)).toEqual({ orgId: OTHER_ORG, healed: false });
    expect(mocks.orgMembership.upsert).not.toHaveBeenCalled();
  });

  it('prefers the install org when the user belongs to it among others', async () => {
    // Most recent first, as the query orders — and the install org is NOT the
    // most recent, so this arm is doing work.
    mocks.orgMembership.findMany.mockResolvedValue([
      membership(OTHER_ORG, '2026-03-01'),
      membership(INSTALL_ORG_ID, '2026-01-01'),
    ]);

    expect(await activeOrgForSession(USER_ID, db)).toEqual({
      orgId: INSTALL_ORG_ID,
      healed: false,
    });
  });

  it('otherwise the most recently joined org', async () => {
    const newest = 'cmorg000000000000000newer';
    mocks.orgMembership.findMany.mockResolvedValue([
      membership(newest, '2026-03-01'),
      membership(OTHER_ORG, '2026-01-01'),
    ]);

    expect(await activeOrgForSession(USER_ID, db)).toEqual({ orgId: newest, healed: false });
    expect(mocks.orgMembership.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { createdAt: 'desc' } })
    );
  });

  it('prefers an ACTIVE org over a suspended one, so a suspension is not a lockout', async () => {
    // Most recent first: the suspended org would win on recency alone.
    mocks.orgMembership.findMany.mockResolvedValue([
      membership(OTHER_ORG, '2026-03-01', 'SUSPENDED'),
      membership('cmorg000000000000000older', '2026-01-01'),
    ]);

    expect(await activeOrgForSession(USER_ID, db)).toEqual({
      orgId: 'cmorg000000000000000older',
      healed: false,
    });
  });

  it('a user whose only org is suspended still starts there (refused at entry), and is not healed', async () => {
    mocks.orgMembership.findMany.mockResolvedValue([
      membership(OTHER_ORG, '2026-03-01', 'SUSPENDED'),
    ]);

    expect(await activeOrgForSession(USER_ID, db)).toEqual({ orgId: OTHER_ORG, healed: false });
    expect(mocks.orgMembership.upsert).not.toHaveBeenCalled();
  });

  it('a user with no membership is given the install-org default — and it is written', async () => {
    mocks.orgMembership.findMany.mockResolvedValue([]);
    mocks.user.findUnique.mockResolvedValue({ role: PLATFORM_ADMIN_ROLE, accountType: 'HUMAN' });

    expect(await activeOrgForSession(USER_ID, db)).toEqual({
      orgId: INSTALL_ORG_ID,
      healed: true,
    });
    expect(mocks.orgMembership.upsert).toHaveBeenCalledTimes(1);
    expect(mocks.orgMembership.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: { orgId: INSTALL_ORG_ID, userId: USER_ID, role: ORG_OWNER_ROLE },
      })
    );
  });

  it('the self-heal applies the same rule as signup (SERVICE admin stays MEMBER)', async () => {
    mocks.orgMembership.findMany.mockResolvedValue([]);
    mocks.user.findUnique.mockResolvedValue({ role: PLATFORM_ADMIN_ROLE, accountType: 'SERVICE' });

    await activeOrgForSession(USER_ID, db);

    expect(mocks.orgMembership.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: { orgId: INSTALL_ORG_ID, userId: USER_ID, role: DEFAULT_ORG_ROLE },
      })
    );
  });

  it('writes nothing for a user who already has a membership (the self-heal is not a sync)', async () => {
    mocks.orgMembership.findMany.mockResolvedValue([membership(INSTALL_ORG_ID, '2026-01-01')]);

    await activeOrgForSession(USER_ID, db);

    expect(mocks.user.findUnique).not.toHaveBeenCalled();
    expect(mocks.orgMembership.upsert).not.toHaveBeenCalled();
  });

  it('a missing user row gets the default without a write the FK would refuse', async () => {
    mocks.orgMembership.findMany.mockResolvedValue([]);
    mocks.user.findUnique.mockResolvedValue(null);

    expect(await activeOrgForSession(USER_ID, db)).toEqual({
      orgId: INSTALL_ORG_ID,
      healed: false,
    });
    expect(mocks.orgMembership.upsert).not.toHaveBeenCalled();
  });
});
