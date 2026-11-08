/**
 * Tests: adminPageViewerTier — who is viewing a mixed admin page (§111 t-812)
 *
 * The mixed pages render their platform-ops half for a platform viewer only,
 * so this must answer as the admin layout's platform question does: the
 * policy asked about the session's entered org, with no tier. An org
 * OWNER/ADMIN is an org viewer, and anything it cannot ask about is too.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/auth/utils', () => ({ getServerSession: vi.fn() }));
vi.mock('next/headers', () => ({ headers: vi.fn() }));
vi.mock('@/lib/auth/session-principal', () => ({ sessionPrincipal: vi.fn() }));
vi.mock('@/lib/auth/authorization', () => ({ canAdminister: vi.fn() }));

import { adminPageViewerTier, requestAdminReach } from '@/lib/auth/admin-page-viewer';
import { registerAdminTier, registerOrgTierAdminPage } from '@/lib/auth/admin-tier';
import { __resetAppOrgTierAdminPagesForTests } from '@/lib/auth/org-tier-admin-pages';
import type { AuthorizationScope } from '@/lib/auth/authorization';
import { getServerSession } from '@/lib/auth/utils';
import { headers } from 'next/headers';
import { sessionPrincipal } from '@/lib/auth/session-principal';
import { canAdminister } from '@/lib/auth/authorization';
import { TENANT_HEADER_NAME } from '@/lib/tenancy/resolver';

const ORG_B = 'cmorg0000000000000000orgb';
const session = {
  session: { activeOrgId: ORG_B },
  user: { id: 'user_b', role: 'USER' },
};
const principal = {
  userId: 'user_b',
  role: 'USER',
  credential: 'session' as const,
  orgId: ORG_B,
  orgRole: 'ADMIN',
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getServerSession).mockResolvedValue(session as never);
  vi.mocked(headers).mockResolvedValue(new Headers({ [TENANT_HEADER_NAME]: ORG_B }));
  vi.mocked(sessionPrincipal).mockResolvedValue({ principal, scope: { org: ORG_B } });
});

describe('adminPageViewerTier', () => {
  it('is the platform when the policy says this session administers it', async () => {
    vi.mocked(canAdminister).mockResolvedValue(true);

    await expect(adminPageViewerTier()).resolves.toBe('platform');
  });

  it('is an org viewer when it does not — the tier that admitted them is not asked', async () => {
    vi.mocked(canAdminister).mockResolvedValue(false);

    await expect(adminPageViewerTier()).resolves.toBe('org');
    expect(canAdminister).toHaveBeenCalledTimes(1);
    expect(canAdminister).toHaveBeenCalledWith(principal, null, { org: ORG_B });
  });

  it('enters the org the request names, as the layout does', async () => {
    vi.mocked(canAdminister).mockResolvedValue(false);

    await adminPageViewerTier();

    expect(sessionPrincipal).toHaveBeenCalledWith(session, ORG_B);
  });

  it('is an org viewer with no session, without asking the policy', async () => {
    vi.mocked(getServerSession).mockResolvedValue(null);

    await expect(adminPageViewerTier()).resolves.toBe('org');
    expect(canAdminister).not.toHaveBeenCalled();
  });
});

describe('requestAdminReach (t-999)', () => {
  /** Answer as a policy would: platform for nobody here, and the tiers in `admits`. */
  const policyAdmitting = (...admits: (string | undefined)[]) =>
    vi
      .mocked(canAdminister)
      .mockImplementation((_p, _r, scope?: AuthorizationScope) =>
        Promise.resolve(admits.includes(scope?.tier))
      );

  beforeEach(() => {
    __resetAppOrgTierAdminPagesForTests();
  });

  it('is the platform, asking nothing more, for a platform admin', async () => {
    vi.mocked(canAdminister).mockResolvedValue(true);
    await expect(requestAdminReach()).resolves.toBe('platform');
    expect(canAdminister).toHaveBeenCalledTimes(1);
  });

  it('with no tier registered, asks the org tier alone, as the layout did before', async () => {
    policyAdmitting('org');
    await expect(requestAdminReach()).resolves.toEqual({ tiers: ['org'], landing: null });
    expect(canAdminister).toHaveBeenCalledTimes(2);
    expect(canAdminister).toHaveBeenLastCalledWith(principal, null, { org: ORG_B, tier: 'org' });
  });

  it('asks the policy once per tier, with the guards’ principal and scope', async () => {
    registerAdminTier('page_designs', { holds: () => true, landing: '/admin/designs' });
    registerAdminTier('media', { holds: () => true });
    registerOrgTierAdminPage('/admin/designs', { tier: 'page_designs' });
    policyAdmitting('page_designs');

    await expect(requestAdminReach()).resolves.toEqual({
      tiers: ['page_designs'],
      landing: '/admin/designs',
    });
    for (const tier of ['org', 'page_designs', 'media']) {
      expect(canAdminister).toHaveBeenCalledWith(principal, null, { org: ORG_B, tier });
    }
  });

  it('names no landing for an org admin, who lands as one', async () => {
    registerAdminTier('page_designs', { holds: () => true, landing: '/admin/designs' });
    registerOrgTierAdminPage('/admin/designs', { tier: 'page_designs' });
    policyAdmitting('org', 'page_designs');

    await expect(requestAdminReach()).resolves.toEqual({
      tiers: ['org', 'page_designs'],
      landing: null,
    });
  });

  it('reaches nothing with no session', async () => {
    vi.mocked(getServerSession).mockResolvedValue(null);
    vi.mocked(sessionPrincipal).mockResolvedValue(null as never);
    vi.mocked(canAdminister).mockResolvedValue(false);
    await expect(requestAdminReach()).resolves.toEqual({ tiers: [], landing: null });
  });
});
