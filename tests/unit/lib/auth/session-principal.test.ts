/**
 * Tests: the principal a session is outside a guard (§111 t-810)
 *
 * The admin layout and the maintenance bypass describe a session to the
 * policy with the org the guards would enter and the verified role in it. A
 * refused entry, or a membership read that throws, yields no org facts — the
 * closed answer for every org-scoped arm — rather than a refusal.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';

const mockEnv = vi.hoisted(() => ({ TENANCY_MODE: 'multi' }));
vi.mock('@/lib/env', () => ({ env: mockEnv }));
const findUnique = vi.hoisted(() => vi.fn());
const findFirst = vi.hoisted(() => vi.fn());
vi.mock('@/lib/db/client', () => ({
  prisma: { orgMembership: { findUnique }, orgSupportGrant: { findFirst } },
}));
vi.mock('@/lib/logging', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { sessionPrincipal } from '@/lib/auth/session-principal';
import { logger } from '@/lib/logging';

const ORG = 'cmorg0000000000000000orga';
const session = (activeOrgId: string | null, role = 'USER') => ({
  user: { id: 'user-1', role },
  session: { activeOrgId },
});

beforeEach(() => {
  vi.clearAllMocks();
  mockEnv.TENANCY_MODE = 'multi';
  findFirst.mockResolvedValue(null);
});

describe('sessionPrincipal', () => {
  it('carries the entered org and the verified role in it, as the guards do', async () => {
    findUnique.mockResolvedValue({ role: 'ADMIN', org: { status: 'ACTIVE' } });
    await expect(sessionPrincipal(session(ORG), null)).resolves.toEqual({
      principal: {
        userId: 'user-1',
        role: 'USER',
        credential: 'session',
        orgId: ORG,
        orgRole: 'ADMIN',
      },
      scope: { org: ORG },
    });
  });

  it('lets the resolver header pick the org, verified like the session’s own choice', async () => {
    findUnique.mockResolvedValue({ role: 'OWNER', org: { status: 'ACTIVE' } });
    const { principal } = await sessionPrincipal(session(INSTALL_ORG_ID), ORG);
    expect(principal).toMatchObject({ orgId: ORG, orgRole: 'OWNER' });
  });

  it.each([
    ['not a member', null, 'not-a-member'],
    ['a suspended org', { role: 'OWNER', org: { status: 'SUSPENDED' } }, 'org-suspended'],
  ])(
    'carries no org facts, and says why, when the entry is refused — %s',
    async (_label, row, why) => {
      findUnique.mockResolvedValue(row);
      await expect(sessionPrincipal(session(ORG), null)).resolves.toEqual({
        principal: { userId: 'user-1', role: 'USER', credential: 'session' },
        scope: {},
        refused: why,
      });
    }
  );

  it('a support session presents the default user role and carries the grant (§121 t-824)', async () => {
    findUnique.mockResolvedValue(null);
    const expiresAt = new Date(Date.now() + 3_600_000);
    findFirst.mockResolvedValue({ id: 'grant-1', level: 'READ_ONLY', expiresAt });
    await expect(sessionPrincipal(session(ORG, 'ADMIN'), null)).resolves.toEqual({
      principal: {
        userId: 'user-1',
        role: 'USER',
        credential: 'session',
        orgId: ORG,
        orgRole: 'ADMIN',
      },
      scope: { org: ORG },
      support: { grantId: 'grant-1', level: 'READ_ONLY', expiresAt },
    });
  });

  it('a platform admin whose grant has ended keeps their role and no org facts', async () => {
    findUnique.mockResolvedValue(null);
    await expect(sessionPrincipal(session(ORG, 'ADMIN'), null)).resolves.toEqual({
      principal: { userId: 'user-1', role: 'ADMIN', credential: 'session' },
      scope: {},
      refused: 'not-a-member',
    });
  });

  it('carries no org facts, and logs, when the membership read throws', async () => {
    findUnique.mockRejectedValue(new Error('pool exhausted'));
    await expect(sessionPrincipal(session(ORG, 'ADMIN'), null)).resolves.toEqual({
      principal: { userId: 'user-1', role: 'ADMIN', credential: 'session' },
      scope: {},
    });
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('could not enter'),
      expect.any(Error),
      { userId: 'user-1' }
    );
  });

  it('enters the install org at single with the projected role and no read', async () => {
    mockEnv.TENANCY_MODE = 'single';
    const { principal } = await sessionPrincipal(session(null, 'ADMIN'), null);
    expect(principal).toMatchObject({ orgId: INSTALL_ORG_ID, orgRole: 'OWNER' });
    expect(findUnique).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
  });
});
