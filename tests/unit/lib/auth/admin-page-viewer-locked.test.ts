/**
 * Tests: requestLockedSwitches — the switches an org admin's org lacks whose
 * surfaces the app shows locked (§135 t-1053)
 *
 * Pinned: nothing is read, and nothing is locked, by default or for a
 * platform viewer; a switch registered `whenLacking: 'lock'` that a page
 * requires and the org has off is locked, carrying the app's message and
 * link; one the org has, one the app hides, and one whose read failed are
 * not, so a failed read never tells an admin to buy what their org may have.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/auth/utils', () => ({ getServerSession: vi.fn() }));
vi.mock('next/headers', () => ({ headers: vi.fn() }));
vi.mock('@/lib/auth/session-principal', () => ({ sessionPrincipal: vi.fn() }));
vi.mock('@/lib/auth/authorization', () => ({ canAdminister: vi.fn() }));
vi.mock('@/lib/logging', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
const mockPrisma = vi.hoisted(() => ({ org: { findUnique: vi.fn() } }));
vi.mock('@/lib/db/client', () => ({ prisma: mockPrisma }));

import { requestLockedSwitches } from '@/lib/auth/admin-page-viewer';
import { registerOrgTierAdminPage } from '@/lib/auth/admin-tier';
import { __resetAppOrgTierAdminPagesForTests } from '@/lib/auth/org-tier-admin-pages';
import type { AuthorizationScope } from '@/lib/auth/authorization';
import { getServerSession } from '@/lib/auth/utils';
import { headers } from 'next/headers';
import { sessionPrincipal } from '@/lib/auth/session-principal';
import { canAdminister } from '@/lib/auth/authorization';
import { logger } from '@/lib/logging';
import {
  __resetEntitlementRegistryForTests,
  registerEntitlementSwitch,
} from '@/lib/tenancy/entitlements';

const ORG_B = 'cmorg0000000000000000orgb';
const principal = {
  userId: 'user_b',
  role: 'USER',
  credential: 'session' as const,
  orgId: ORG_B,
  orgRole: 'ADMIN',
};

/** The default policy's answer for an org admin: the org tier, and a switch only where the org has it. */
function orgAdminWhoseOrgHas(...has: string[]) {
  vi.mocked(canAdminister).mockImplementation((_p, _r, scope?: AuthorizationScope) =>
    Promise.resolve(
      scope?.tier === 'org' && (scope.requires === undefined || has.includes(scope.requires))
    )
  );
}

function orgStores(on: string[], off: string[] = []) {
  mockPrisma.org.findUnique.mockResolvedValue({ settings: { entitlements: { on, off } } });
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetAppOrgTierAdminPagesForTests();
  __resetEntitlementRegistryForTests();
  vi.mocked(getServerSession).mockResolvedValue({
    session: { activeOrgId: ORG_B },
    user: { id: 'user_b', role: 'USER' },
  } as never);
  vi.mocked(headers).mockResolvedValue(new Headers());
  vi.mocked(sessionPrincipal).mockResolvedValue({ principal, scope: { org: ORG_B } });
  registerEntitlementSwitch({
    key: 'lead_gen',
    label: 'Lead generation',
    description: '',
    whenLacking: 'lock',
    refusalMessage: 'Lead generation comes with the Growth plan.',
    upgradeUrl: '/pricing',
  });
  registerEntitlementSwitch({ key: 'briefs', label: 'Briefs', description: '' });
  registerOrgTierAdminPage('/admin/leads', { requires: 'lead_gen' });
  registerOrgTierAdminPage('/admin/briefs', { requires: 'briefs' });
  orgStores([]);
});

describe('requestLockedSwitches (t-1053)', () => {
  it("locks a switch the app locks and the org lacks, with the app's words, and not one it hides", async () => {
    orgAdminWhoseOrgHas();

    await expect(requestLockedSwitches()).resolves.toEqual([
      {
        requires: 'lead_gen',
        label: 'Lead generation',
        message: 'Lead generation comes with the Growth plan.',
        upgradeUrl: '/pricing',
      },
    ]);
  });

  it('locks nothing, and reads nothing, when the org has the switch by the policy', async () => {
    orgAdminWhoseOrgHas('lead_gen');

    await expect(requestLockedSwitches()).resolves.toEqual([]);
    expect(mockPrisma.org.findUnique).not.toHaveBeenCalled(); // test-review:accept no_arg_called — nothing to look up;
  });

  it('locks nothing for a platform viewer', async () => {
    vi.mocked(canAdminister).mockResolvedValue(true);

    await expect(requestLockedSwitches()).resolves.toEqual([]);
  });

  it('locks nothing when no switch is registered to lock: the default', async () => {
    __resetEntitlementRegistryForTests();
    registerEntitlementSwitch({ key: 'lead_gen', label: 'Lead generation', description: '' });
    orgAdminWhoseOrgHas();

    await expect(requestLockedSwitches()).resolves.toEqual([]);
    expect(mockPrisma.org.findUnique).not.toHaveBeenCalled(); // test-review:accept no_arg_called — nothing to look up;
  });

  it('does not lock a switch the org has, which the policy refused for its own reason', async () => {
    orgAdminWhoseOrgHas();
    orgStores(['lead_gen']);

    await expect(requestLockedSwitches()).resolves.toEqual([]);
  });

  it("hides rather than locks when the org's switches cannot be read, and logs it", async () => {
    orgAdminWhoseOrgHas();
    mockPrisma.org.findUnique.mockRejectedValue(new Error('db down'));

    await expect(requestLockedSwitches()).resolves.toEqual([]);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('could not read'),
      expect.objectContaining({ orgId: ORG_B, error: 'db down' })
    );
  });

  it('hides rather than locks when the stored slice is unreadable', async () => {
    orgAdminWhoseOrgHas();
    mockPrisma.org.findUnique.mockResolvedValue({ settings: { entitlements: 'broken' } });

    await expect(requestLockedSwitches()).resolves.toEqual([]);
  });
});
