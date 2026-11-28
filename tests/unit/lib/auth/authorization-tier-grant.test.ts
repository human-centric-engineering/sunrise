/**
 * Tests: the default policy on a named tier registered without its own
 * holds() (t-1123) — held by a MEMBER whose membership's grant lists it.
 *
 * The registry and the policy are the real ones, reached through the lazy
 * init as in production; only the membership read is a double. The grant's
 * own rules are `tests/unit/lib/tenancy/tier-grants.test.ts`; here, that the
 * policy asks it, for the tier the surface declared, and reads its answer.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

const fork = vi.hoisted(() => ({ init: (): void => {} }));
vi.mock('@/lib/app/admin-tier', () => ({
  initAppOrgTierAdminPages: () => fork.init(),
}));
vi.mock('@/lib/logging', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
const db = vi.hoisted(() => ({ orgMembership: { findUnique: vi.fn() } }));
vi.mock('@/lib/db/client', () => ({ prisma: db }));

import { logger } from '@/lib/logging';
import {
  DEFAULT_AUTHORIZATION_POLICY as policy,
  type AuthorizationPrincipal,
  type AuthorizationScope,
} from '@/lib/auth/authorization';
import { registerAdminTier, registerOrgTierAdminPage } from '@/lib/auth/admin-tier';
import { __resetAppOrgTierAdminPagesForTests } from '@/lib/auth/org-tier-admin-pages';
import { env } from '@/lib/env';

const ORG = 'cmorg00000000000000000orga';
const MEMBER: AuthorizationPrincipal = {
  userId: 'member-1',
  role: 'USER',
  credential: 'session',
  orgId: ORG,
  orgRole: 'MEMBER',
};
const MEDIA: AuthorizationScope = { org: ORG, tier: 'media' };
const BRAND: AuthorizationScope = { org: ORG, tier: 'brand' };
const ORG_TIER: AuthorizationScope = { org: ORG, tier: 'org' };

/** The membership row the grant is read from: MEMBER, granted `media`. */
const grantedMedia = { role: 'MEMBER', grant: { tiers: ['media'] } };

let previousMode: typeof env.TENANCY_MODE;
beforeEach(() => {
  previousMode = env.TENANCY_MODE;
  env.TENANCY_MODE = 'multi';
  __resetAppOrgTierAdminPagesForTests();
  db.orgMembership.findUnique.mockReset().mockResolvedValue(grantedMedia);
  fork.init = () => {
    registerAdminTier('media', {});
    registerAdminTier('brand', {});
    registerOrgTierAdminPage('/admin/media', { tier: 'media' });
  };
});
afterEach(() => {
  env.TENANCY_MODE = previousMode;
  __resetAppOrgTierAdminPagesForTests();
  vi.clearAllMocks();
});

describe('a named tier held by the grant (t-1123)', () => {
  it('admits a MEMBER whose grant lists the tier, reading their own membership', async () => {
    await expect(policy.canAdminister(MEMBER, null, MEDIA)).resolves.toBe(true);
    expect(db.orgMembership.findUnique).toHaveBeenCalledWith({
      where: { orgId_userId: { orgId: ORG, userId: 'member-1' } },
      select: { role: true, grant: { select: { tiers: true } } },
    });
  });

  it('refuses the same MEMBER a tier the grant does not list', async () => {
    // The control above admits them to `media`; `brand` is not granted.
    await expect(policy.canAdminister(MEMBER, null, BRAND)).resolves.toBe(false);
  });

  it('opens no org-tier surface to a holder', async () => {
    await expect(policy.canAdminister(MEMBER, null, ORG_TIER)).resolves.toBe(false);
  });

  it('refuses a MEMBER with no grant', async () => {
    db.orgMembership.findUnique.mockResolvedValue({ role: 'MEMBER', grant: null });
    await expect(policy.canAdminister(MEMBER, null, MEDIA)).resolves.toBe(false);
  });

  it('refuses, and logs with the tier, when the grant cannot be read', async () => {
    db.orgMembership.findUnique.mockRejectedValue(new Error('db down'));
    await expect(policy.canAdminister(MEMBER, null, MEDIA)).resolves.toBe(false);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('could not say who holds it'),
      expect.objectContaining({ tier: 'media', userId: 'member-1' })
    );
  });

  it('admits nobody by the grant at single, as every org-tier arm', async () => {
    env.TENANCY_MODE = 'single';
    await expect(policy.canAdminister(MEMBER, null, MEDIA)).resolves.toBe(false);
    expect(db.orgMembership.findUnique).not.toHaveBeenCalled();
  });

  it('admits the org’s ADMIN without reading a grant', async () => {
    await expect(policy.canAdminister({ ...MEMBER, orgRole: 'ADMIN' }, null, MEDIA)).resolves.toBe(
      true
    );
    expect(db.orgMembership.findUnique).not.toHaveBeenCalled();
  });
});
