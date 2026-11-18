/**
 * Tests: the default policy's answer to `scope.requires` (§135 t-1034)
 *
 * A surface of the org's or a named tier may require an entitlement switch.
 * The policy then admits whoever the tier admits only when the org they
 * entered has the switch, and a platform admin whatever the org has (the
 * planning ruling). A surface that requires nothing answers exactly as it did
 * before switches existed.
 *
 * The switch registry and the org read are the real ones
 * (`lib/tenancy/entitlements.ts`, `lib/tenancy/org-settings.ts`), over a
 * stand-in for the app's scaffold and a mocked `Org` row, so the policy reads
 * an org's switches the way it does in production.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

const fork = vi.hoisted(() => ({ tiers: (): void => {}, switches: (): void => {} }));
vi.mock('@/lib/app/admin-tier', () => ({
  initAppOrgTierAdminPages: () => fork.tiers(),
}));
vi.mock('@/lib/app/entitlements', () => ({
  initAppEntitlements: () => fork.switches(),
}));
vi.mock('@/lib/logging', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
const mockPrisma = vi.hoisted(() => ({ org: { findUnique: vi.fn() } }));
vi.mock('@/lib/db/client', () => ({ prisma: mockPrisma }));

import { logger } from '@/lib/logging';
import {
  canAdminister,
  type AuthorizationPrincipal,
  type AuthorizationScope,
} from '@/lib/auth/authorization';
import { registerAdminTier } from '@/lib/auth/admin-tier';
import { __resetAppOrgTierAdminPagesForTests } from '@/lib/auth/org-tier-admin-pages';
import {
  __resetEntitlementRegistryForTests,
  registerEntitlementSwitch,
} from '@/lib/tenancy/entitlements';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { env } from '@/lib/env';

const ORG = 'cmorg00000000000000000orga';

const ORG_ADMIN: AuthorizationPrincipal = {
  userId: 'oadmin-1',
  role: 'USER',
  credential: 'session',
  orgId: ORG,
  orgRole: 'ADMIN',
};
/** A MEMBER of the org whom the fork's stand-in says holds `page_designs`. */
const DESIGNER: AuthorizationPrincipal = { ...ORG_ADMIN, userId: 'designer-1', orgRole: 'MEMBER' };
const PLATFORM_ADMIN: AuthorizationPrincipal = {
  userId: 'admin-1',
  role: 'ADMIN',
  credential: 'session',
  orgId: INSTALL_ORG_ID,
  orgRole: 'OWNER',
};

const ORG_TIER: AuthorizationScope = { org: ORG, tier: 'org' };
const NEEDS_LEADS: AuthorizationScope = { ...ORG_TIER, requires: 'lead_gen' };
const DESIGNS_NEEDS_LEADS: AuthorizationScope = {
  org: ORG,
  tier: 'page_designs',
  requires: 'lead_gen',
};

/** The org's stored switches, as `Org.settings.entitlements` holds them. */
function orgHas(on: string[], off: string[] = []) {
  mockPrisma.org.findUnique.mockResolvedValue({ settings: { entitlements: { on, off } } });
}

let previousMode: typeof env.TENANCY_MODE;
beforeEach(() => {
  previousMode = env.TENANCY_MODE;
  env.TENANCY_MODE = 'multi';
  __resetAppOrgTierAdminPagesForTests();
  __resetEntitlementRegistryForTests();
  fork.tiers = () => {
    registerAdminTier('page_designs', {
      holds: (viewer) => viewer.userId === 'designer-1',
    });
  };
  fork.switches = () => {
    registerEntitlementSwitch({ key: 'lead_gen', label: 'Lead generation', description: '' });
    registerEntitlementSwitch({
      key: 'authoring',
      label: 'Authoring',
      description: '',
      whenNothingSet: true,
    });
  };
  orgHas([]);
});
afterEach(() => {
  env.TENANCY_MODE = previousMode;
  __resetAppOrgTierAdminPagesForTests();
  __resetEntitlementRegistryForTests();
  vi.clearAllMocks();
});

describe('canAdminister with scope.requires (t-1034)', () => {
  it('admits an org admin whose org has the switch', async () => {
    orgHas(['lead_gen']);
    await expect(canAdminister(ORG_ADMIN, null, NEEDS_LEADS)).resolves.toBe(true);
    expect(mockPrisma.org.findUnique).toHaveBeenCalledWith({
      where: { id: ORG },
      select: { settings: true },
    });
  });

  it('refuses an org admin whose org lacks it — set off, or never set on a default-off switch', async () => {
    orgHas([], ['lead_gen']);
    await expect(canAdminister(ORG_ADMIN, null, NEEDS_LEADS)).resolves.toBe(false);
    orgHas([]);
    await expect(canAdminister(ORG_ADMIN, null, NEEDS_LEADS)).resolves.toBe(false);
    // The same admin, the same org, the same tier, without the requirement: admitted.
    await expect(canAdminister(ORG_ADMIN, null, ORG_TIER)).resolves.toBe(true);
  });

  it('reads a default-on switch nobody set as had, as every other reader does', async () => {
    orgHas([]);
    await expect(
      canAdminister(ORG_ADMIN, null, { ...ORG_TIER, requires: 'authoring' })
    ).resolves.toBe(true);
  });

  it('narrows a named tier’s holder the same way', async () => {
    orgHas(['lead_gen']);
    await expect(canAdminister(DESIGNER, null, DESIGNS_NEEDS_LEADS)).resolves.toBe(true);
    orgHas([]);
    await expect(canAdminister(DESIGNER, null, DESIGNS_NEEDS_LEADS)).resolves.toBe(false);
  });

  it('does not limit a platform admin, whose org has nothing, and does not read it', async () => {
    orgHas([]);
    await expect(canAdminister(PLATFORM_ADMIN, null, NEEDS_LEADS)).resolves.toBe(true);
    expect(mockPrisma.org.findUnique).not.toHaveBeenCalled(); // test-review:accept no_arg_called — the ruling is that switches are not a platform admin's gate;
  });

  it('narrows the org arm too: an org admin over their own org’s row', async () => {
    const row = { kind: 'lead', id: 'l1', orgId: ORG };
    orgHas([]);
    await expect(canAdminister(ORG_ADMIN, row, NEEDS_LEADS)).resolves.toBe(false);
    orgHas(['lead_gen']);
    await expect(canAdminister(ORG_ADMIN, row, NEEDS_LEADS)).resolves.toBe(true);
  });

  it('opens nothing for a switch no app registers, which no org has', async () => {
    orgHas(['lead_gen', 'typo_gen']);
    await expect(
      canAdminister(ORG_ADMIN, null, { ...ORG_TIER, requires: 'typo_gen' })
    ).resolves.toBe(false);
  });

  it('refuses, and logs, when the org’s switches cannot be read — as a read, not a broken policy', async () => {
    mockPrisma.org.findUnique.mockRejectedValue(new Error('connection reset'));
    await expect(canAdminister(ORG_ADMIN, null, NEEDS_LEADS)).resolves.toBe(false);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      "authorization: could not read the org's switches; refusing",
      expect.objectContaining({ requires: 'lead_gen', error: 'connection reset' })
    );
  });

  it('asks nothing of the org for a surface that requires no switch', async () => {
    await expect(canAdminister(ORG_ADMIN, null, ORG_TIER)).resolves.toBe(true);
    expect(mockPrisma.org.findUnique).not.toHaveBeenCalled(); // test-review:accept no_arg_called — behaviour-neutral at rest: no requirement, no read;
  });

  it('refuses someone the tier refuses, whatever their org has', async () => {
    orgHas(['lead_gen']);
    const member = { ...ORG_ADMIN, userId: 'member-1', orgRole: 'MEMBER' };
    await expect(canAdminister(member, null, NEEDS_LEADS)).resolves.toBe(false);
  });
});
