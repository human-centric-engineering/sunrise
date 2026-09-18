/**
 * Tests: lib/tenancy/lifecycle.ts — the org write path and its rules (§106 t-672)
 *
 * Every rule the module states is a case here, each written so the WRONG
 * behaviour fails it: the last-OWNER guard is exercised on a populated org
 * (two members, one OWNER) and shown to pass once a second OWNER stands; the
 * install-org refusals are asserted to happen BEFORE any read or write; the
 * removal is shown to revoke only the sessions in that org.
 *
 * Prisma is a double at the delegate level; `$transaction` hands the same
 * double back as the transaction client, so what runs inside a transaction
 * is asserted on the same mocks. `revokeUserSessions` is mocked at the
 * module — its own test covers the filter.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { INSTALL_ORG_ID, INSTALL_ORG_SLUG } from '@/lib/tenancy/constants';
import { DEFAULT_ORG_ROLE, ORG_ADMIN_ROLE, ORG_OWNER_ROLE } from '@/lib/tenancy/roles';
import { PLATFORM_ADMIN_ROLE, DEFAULT_USER_ROLE } from '@/lib/auth/roles';

const db = vi.hoisted(() => ({
  org: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
  orgMembership: {
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    count: vi.fn(),
    upsert: vi.fn(),
  },
  user: { findUnique: vi.fn() },
  $transaction: vi.fn(),
}));
vi.mock('@/lib/db/client', () => ({ prisma: db }));

const mockRevoke = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/sessions', () => ({ revokeUserSessions: mockRevoke }));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  addMember,
  changeMemberRole,
  createOrg,
  OrgLifecycleError,
  removeMember,
  resolveOrgResource,
  syncInstallMembershipRole,
  updateOrg,
} from '@/lib/tenancy/lifecycle';
import { APIError } from '@/lib/api/errors';

const ORG = 'cmorg000000000000000other';
const OWNER = 'cmjbv4i3x00003wsloputgwul';
const OTHER = 'cmjbv4i3x00005wsloputgwuy';

const orgRow = (over: Partial<{ id: string; slug: string; status: string }> = {}) => ({
  id: ORG,
  slug: 'other',
  name: 'Other Org',
  status: 'ACTIVE',
  createdAt: new Date('2026-09-01'),
  updatedAt: new Date('2026-09-01'),
  ...over,
});

const human = (id: string, role: string = DEFAULT_USER_ROLE) => ({
  id,
  role,
  accountType: 'HUMAN',
});

async function refusal(fn: () => Promise<unknown>): Promise<OrgLifecycleError> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof OrgLifecycleError) return error;
    throw error;
  }
  throw new Error('expected an OrgLifecycleError');
}

beforeEach(() => {
  vi.clearAllMocks();
  // The transaction client IS the double, so writes inside are visible.
  db.$transaction.mockImplementation((fn: (tx: typeof db) => Promise<unknown>) => fn(db));
  mockRevoke.mockResolvedValue(0);
});

describe('OrgLifecycleError', () => {
  it('is an APIError carrying its code and status, so the guard maps it', () => {
    const error = new OrgLifecycleError('LAST_OWNER', 'no');
    expect(error).toBeInstanceOf(APIError);
    expect(error.code).toBe('LAST_OWNER');
    expect(error.status).toBe(400);
    expect(new OrgLifecycleError('ORG_NOT_FOUND', 'no').status).toBe(404);
    expect(new OrgLifecycleError('SLUG_TAKEN', 'no').status).toBe(409);
    expect(new OrgLifecycleError('ALREADY_MEMBER', 'no').status).toBe(409);
  });
});

describe('createOrg', () => {
  it('creates the org and names the founding OWNER in the same transaction', async () => {
    db.org.findUnique.mockResolvedValue(null); // slug free
    db.user.findUnique.mockResolvedValue(human(OWNER));
    db.org.create.mockResolvedValue(orgRow());

    const org = await createOrg({ slug: 'other', name: 'Other Org', ownerUserId: OWNER });

    expect(org.id).toBe(ORG);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(db.orgMembership.create).toHaveBeenCalledWith({
      data: { orgId: ORG, userId: OWNER, role: ORG_OWNER_ROLE },
    });
  });

  it('creates an owner-less org when no owner is named', async () => {
    db.org.findUnique.mockResolvedValue(null);
    db.org.create.mockResolvedValue(orgRow());

    await createOrg({ slug: 'other', name: 'Other Org' });

    expect(db.user.findUnique).not.toHaveBeenCalled();
    expect(db.orgMembership.create).not.toHaveBeenCalled();
  });

  it('refuses a taken slug before writing anything', async () => {
    db.org.findUnique.mockResolvedValue({ id: 'someone-else' });

    const error = await refusal(() => createOrg({ slug: 'other', name: 'x' }));

    expect(error.code).toBe('SLUG_TAKEN');
    expect(db.org.create).not.toHaveBeenCalled();
  });

  it('refuses a missing owner, and the SERVICE account, without creating the org', async () => {
    db.org.findUnique.mockResolvedValue(null);
    db.user.findUnique.mockResolvedValueOnce(null);
    expect(
      (await refusal(() => createOrg({ slug: 'a', name: 'x', ownerUserId: OWNER }))).code
    ).toBe('USER_NOT_FOUND');

    db.user.findUnique.mockResolvedValueOnce({
      id: OWNER,
      role: PLATFORM_ADMIN_ROLE,
      accountType: 'SERVICE',
    });
    expect(
      (await refusal(() => createOrg({ slug: 'a', name: 'x', ownerUserId: OWNER }))).code
    ).toBe('USER_NOT_FOUND');

    expect(db.org.create).not.toHaveBeenCalled();
  });
});

describe('updateOrg', () => {
  it('renames, re-slugs and suspends an ordinary org', async () => {
    db.org.findUnique.mockResolvedValueOnce(orgRow()).mockResolvedValueOnce(null); // the org; slug free
    db.org.update.mockResolvedValue(orgRow({ slug: 'renamed', status: 'SUSPENDED' }));

    const updated = await updateOrg(ORG, { name: 'Renamed', slug: 'renamed', status: 'SUSPENDED' });

    expect(updated.status).toBe('SUSPENDED');
    expect(db.org.update).toHaveBeenCalledWith({
      where: { id: ORG },
      data: { name: 'Renamed', slug: 'renamed', status: 'SUSPENDED' },
      select: expect.any(Object),
    });
  });

  it('is a 404 for an org that does not exist', async () => {
    db.org.findUnique.mockResolvedValue(null);
    expect((await refusal(() => updateOrg(ORG, { name: 'x' }))).code).toBe('ORG_NOT_FOUND');
  });

  it('refuses to suspend the install org (ruling b), and never writes', async () => {
    db.org.findUnique.mockResolvedValue(orgRow({ id: INSTALL_ORG_ID, slug: INSTALL_ORG_SLUG }));

    const error = await refusal(() => updateOrg(INSTALL_ORG_ID, { status: 'SUSPENDED' }));

    expect(error.code).toBe('INSTALL_ORG_IMMUTABLE');
    expect(error.status).toBe(400);
    expect(db.org.update).not.toHaveBeenCalled();
  });

  it('refuses to re-slug the install org but lets it be renamed', async () => {
    db.org.findUnique.mockResolvedValue(orgRow({ id: INSTALL_ORG_ID, slug: INSTALL_ORG_SLUG }));
    expect((await refusal(() => updateOrg(INSTALL_ORG_ID, { slug: 'acme' }))).code).toBe(
      'INSTALL_ORG_IMMUTABLE'
    );

    db.org.update.mockResolvedValue(orgRow({ id: INSTALL_ORG_ID, slug: INSTALL_ORG_SLUG }));
    await updateOrg(INSTALL_ORG_ID, { name: 'Acme Ltd' });
    expect(db.org.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: INSTALL_ORG_ID }, data: { name: 'Acme Ltd' } })
    );
  });

  it('tolerates the install org being told its own status and slug again', async () => {
    // A PATCH that echoes the current values is not a change.
    db.org.findUnique.mockResolvedValue(orgRow({ id: INSTALL_ORG_ID, slug: INSTALL_ORG_SLUG }));
    db.org.update.mockResolvedValue(orgRow({ id: INSTALL_ORG_ID, slug: INSTALL_ORG_SLUG }));
    await expect(
      updateOrg(INSTALL_ORG_ID, { status: 'ACTIVE', slug: INSTALL_ORG_SLUG })
    ).resolves.toBeDefined();
  });

  it('refuses a slug another org holds', async () => {
    db.org.findUnique.mockResolvedValueOnce(orgRow()).mockResolvedValueOnce({ id: 'someone-else' });
    expect((await refusal(() => updateOrg(ORG, { slug: 'taken' }))).code).toBe('SLUG_TAKEN');
    expect(db.org.update).not.toHaveBeenCalled();
  });
});

describe('addMember', () => {
  beforeEach(() => {
    db.org.findUnique.mockResolvedValue(orgRow());
    db.user.findUnique.mockResolvedValue(human(OTHER));
    db.orgMembership.findUnique.mockResolvedValue(null);
    db.orgMembership.create.mockImplementation(({ data }: { data: object }) =>
      Promise.resolve({ id: 'm1', createdAt: new Date(), updatedAt: new Date(), ...data })
    );
  });

  it('adds with the role asked for', async () => {
    db.orgMembership.count.mockResolvedValue(3);
    const membership = await addMember(ORG, OTHER, ORG_ADMIN_ROLE);
    expect(membership.role).toBe(ORG_ADMIN_ROLE);
    // An explicit role is honoured even on an empty org — the caller chose it.
    expect(db.orgMembership.count).not.toHaveBeenCalled();
  });

  it('defaults to MEMBER in a populated org, and OWNER for the first member of an empty one', async () => {
    db.orgMembership.count.mockResolvedValueOnce(2);
    expect((await addMember(ORG, OTHER, undefined)).role).toBe(DEFAULT_ORG_ROLE);

    db.orgMembership.count.mockResolvedValueOnce(0);
    expect((await addMember(ORG, OTHER, undefined)).role).toBe(ORG_OWNER_ROLE);
  });

  it('is a 409 for an existing member', async () => {
    db.orgMembership.findUnique.mockResolvedValue({ id: 'm0' });
    const error = await refusal(() => addMember(ORG, OTHER, undefined));
    expect(error.code).toBe('ALREADY_MEMBER');
    expect(error.status).toBe(409);
    expect(db.orgMembership.create).not.toHaveBeenCalled();
  });

  it('is a 404 for a missing org, and for a missing or SERVICE user', async () => {
    db.org.findUnique.mockResolvedValueOnce(null);
    expect((await refusal(() => addMember(ORG, OTHER, undefined))).code).toBe('ORG_NOT_FOUND');

    db.user.findUnique.mockResolvedValueOnce(null);
    expect((await refusal(() => addMember(ORG, OTHER, undefined))).code).toBe('USER_NOT_FOUND');

    db.user.findUnique.mockResolvedValueOnce({ id: OTHER, role: 'ADMIN', accountType: 'SERVICE' });
    expect((await refusal(() => addMember(ORG, OTHER, undefined))).code).toBe('USER_NOT_FOUND');
    expect(db.orgMembership.create).not.toHaveBeenCalled();
  });

  describe('on the install org', () => {
    beforeEach(() => {
      db.org.findUnique.mockResolvedValue(orgRow({ id: INSTALL_ORG_ID, slug: INSTALL_ORG_SLUG }));
    });

    it('refuses a role from the body — the role follows the platform role', async () => {
      const error = await refusal(() => addMember(INSTALL_ORG_ID, OTHER, ORG_OWNER_ROLE));
      expect(error.code).toBe('INSTALL_ORG_MEMBERSHIP');
      expect(db.orgMembership.create).not.toHaveBeenCalled();
    });

    it('writes the rule’s answer: OWNER for a human platform admin, MEMBER otherwise', async () => {
      db.user.findUnique.mockResolvedValueOnce(human(OTHER, PLATFORM_ADMIN_ROLE));
      expect((await addMember(INSTALL_ORG_ID, OTHER, undefined)).role).toBe(ORG_OWNER_ROLE);

      db.user.findUnique.mockResolvedValueOnce(human(OTHER));
      expect((await addMember(INSTALL_ORG_ID, OTHER, undefined)).role).toBe(DEFAULT_ORG_ROLE);
      // The count arm is not consulted: the install org's rule is the platform role.
      expect(db.orgMembership.count).not.toHaveBeenCalled();
    });
  });
});

describe('changeMemberRole — the last-OWNER guard', () => {
  beforeEach(() => {
    db.orgMembership.update.mockImplementation(
      ({
        where,
        data,
      }: {
        where: { orgId_userId: { orgId: string; userId: string } };
        data: { role: string };
      }) =>
        Promise.resolve({
          id: 'm1',
          orgId: where.orgId_userId.orgId,
          userId: where.orgId_userId.userId,
          role: data.role,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
    );
  });

  it('refuses to demote the only OWNER of a populated org', async () => {
    // Two members: one OWNER, one MEMBER. Demoting the OWNER would leave
    // nobody who can administer the org.
    db.orgMembership.findUnique.mockResolvedValue({ role: ORG_OWNER_ROLE });
    db.orgMembership.count.mockResolvedValue(1);

    const error = await refusal(() => changeMemberRole(ORG, OWNER, DEFAULT_ORG_ROLE));

    expect(error.code).toBe('LAST_OWNER');
    expect(error.status).toBe(400);
    expect(db.orgMembership.count).toHaveBeenCalledWith({
      where: { orgId: ORG, role: ORG_OWNER_ROLE },
    });
    expect(db.orgMembership.update).not.toHaveBeenCalled();
    // The read, the count and the (refused) write share one transaction.
    expect(db.$transaction).toHaveBeenCalledTimes(1);
  });

  it('demotes an OWNER once a second OWNER stands', async () => {
    db.orgMembership.findUnique.mockResolvedValue({ role: ORG_OWNER_ROLE });
    db.orgMembership.count.mockResolvedValue(2);

    const updated = await changeMemberRole(ORG, OWNER, ORG_ADMIN_ROLE);

    expect(updated.role).toBe(ORG_ADMIN_ROLE);
    expect(db.orgMembership.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { orgId_userId: { orgId: ORG, userId: OWNER } },
        data: { role: ORG_ADMIN_ROLE },
      })
    );
  });

  it('promotes without counting — adding an OWNER never needs the guard', async () => {
    db.orgMembership.findUnique.mockResolvedValue({ role: DEFAULT_ORG_ROLE });
    await changeMemberRole(ORG, OTHER, ORG_OWNER_ROLE);
    expect(db.orgMembership.count).not.toHaveBeenCalled();
  });

  it('re-affirming OWNER on the only OWNER is not a demotion', async () => {
    db.orgMembership.findUnique.mockResolvedValue({ role: ORG_OWNER_ROLE });
    await changeMemberRole(ORG, OWNER, ORG_OWNER_ROLE);
    expect(db.orgMembership.count).not.toHaveBeenCalled();
    expect(db.orgMembership.update).toHaveBeenCalled();
  });

  it('is a 404 for a non-member', async () => {
    db.orgMembership.findUnique.mockResolvedValue(null);
    const error = await refusal(() => changeMemberRole(ORG, OTHER, ORG_ADMIN_ROLE));
    expect(error.code).toBe('NOT_A_MEMBER');
    expect(error.status).toBe(404);
  });

  it('refuses the install org before any read', async () => {
    const error = await refusal(() => changeMemberRole(INSTALL_ORG_ID, OWNER, DEFAULT_ORG_ROLE));
    expect(error.code).toBe('INSTALL_ORG_MEMBERSHIP');
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.orgMembership.findUnique).not.toHaveBeenCalled();
  });
});

describe('removeMember', () => {
  it('refuses to remove the only OWNER of a populated org', async () => {
    db.orgMembership.findUnique.mockResolvedValue({ role: ORG_OWNER_ROLE });
    db.orgMembership.count.mockResolvedValue(1);

    const error = await refusal(() => removeMember(ORG, OWNER));

    expect(error.code).toBe('LAST_OWNER');
    expect(db.orgMembership.delete).not.toHaveBeenCalled();
    expect(mockRevoke).not.toHaveBeenCalled();
  });

  it('removes an OWNER once a second OWNER stands, and revokes only their sessions in this org', async () => {
    db.orgMembership.findUnique.mockResolvedValue({ role: ORG_OWNER_ROLE });
    db.orgMembership.count.mockResolvedValue(2);
    mockRevoke.mockResolvedValue(2);

    const result = await removeMember(ORG, OWNER);

    expect(db.orgMembership.delete).toHaveBeenCalledWith({
      where: { orgId_userId: { orgId: ORG, userId: OWNER } },
    });
    expect(mockRevoke).toHaveBeenCalledWith({
      userId: OWNER,
      activeOrgId: ORG,
      reason: 'removed from org',
    });
    expect(result.revokedSessions).toBe(2);
  });

  it('removes a MEMBER without counting owners', async () => {
    db.orgMembership.findUnique.mockResolvedValue({ role: DEFAULT_ORG_ROLE });
    await removeMember(ORG, OTHER);
    expect(db.orgMembership.count).not.toHaveBeenCalled();
    expect(db.orgMembership.delete).toHaveBeenCalled();
  });

  it('is a 404 for a non-member, and revokes nothing', async () => {
    db.orgMembership.findUnique.mockResolvedValue(null);
    expect((await refusal(() => removeMember(ORG, OTHER))).code).toBe('NOT_A_MEMBER');
    expect(mockRevoke).not.toHaveBeenCalled();
  });

  it('refuses the install org before any read — an account leaves it by erasure', async () => {
    const error = await refusal(() => removeMember(INSTALL_ORG_ID, OTHER));
    expect(error.code).toBe('INSTALL_ORG_MEMBERSHIP');
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(mockRevoke).not.toHaveBeenCalled();
  });
});

describe('syncInstallMembershipRole (ruling a)', () => {
  beforeEach(() => {
    db.orgMembership.upsert.mockImplementation(({ update }: { update: { role: string } }) =>
      Promise.resolve({
        id: 'm1',
        orgId: INSTALL_ORG_ID,
        userId: OWNER,
        role: update.role,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
    );
  });

  it('makes a promoted human admin an install OWNER', async () => {
    const membership = await syncInstallMembershipRole(human(OWNER, PLATFORM_ADMIN_ROLE));
    expect(membership.role).toBe(ORG_OWNER_ROLE);
    expect(db.orgMembership.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { orgId_userId: { orgId: INSTALL_ORG_ID, userId: OWNER } },
        update: { role: ORG_OWNER_ROLE },
        create: { orgId: INSTALL_ORG_ID, userId: OWNER, role: ORG_OWNER_ROLE },
      })
    );
  });

  it('makes a demoted admin an install MEMBER — the over-grant the ruling closes', async () => {
    const membership = await syncInstallMembershipRole(human(OWNER, DEFAULT_USER_ROLE));
    expect(membership.role).toBe(DEFAULT_ORG_ROLE);
  });

  it('never makes the SERVICE account an OWNER, whatever its platform role', async () => {
    await syncInstallMembershipRole({
      id: OWNER,
      role: PLATFORM_ADMIN_ROLE,
      accountType: 'SERVICE',
    });
    expect(db.orgMembership.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { role: DEFAULT_ORG_ROLE } })
    );
  });

  it('accepts a transaction client', async () => {
    const tx = { orgMembership: { upsert: vi.fn().mockResolvedValue({ role: DEFAULT_ORG_ROLE }) } };
    await syncInstallMembershipRole(human(OWNER), tx as never);
    expect(tx.orgMembership.upsert).toHaveBeenCalled();
    expect(db.orgMembership.upsert).not.toHaveBeenCalled();
  });
});

describe('resolveOrgResource', () => {
  it('names an existing org as an ownerless org resource', async () => {
    db.org.findUnique.mockResolvedValue({ id: ORG });
    await expect(resolveOrgResource({ id: ORG })).resolves.toEqual({
      kind: 'org',
      id: ORG,
      orgId: ORG,
    });
    // One column, keyed off the URL: it runs before the policy decides.
    expect(db.org.findUnique).toHaveBeenCalledWith({ where: { id: ORG }, select: { id: true } });
  });

  it('answers null — which the guard refuses — for a missing org or a malformed segment', async () => {
    db.org.findUnique.mockResolvedValue(null);
    await expect(resolveOrgResource({ id: ORG })).resolves.toBeNull();

    db.org.findUnique.mockClear();
    await expect(resolveOrgResource({ id: 'has space' })).resolves.toBeNull();
    await expect(resolveOrgResource(undefined)).resolves.toBeNull();
    expect(db.org.findUnique).not.toHaveBeenCalled();
  });
});
