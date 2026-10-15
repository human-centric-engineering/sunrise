/**
 * Tests: the admin index — where the console opens (§111 t-812)
 *
 * The overview is install-wide, so it is the platform's; an org admin opens
 * the console on their org's orchestration dashboard instead.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const viewer = vi.hoisted(() => ({ tier: 'platform' }));
vi.mock('@/lib/auth/admin-page-viewer', () => ({
  adminPageViewerTier: vi.fn(() => Promise.resolve(viewer.tier)),
}));
vi.mock('next/navigation', () => ({
  redirect: vi.fn((to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  }),
}));

import AdminIndexPage from '@/app/admin/page';

beforeEach(() => vi.clearAllMocks());

describe('AdminIndexPage', () => {
  it('sends a platform admin to the overview', async () => {
    viewer.tier = 'platform';
    await expect(AdminIndexPage()).rejects.toThrow('NEXT_REDIRECT /admin/overview');
  });

  it('sends an org admin to the orchestration dashboard', async () => {
    viewer.tier = 'org';
    await expect(AdminIndexPage()).rejects.toThrow('NEXT_REDIRECT /admin/orchestration');
  });
});
