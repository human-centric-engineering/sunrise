/**
 * Tests: the admin index — where the console opens (§111 t-812, t-928)
 *
 * The overview is install-wide, so it is the platform's; an org admin opens
 * the console on their org's orchestration dashboard instead, or on the page
 * the fork names, if they may open it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const viewer = vi.hoisted(() => ({ tier: 'platform' }));
vi.mock('@/lib/auth/admin-page-viewer', () => ({
  adminPageViewerTier: vi.fn(() => Promise.resolve(viewer.tier)),
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
    viewer.tier = 'platform';
    await expect(AdminIndexPage()).rejects.toThrow('NEXT_REDIRECT /admin/overview');
  });

  it('sends an org admin to the orchestration dashboard', async () => {
    viewer.tier = 'org';
    await expect(AdminIndexPage()).rejects.toThrow('NEXT_REDIRECT /admin/orchestration');
  });

  it('sends an org admin to the page the fork names (t-928)', async () => {
    viewer.tier = 'org';
    app.route = '/admin/members';
    await expect(AdminIndexPage()).rejects.toThrow('NEXT_REDIRECT /admin/members');
  });

  it('keeps an org admin off a fork landing they may not open (t-928)', async () => {
    viewer.tier = 'org';
    app.route = '/admin/users';
    await expect(AdminIndexPage()).rejects.toThrow('NEXT_REDIRECT /admin/orchestration');
  });

  it('sends a platform admin to the overview whatever the fork names (t-928)', async () => {
    viewer.tier = 'platform';
    app.route = '/admin/members';
    await expect(AdminIndexPage()).rejects.toThrow('NEXT_REDIRECT /admin/overview');
  });
});
