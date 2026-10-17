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
const mockEnv = vi.hoisted((): { TENANCY_MODE: 'single' | 'multi' } => ({
  TENANCY_MODE: 'single',
}));
vi.mock('@/lib/env', () => ({ env: mockEnv }));

import {
  activeOrgForSession,
  backfillInstallMemberships,
  INSTALL_BACKFILL_BATCH,
  initialMembershipFor,
  membershipForNewUser,
  membershipsForNewUser,
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
  mockEnv.TENANCY_MODE = 'single';
  mocks.orgMembership.count.mockResolvedValue(0);
  mocks.orgMembership.findMany.mockResolvedValue([]);
  mocks.orgMembership.upsert.mockResolvedValue(undefined);
  mocks.user.findUnique.mockResolvedValue(null);
});

describe('membershipsForNewUser (#872)', () => {
  const invitee = { role: DEFAULT_USER_ROLE, accountType: 'HUMAN' };

  it('adds the install-org floor for an invitee into another org at single', async () => {
    mocks.orgMembership.count.mockResolvedValue(2);

    expect(await membershipsForNewUser(invitee, { orgId: OTHER_ORG }, db)).toEqual({
      membership: { orgId: OTHER_ORG, role: DEFAULT_ORG_ROLE },
      installMembership: { orgId: INSTALL_ORG_ID, role: DEFAULT_ORG_ROLE },
    });
  });

  it('judges the floor on the platform role the invitation grants', async () => {
    mocks.orgMembership.count.mockResolvedValue(2);

    const { installMembership } = await membershipsForNewUser(
      invitee,
      { orgId: OTHER_ORG, role: PLATFORM_ADMIN_ROLE },
      db
    );
    expect(installMembership).toEqual({ orgId: INSTALL_ORG_ID, role: ORG_OWNER_ROLE });
  });

  it('adds no floor at multi, where the install org is the vendor’s', async () => {
    mockEnv.TENANCY_MODE = 'multi';
    mocks.orgMembership.count.mockResolvedValue(2);

    expect(await membershipsForNewUser(invitee, { orgId: OTHER_ORG }, db)).toEqual({
      membership: { orgId: OTHER_ORG, role: DEFAULT_ORG_ROLE },
    });
  });

  it('adds no second membership when the invitation is into the install org', async () => {
    expect(await membershipsForNewUser(invitee, null, db)).toEqual({
      membership: { orgId: INSTALL_ORG_ID, role: DEFAULT_ORG_ROLE },
    });
  });
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

  // The install-org role follows the platform role; an orgRole on an
  // invitation written before the route refused one is ignored (#871).
  it.each([{ orgId: INSTALL_ORG_ID }, {}])(
    'ignores an orgRole on the install org (%j) and applies the platform-role rule',
    async (org) => {
      const row = { role: DEFAULT_USER_ROLE, accountType: 'HUMAN' };
      expect(await membershipForNewUser(row, { ...org, orgRole: ORG_OWNER_ROLE }, db)).toEqual({
        orgId: INSTALL_ORG_ID,
        role: DEFAULT_ORG_ROLE,
      });
    }
  );

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

// t-835: the operator backfill for accounts invited into another org before
// #872's floor. The two delegates are backed by one in-memory table, so "a
// second run writes nothing" is asserted against state the first run changed.
describe('backfillInstallMemberships (t-835)', () => {
  type Row = { orgId: string; userId: string; role: string };
  const users = [
    { id: 'u-floorless', role: DEFAULT_USER_ROLE, accountType: 'HUMAN' },
    { id: 'u-admin', role: PLATFORM_ADMIN_ROLE, accountType: 'HUMAN' },
    { id: 'u-service', role: PLATFORM_ADMIN_ROLE, accountType: 'SERVICE' },
    { id: 'u-has-floor', role: DEFAULT_USER_ROLE, accountType: 'HUMAN' },
  ];
  let rows: Row[];

  const store = {
    user: {
      findMany: vi.fn(async ({ take }: { take: number }) =>
        users
          .filter((u) => !rows.some((r) => r.userId === u.id && r.orgId === INSTALL_ORG_ID))
          .slice(0, take)
      ),
    },
    orgMembership: {
      createMany: vi.fn(async ({ data }: { data: Row[] }) => {
        rows.push(...data);
        return { count: data.length };
      }),
    },
  };
  const storeDb = store as unknown as Pick<PrismaClient, 'orgMembership' | 'user'>;

  beforeEach(() => {
    rows = [
      // Invited into another org before #872: only that org's row.
      { orgId: OTHER_ORG, userId: 'u-floorless', role: DEFAULT_ORG_ROLE },
      { orgId: OTHER_ORG, userId: 'u-admin', role: ORG_ADMIN_ROLE },
      // Already has the floor, as an ADMIN an operator set by hand.
      { orgId: INSTALL_ORG_ID, userId: 'u-has-floor', role: ORG_ADMIN_ROLE },
    ];
  });

  it('at single, gives each user missing one an install-org row by the platform-role rule', async () => {
    expect(await backfillInstallMemberships(storeDb)).toEqual({ written: 3 });

    expect(store.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { orgMemberships: { none: { orgId: INSTALL_ORG_ID } } },
      })
    );
    const install = rows.filter((r) => r.orgId === INSTALL_ORG_ID);
    expect(install).toEqual(
      expect.arrayContaining([
        { orgId: INSTALL_ORG_ID, userId: 'u-floorless', role: DEFAULT_ORG_ROLE },
        { orgId: INSTALL_ORG_ID, userId: 'u-admin', role: ORG_OWNER_ROLE },
        // The SERVICE config-owner holds platform ADMIN but stays MEMBER.
        { orgId: INSTALL_ORG_ID, userId: 'u-service', role: DEFAULT_ORG_ROLE },
        // Left exactly as it was.
        { orgId: INSTALL_ORG_ID, userId: 'u-has-floor', role: ORG_ADMIN_ROLE },
      ])
    );
    expect(install).toHaveLength(4);
  });

  it('writes nothing the second time', async () => {
    await backfillInstallMemberships(storeDb);
    const after = [...rows];
    store.orgMembership.createMany.mockClear();

    expect(await backfillInstallMemberships(storeDb)).toEqual({ written: 0 });
    expect(store.orgMembership.createMany).not.toHaveBeenCalled();
    expect(rows).toEqual(after);
  });

  it('works through more users than one batch holds', async () => {
    const many = Array.from({ length: INSTALL_BACKFILL_BATCH * 2 + 1 }, (_, i) => ({
      id: `u-bulk-${String(i).padStart(4, '0')}`,
      role: DEFAULT_USER_ROLE,
      accountType: 'HUMAN',
    }));
    users.push(...many);
    try {
      const result = await backfillInstallMemberships(storeDb);

      expect(result.written).toBe(many.length + 3);
      expect(store.orgMembership.createMany).toHaveBeenCalledTimes(3);
      for (const [args] of store.orgMembership.createMany.mock.calls) {
        expect(args.data.length).toBeLessThanOrEqual(INSTALL_BACKFILL_BATCH);
      }
    } finally {
      users.splice(users.length - many.length, many.length);
    }
  });

  it('refuses at multi and reads or writes nothing', async () => {
    mockEnv.TENANCY_MODE = 'multi';
    const before = [...rows];

    await expect(backfillInstallMemberships(storeDb)).rejects.toThrow(/multi/);
    expect(store.user.findMany).not.toHaveBeenCalled();
    expect(store.orgMembership.createMany).not.toHaveBeenCalled();
    expect(rows).toEqual(before);
  });
});
