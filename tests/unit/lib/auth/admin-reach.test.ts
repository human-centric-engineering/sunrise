/**
 * Tests: adminReachOf — what one principal opens, for any caller (§143 t-1090)
 *
 * The same answer the admin layout acts on (`requestAdminReach()`, covered in
 * admin-page-viewer.test.ts), now askable with a principal and scope directly,
 * as `GET /api/v1/admin/access` does. Pinned: a platform admin is `'platform'`
 * and nothing more is asked; otherwise each tier and each required switch is
 * the policy's answer, asked with the scope it was given.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/auth/authorization', () => ({ canAdminister: vi.fn() }));
vi.mock('@/lib/logging', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { canAdminister, type AuthorizationScope } from '@/lib/auth/authorization';
import { adminReachOf, lockedSwitchesIn, lockedSwitchesOf } from '@/lib/auth/admin-reach';
import { registerAdminTier, registerOrgTierAdminPage } from '@/lib/auth/admin-tier';
import { __resetAppOrgTierAdminPagesForTests } from '@/lib/auth/org-tier-admin-pages';
import {
  __resetEntitlementRegistryForTests,
  registerEntitlementSwitch,
} from '@/lib/tenancy/entitlements';

const ORG = 'cmorg00000000000000000orga';
const principal = {
  userId: 'u1',
  role: 'USER',
  credential: 'session' as const,
  orgId: ORG,
  orgRole: 'MEMBER',
};
const scope: AuthorizationScope = { org: ORG };

beforeEach(() => {
  vi.clearAllMocks();
  __resetAppOrgTierAdminPagesForTests();
  __resetEntitlementRegistryForTests();
  registerEntitlementSwitch({ key: 'lead_gen', label: 'Lead generation', description: '' });
  registerAdminTier('designers', { holds: () => true });
  registerOrgTierAdminPage('/admin/designs', { tier: 'designers', requires: 'lead_gen' });
});

describe('adminReachOf', () => {
  it('is the platform for a platform admin, and asks nothing further', async () => {
    vi.mocked(canAdminister).mockResolvedValue(true);

    await expect(adminReachOf(principal, scope)).resolves.toBe('platform');
    expect(canAdminister).toHaveBeenCalledTimes(1);
    expect(canAdminister).toHaveBeenCalledWith(principal, null, scope);
  });

  it('is the tiers and switches the policy admits, asked in the scope given', async () => {
    vi.mocked(canAdminister).mockImplementation((_p, _r, s?: AuthorizationScope) =>
      Promise.resolve(s?.tier === 'designers')
    );

    await expect(adminReachOf(principal, scope)).resolves.toEqual({
      tiers: ['designers'],
      landing: '/admin/designs',
      switchesMet: [{ tier: 'designers', requires: 'lead_gen' }],
    });
    expect(canAdminister).toHaveBeenCalledWith(principal, null, {
      org: ORG,
      tier: 'designers',
      requires: 'lead_gen',
    });
  });

  it('is nothing when the policy admits no tier', async () => {
    vi.mocked(canAdminister).mockResolvedValue(false);

    await expect(adminReachOf(principal, scope)).resolves.toEqual({ tiers: [], landing: null });
  });
});

describe('lockedSwitchesOf', () => {
  it('reads nothing for a platform reach, a reach of nothing, or no org', async () => {
    await expect(lockedSwitchesOf('platform', ORG)).resolves.toEqual([]);
    await expect(lockedSwitchesOf({ tiers: [], landing: null }, ORG)).resolves.toEqual([]);
    await expect(
      lockedSwitchesOf({ tiers: ['designers'], landing: null }, undefined)
    ).resolves.toEqual([]);
  });
});

describe('lockedSwitchesIn', () => {
  const reach = { tiers: ['designers'], landing: null };
  const orgWith = (on: string[], unreadable = false) => ({
    nothingSet: false,
    unreadable,
    on,
    atDefault: [],
    unregistered: [],
  });

  beforeEach(() => {
    registerEntitlementSwitch({
      key: 'lead_gen',
      label: 'Lead generation',
      description: '',
      whenLacking: 'lock',
      upgradeUrl: '/pricing',
    });
  });

  it('locks a lock switch the org was read for and found off', () => {
    expect(lockedSwitchesIn(reach, orgWith([]))).toEqual([
      expect.objectContaining({ requires: 'lead_gen', upgradeUrl: '/pricing' }),
    ]);
  });

  it('locks nothing the org has, for no such org, or for an unreadable read', () => {
    expect(lockedSwitchesIn(reach, orgWith(['lead_gen']))).toEqual([]);
    expect(lockedSwitchesIn(reach, null)).toEqual([]);
    expect(lockedSwitchesIn(reach, orgWith([], true))).toEqual([]);
    expect(lockedSwitchesIn('platform', orgWith([]))).toEqual([]);
  });
});
