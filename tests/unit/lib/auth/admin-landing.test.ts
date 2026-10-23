/**
 * Tests: where `/admin` sends an org admin (t-928)
 *
 * The fork may name the page in `lib/app/admin-landing.ts`, and it is used only
 * if an org admin may open it — anything else would turn them away the moment
 * they landed. Judged against the real roster, so "may open" means what the
 * admin layout means by it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const app = vi.hoisted(() => ({ route: null as string | null }));
vi.mock('@/lib/app/admin-landing', () => ({
  get appOrgAdminLandingRoute() {
    return app.route;
  },
}));
vi.mock('@/lib/logging', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { logger } from '@/lib/logging';
import { ORG_TIER_ADMIN_PAGES, closeCoreOrgTierSection } from '@/lib/auth/admin-tier';
import { __resetAppOrgTierAdminPagesForTests } from '@/lib/auth/org-tier-admin-pages';
import {
  CLOSED_DEFAULT_ORG_ADMIN_LANDING,
  DEFAULT_ORG_ADMIN_LANDING,
  orgAdminLanding,
  orgAdminLandingProblem,
} from '@/lib/auth/admin-landing';

beforeEach(() => {
  vi.clearAllMocks();
  app.route = null;
  __resetAppOrgTierAdminPagesForTests();
});

describe('orgAdminLandingProblem', () => {
  const pages = [...ORG_TIER_ADMIN_PAGES, '/admin/reports', '/admin/reports/[id]'];

  it.each([
    ['a core org-tier page', '/admin/members'],
    ['a fork’s listed page', '/admin/reports'],
  ])('accepts %s', (_l, route) => {
    expect(orgAdminLandingProblem(route, pages)).toBeNull();
  });

  it.each([
    ['a platform page', '/admin/users', 'not a page an org admin may open'],
    ['a page nobody listed', '/admin/nowhere', 'not a page an org admin may open'],
    // One org's row: every other org's admin would land on a not-found.
    [
      'a concrete URL of a listed [x] page',
      '/admin/reports/q3',
      'not a page an org admin may open',
    ],
    // `/admin` sends here, so landing on it would loop.
    ['the console index itself', '/admin', 'not a path under /admin/'],
    ['a path outside the console', '/dashboard', 'not a path under /admin/'],
    ['an off-site URL', 'https://evil.example/admin/members', 'not a path under /admin/'],
    ['a trailing slash', '/admin/members/', 'not a plain path'],
    ['a query string', '/admin/members?tab=invites', 'not a plain path'],
    ['a fragment', '/admin/members#top', 'not a plain path'],
    ['a pattern rather than a URL', '/admin/reports/[id]', 'not a plain path'],
    ['a dot segment', '/admin/reports/../users', 'not a plain path'],
  ])('refuses %s', (_l, route, why) => {
    expect(orgAdminLandingProblem(route, pages)).toContain(why);
  });

  it('refuses a value that is not a string', () => {
    expect(orgAdminLandingProblem(42, pages)).toContain('not a path under /admin/');
  });
});

describe('orgAdminLanding', () => {
  it('is the orchestration dashboard when the fork names nowhere', () => {
    expect(orgAdminLanding()).toBe('/admin/orchestration');
    expect(DEFAULT_ORG_ADMIN_LANDING).toBe('/admin/orchestration');
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('is the fork’s page when an org admin may open it', () => {
    app.route = '/admin/members';
    expect(orgAdminLanding()).toBe('/admin/members');
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('falls back to the default, and says why, when they may not', () => {
    app.route = '/admin/users';
    expect(orgAdminLanding()).toBe('/admin/orchestration');
    expect(logger.error).toHaveBeenCalledWith(
      'admin-landing: ignoring the app org-admin landing',
      expect.objectContaining({
        route: '/admin/users',
        problem: expect.stringContaining('not a page an org admin may open'),
      })
    );
  });
});

describe('orgAdminLanding, with orchestration closed to org admins (t-929)', () => {
  beforeEach(() => {
    closeCoreOrgTierSection('orchestration');
  });

  it('is Members when the fork names nowhere, not the closed dashboard', () => {
    expect(orgAdminLanding()).toBe('/admin/members');
    expect(CLOSED_DEFAULT_ORG_ADMIN_LANDING).toBe('/admin/members');
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('refuses a fork landing in the closed section, and falls back to Members', () => {
    app.route = '/admin/orchestration/agents';
    expect(orgAdminLanding()).toBe('/admin/members');
    expect(logger.error).toHaveBeenCalledWith(
      'admin-landing: ignoring the app org-admin landing',
      expect.objectContaining({ route: '/admin/orchestration/agents' })
    );
  });
});
