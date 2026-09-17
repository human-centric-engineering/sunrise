/**
 * Tests: lib/tenancy/entry.ts — the read rule the guards apply (§106)
 *
 * Every arm, both modes, both credentials — and the property the design
 * rests on: at `single` the install org is entered with NO membership read
 * (asserted by the mock never being called), while any other org, a resolver
 * header, or `multi` reads and verifies the row.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { DEFAULT_ORG_ROLE, ORG_ADMIN_ROLE, ORG_OWNER_ROLE } from '@/lib/tenancy/roles';

const mockEnv = vi.hoisted(() => ({ TENANCY_MODE: 'single' }));
vi.mock('@/lib/env', () => ({ env: mockEnv }));
vi.mock('@/lib/db/client', () => ({ prisma: {} }));
vi.mock('@/lib/logging', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { enterApiKeyOrg, enterSessionOrg, isOrgRefusal } from '@/lib/tenancy/entry';

const findUnique = vi.fn();
const db = { orgMembership: { findUnique } } as unknown as Pick<PrismaClient, 'orgMembership'>;

const OTHER = 'cmorg000000000000000other';
const USER = { id: 'cmuser00000000000000user1', role: 'USER', accountType: 'HUMAN' };
const ADMIN = { id: 'cmuser0000000000000admin1', role: 'ADMIN', accountType: 'HUMAN' };

function memberOf(role: string, status: 'ACTIVE' | 'SUSPENDED' = 'ACTIVE') {
  findUnique.mockResolvedValue({ role, org: { status } });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEnv.TENANCY_MODE = 'single';
  findUnique.mockResolvedValue(null);
});

describe('enterSessionOrg at single', () => {
  it('a null activeOrgId enters the install org with the platform role projected — no read', async () => {
    expect(await enterSessionOrg(USER, null, null, db)).toEqual({
      orgId: INSTALL_ORG_ID,
      role: DEFAULT_ORG_ROLE,
      source: 'session',
    });
    expect(await enterSessionOrg(ADMIN, undefined, null, db)).toEqual({
      orgId: INSTALL_ORG_ID,
      role: ORG_OWNER_ROLE,
      source: 'session',
    });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('the install org named explicitly is the same answer, still no read', async () => {
    expect(await enterSessionOrg(USER, INSTALL_ORG_ID, null, db)).toMatchObject({
      orgId: INSTALL_ORG_ID,
      role: DEFAULT_ORG_ROLE,
    });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('the SERVICE account projects to MEMBER, as the migration and the hook do', async () => {
    expect(
      await enterSessionOrg({ ...ADMIN, accountType: 'SERVICE' }, null, null, db)
    ).toMatchObject({ role: DEFAULT_ORG_ROLE });
  });

  it('another org is read and verified: member → that org with the row’s role', async () => {
    memberOf(ORG_ADMIN_ROLE);
    expect(await enterSessionOrg(USER, OTHER, null, db)).toEqual({
      orgId: OTHER,
      role: ORG_ADMIN_ROLE,
      source: 'session',
    });
    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { orgId_userId: { orgId: OTHER, userId: USER.id } } })
    );
  });

  it('another org the caller is not a member of is refused', async () => {
    const result = await enterSessionOrg(USER, OTHER, null, db);
    expect(isOrgRefusal(result) && result.refused).toBe('not-a-member');
  });

  it('a suspended org is refused to its own member', async () => {
    memberOf(ORG_OWNER_ROLE, 'SUSPENDED');
    const result = await enterSessionOrg(USER, OTHER, null, db);
    expect(isOrgRefusal(result) && result.refused).toBe('org-suspended');
  });
});

describe('enterSessionOrg with a resolver header', () => {
  it('the header wins over the session’s org, verified the same way', async () => {
    memberOf(DEFAULT_ORG_ROLE);
    expect(await enterSessionOrg(USER, INSTALL_ORG_ID, OTHER, db)).toEqual({
      orgId: OTHER,
      role: DEFAULT_ORG_ROLE,
      source: 'resolver',
    });
  });

  it('a header naming an org the caller is not in is refused — the header picks, it never grants', async () => {
    const result = await enterSessionOrg(ADMIN, INSTALL_ORG_ID, OTHER, db);
    expect(isOrgRefusal(result) && result.refused).toBe('not-a-member');
  });

  it('a header naming the install org is verified too — even at single, even for an admin', async () => {
    // The shortcut is for the SESSION's own answer; a resolver said "this
    // request is for the install org", and a resolver's word is checked.
    const result = await enterSessionOrg(ADMIN, null, INSTALL_ORG_ID, db);
    expect(isOrgRefusal(result) && result.refused).toBe('not-a-member');
    expect(findUnique).toHaveBeenCalled();
  });
});

describe('enterSessionOrg at multi', () => {
  beforeEach(() => {
    mockEnv.TENANCY_MODE = 'multi';
  });

  it('a null activeOrgId is refused — there is no implicit org', async () => {
    const result = await enterSessionOrg(USER, null, null, db);
    expect(isOrgRefusal(result) && result.refused).toBe('no-org');
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('the install org is read and verified like any other', async () => {
    memberOf(ORG_OWNER_ROLE);
    expect(await enterSessionOrg(USER, INSTALL_ORG_ID, null, db)).toMatchObject({
      orgId: INSTALL_ORG_ID,
      role: ORG_OWNER_ROLE,
    });
    expect(findUnique).toHaveBeenCalledTimes(1);
  });

  it('a memberless user is refused at the install org too', async () => {
    const result = await enterSessionOrg(USER, INSTALL_ORG_ID, null, db);
    expect(isOrgRefusal(result)).toBe(true);
  });
});

describe('enterApiKeyOrg', () => {
  const owner = { role: 'USER', accountType: 'HUMAN' };

  it('an admin-scoped key is a platform credential: no org, in either mode', async () => {
    for (const mode of ['single', 'multi'] as const) {
      mockEnv.TENANCY_MODE = mode;
      expect(
        await enterApiKeyOrg({ userId: USER.id, scopes: ['admin'], orgId: OTHER, owner }, db)
      ).toBeNull();
    }
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('a key with no org enters the install org at single, as its owner would — no read', async () => {
    expect(
      await enterApiKeyOrg({ userId: USER.id, scopes: ['chat'], orgId: null, owner }, db)
    ).toEqual({ orgId: INSTALL_ORG_ID, role: DEFAULT_ORG_ROLE, source: 'api-key' });
    expect(
      await enterApiKeyOrg(
        { userId: ADMIN.id, scopes: ['chat'], orgId: null, owner: { role: 'ADMIN' } },
        db
      )
    ).toMatchObject({ role: ORG_OWNER_ROLE });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('a key with no org is refused at multi (the interim state t-673 closes)', async () => {
    mockEnv.TENANCY_MODE = 'multi';
    const result = await enterApiKeyOrg(
      { userId: USER.id, scopes: ['chat'], orgId: null, owner },
      db
    );
    expect(result && isOrgRefusal(result) && result.refused).toBe('no-org');
  });

  it('a key bound to another org is verified against its owner’s membership', async () => {
    memberOf(DEFAULT_ORG_ROLE);
    expect(
      await enterApiKeyOrg({ userId: USER.id, scopes: ['chat'], orgId: OTHER, owner }, db)
    ).toEqual({ orgId: OTHER, role: DEFAULT_ORG_ROLE, source: 'api-key' });

    findUnique.mockResolvedValue(null);
    const gone = await enterApiKeyOrg(
      { userId: USER.id, scopes: ['chat'], orgId: OTHER, owner },
      db
    );
    expect(gone && isOrgRefusal(gone) && gone.refused).toBe('not-a-member');
  });
});
