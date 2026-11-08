/**
 * Tests: the admin index — where the console opens (§111 t-812, t-928)
 *
 * The overview is install-wide, so it is the platform's; an org admin opens
 * the console on their org's orchestration dashboard instead, or on the page
 * the fork names, if they may open it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { AdminReach } from '@/lib/auth/admin-tier';

/** An org OWNER/ADMIN, as `requestAdminReach()` answers for one. */
const ORG: AdminReach = { tiers: ['org'], landing: null };
const viewer = vi.hoisted(() => ({ reach: 'platform' }));
vi.mock('@/lib/auth/admin-page-viewer', () => ({
  requestAdminReach: vi.fn(() => Promise.resolve(viewer.reach)),
}));
const app = vi.hoisted(() => ({ route: null as string | null }));
vi.mock('@/lib/app/admin-landing', () => ({
  get appOrgAdminLandingRoute() {
    return app.route;
  },
}));
vi.mock('@/lib/logging', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock('next/navigation', () => ({
  redirect: vi.fn((to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  }),
}));

import AdminIndexPage from '@/app/admin/page';

beforeEach(() => {
  vi.clearAllMocks();
  app.route = null;
});

describe('AdminIndexPage', () => {
  it('sends a platform admin to the overview', async () => {
    viewer.reach = 'platform';
    await expect(AdminIndexPage()).rejects.toThrow('NEXT_REDIRECT /admin/overview');
  });

  it('sends an org admin to the orchestration dashboard', async () => {
    viewer.reach = ORG;
    await expect(AdminIndexPage()).rejects.toThrow('NEXT_REDIRECT /admin/orchestration');
  });

  it('sends an org admin to the page the fork names (t-928)', async () => {
    viewer.reach = ORG;
    app.route = '/admin/members';
    await expect(AdminIndexPage()).rejects.toThrow('NEXT_REDIRECT /admin/members');
  });

  it('keeps an org admin off a fork landing they may not open (t-928)', async () => {
    viewer.reach = ORG;
    app.route = '/admin/users';
    await expect(AdminIndexPage()).rejects.toThrow('NEXT_REDIRECT /admin/orchestration');
  });

  it('sends a platform admin to the overview whatever the fork names (t-928)', async () => {
    viewer.reach = 'platform';
    app.route = '/admin/members';
    await expect(AdminIndexPage()).rejects.toThrow('NEXT_REDIRECT /admin/overview');
  });

  describe('someone who holds a fork’s named tiers and is not an org admin (t-999)', () => {
    it('goes to the landing their tier names', async () => {
      viewer.reach = { tiers: ['page_designs'], landing: '/admin/designs' };
      await expect(AdminIndexPage()).rejects.toThrow('NEXT_REDIRECT /admin/designs');
    });

    it('is not sent there when they are an org admin as well: an org admin lands as one', async () => {
      // The landing is only worked out for a holder who is not an org admin,
      // so this one cannot arise from requestAdminReach(); the page still
      // must not prefer it over the org admin's landing.
      viewer.reach = { tiers: ['org', 'page_designs'], landing: '/admin/designs' };
      await expect(AdminIndexPage()).rejects.toThrow('NEXT_REDIRECT /admin/orchestration');
    });

    it('with no landing, falls through to the org admin landing, which the layout refuses them', async () => {
      viewer.reach = { tiers: ['page_designs'], landing: null };
      await expect(AdminIndexPage()).rejects.toThrow('NEXT_REDIRECT /admin/orchestration');
    });
  });
});
