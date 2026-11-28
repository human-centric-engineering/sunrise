/**
 * Tests: lib/tenancy/tier-grants.ts — which named tiers may be granted, and
 * who holds a tier by the grant (t-1123).
 *
 * The registry is the real one, filled per test: a tier registered without
 * holds() is grantable, one with its own is not unless it says so. Prisma is
 * a double for the one read `membershipGrantHolds` makes; each case is
 * written so the wrong answer fails it (a grant listing the tier, read for
 * an ADMIN, must still be no).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const db = vi.hoisted(() => ({ orgMembership: { findUnique: vi.fn() } }));
vi.mock('@/lib/db/client', () => ({ prisma: db }));

import { registerAdminTier, restoreNamedAdminTiers } from '@/lib/auth/admin-tier';
import { env } from '@/lib/env';
import {
  grantableAdminTiers,
  grantableTiersAmong,
  isGrantableTier,
  membershipGrantHolds,
  ungrantableTiersAmong,
} from '@/lib/tenancy/tier-grants';
import { DEFAULT_ORG_ROLE, ORG_ADMIN_ROLE } from '@/lib/tenancy/roles';

const ORG = 'cmorg000000000000000other';
const USER = 'cmjbv4i3x00005wsloputgwuy';
const viewer = (orgRole: string | null = DEFAULT_ORG_ROLE) => ({
  userId: USER,
  orgId: ORG,
  orgRole,
});

const previousMode = env.TENANCY_MODE;
beforeEach(() => {
  vi.clearAllMocks();
  // Named tiers admit anyone only at multi, so only there is one grantable.
  env.TENANCY_MODE = 'multi';
  restoreNamedAdminTiers([]);
  registerAdminTier('media', { label: 'Media library', description: 'Upload images.' });
  registerAdminTier('reports', { holds: () => true });
  registerAdminTier('brand', { holds: () => false, grantable: true });
});

afterEach(() => {
  restoreNamedAdminTiers([]);
  env.TENANCY_MODE = previousMode;
});

describe('grantableAdminTiers', () => {
  it('lists the grantable tiers in registration order, with the app’s words', () => {
    expect(grantableAdminTiers()).toEqual([
      { name: 'media', label: 'Media library', description: 'Upload images.' },
      { name: 'brand' },
    ]);
  });

  it('is empty at single, where the policy admits nobody to a named tier', () => {
    env.TENANCY_MODE = 'single';
    expect(grantableAdminTiers()).toEqual([]);
    expect(isGrantableTier('media')).toBe(false);
    expect(ungrantableTiersAmong(['media'])).toEqual(['media']);
  });

  it('is empty when the app registered none: behaviour-neutral at rest', () => {
    restoreNamedAdminTiers([]);
    expect(grantableAdminTiers()).toEqual([]);
    expect(grantableTiersAmong(['media'])).toEqual([]);
  });
});

describe('the closed list', () => {
  it('keeps only grantable tiers, once each, in registration order', () => {
    expect(grantableTiersAmong(['brand', 'reports', 'nope', 'media', 'brand'])).toEqual([
      'media',
      'brand',
    ]);
  });

  it('names what cannot be granted, in the order asked', () => {
    expect(ungrantableTiersAmong(['nope', 'media', 'reports', 'nope'])).toEqual([
      'nope',
      'reports',
    ]);
    expect(isGrantableTier('media')).toBe(true);
    expect(isGrantableTier('reports')).toBe(false);
    expect(isGrantableTier('org')).toBe(false);
  });
});

describe('membershipGrantHolds', () => {
  it('holds for a MEMBER whose grant lists the tier, read by the membership’s unique', async () => {
    db.orgMembership.findUnique.mockResolvedValue({
      role: DEFAULT_ORG_ROLE,
      grant: { tiers: ['media', 'brand'] },
    });

    await expect(membershipGrantHolds(viewer(), 'media')).resolves.toBe(true);
    expect(db.orgMembership.findUnique).toHaveBeenCalledWith({
      where: { orgId_userId: { orgId: ORG, userId: USER } },
      select: { role: true, grant: { select: { tiers: true } } },
    });
  });

  it('does not hold a tier the grant does not list', async () => {
    db.orgMembership.findUnique.mockResolvedValue({
      role: DEFAULT_ORG_ROLE,
      grant: { tiers: ['brand'] },
    });
    await expect(membershipGrantHolds(viewer(), 'media')).resolves.toBe(false);
  });

  it('does not hold with no grant, or no membership', async () => {
    db.orgMembership.findUnique.mockResolvedValueOnce({ role: DEFAULT_ORG_ROLE, grant: null });
    await expect(membershipGrantHolds(viewer(), 'media')).resolves.toBe(false);
    db.orgMembership.findUnique.mockResolvedValueOnce(null);
    await expect(membershipGrantHolds(viewer(), 'media')).resolves.toBe(false);
  });

  it('does not hold for a viewer told they are not a MEMBER, and reads nothing', async () => {
    await expect(membershipGrantHolds(viewer(ORG_ADMIN_ROLE), 'media')).resolves.toBe(false);
    await expect(membershipGrantHolds(viewer(null), 'media')).resolves.toBe(false);
    expect(db.orgMembership.findUnique).not.toHaveBeenCalled();
  });

  it('does not hold when the row’s role is no longer MEMBER, whatever the session says', async () => {
    // A grant left beside an ADMIN row (one written before the clear) opens nothing.
    db.orgMembership.findUnique.mockResolvedValue({
      role: ORG_ADMIN_ROLE,
      grant: { tiers: ['media'] },
    });
    await expect(membershipGrantHolds(viewer(), 'media')).resolves.toBe(false);
  });

  it('throws on a failed read rather than answering no itself', async () => {
    db.orgMembership.findUnique.mockRejectedValue(new Error('db down'));
    await expect(membershipGrantHolds(viewer(), 'media')).rejects.toThrow('db down');
  });
});
