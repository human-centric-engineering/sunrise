/**
 * Tests: which pages the org-tier roster names (§111 t-810)
 *
 * A pattern names one page: segment for segment, `[x]` taking any one
 * segment, and never the pages below it. Everything it does not name is the
 * platform's, including a missing pathname.
 *
 * And the fork's half (t-817): the pages `lib/app/admin-tier.ts` lists, read
 * lazily by the first `adminPageTier()` call, rolled back whole on a throw.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The fork's scaffold, standing in for a filled lib/app/admin-tier.ts. Each
// test says what the fork's init does; by default it does nothing, as shipped.
const fork = vi.hoisted(() => ({ init: (): void => {} }));
vi.mock('@/lib/app/admin-tier', () => ({
  initAppOrgTierAdminPages: () => fork.init(),
}));
vi.mock('@/lib/logging', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { logger } from '@/lib/logging';
import {
  __resetAppOrgTierAdminPagesForTests,
  adminPageTier,
  getAppOrgTierAdminPages,
  matchesAdminPagePattern,
  ORG_TIER_ADMIN_PAGES,
  orgTierAdminPages,
  registerOrgTierAdminPage,
  viewerReaches,
} from '@/lib/auth/admin-tier';

beforeEach(() => {
  fork.init = () => {};
  __resetAppOrgTierAdminPagesForTests();
  vi.mocked(logger.error).mockClear();
});
afterEach(() => {
  __resetAppOrgTierAdminPagesForTests();
});

describe('matchesAdminPagePattern', () => {
  it.each([
    ['/admin/orchestration/agents', '/admin/orchestration/agents', true],
    ['/admin/orchestration/agents', '/admin/orchestration/agents/', true],
    ['/admin/orchestration/agents/[id]', '/admin/orchestration/agents/agent-1', true],
    ['/admin/orchestration/agents/[id]/edit', '/admin/orchestration/agents/a1/edit', true],
  ])('%s names %s', (pattern, pathname, expected) => {
    expect(matchesAdminPagePattern(pattern, pathname)).toBe(expected);
  });

  it.each([
    // Not the pages below it: a sub-page added later is the platform's until listed.
    ['/admin/orchestration/agents', '/admin/orchestration/agents/new'],
    // Not the page above it.
    ['/admin/orchestration/agents/[id]', '/admin/orchestration/agents'],
    // A dynamic segment takes one segment, and not an empty one.
    ['/admin/orchestration/agents/[id]', '/admin/orchestration/agents/a1/edit'],
    ['/admin/orchestration/agents/[id]/edit', '/admin/orchestration/agents//edit'],
    // A literal segment is a literal: no prefix match.
    ['/admin/orchestration/agents', '/admin/orchestration/agents-archive'],
    // A catch-all is not a pattern this roster takes, so it names nothing.
    ['/admin/[...rest]', '/admin/users'],
  ])('%s does not name %s', (pattern, pathname) => {
    expect(matchesAdminPagePattern(pattern, pathname)).toBe(false);
  });
});

describe('adminPageTier', () => {
  const pages = ['/admin/orchestration/agents'];

  it('is org for a listed page and the platform’s (null) for anything else', () => {
    expect(adminPageTier('/admin/orchestration/agents', pages)).toBe('org');
    expect(adminPageTier('/admin/users', pages)).toBeNull();
  });

  it('is the platform’s for a missing pathname: an unknown page is the one that must not open', () => {
    expect(adminPageTier(null, pages)).toBeNull();
    expect(adminPageTier(undefined, pages)).toBeNull();
    expect(adminPageTier('', pages)).toBeNull();
  });

  it('reads the shipped roster by default: the customer’s pages are the org’s, the platform’s are not (t-811)', () => {
    // What the roster holds is pinned in tests/unit/scripts/ci/admin-tier-roster.test.ts.
    expect(ORG_TIER_ADMIN_PAGES).toContain('/admin/orchestration/agents/[id]');
    expect(adminPageTier('/admin/orchestration/agents')).toBe('org');
    expect(adminPageTier('/admin/orchestration/agents/cmagent00000000000000001')).toBe('org');
    expect(adminPageTier('/admin/orchestration/providers')).toBeNull();
    expect(adminPageTier('/admin/orchestration/knowledge/tags')).toBeNull();
    expect(adminPageTier('/admin/users')).toBeNull();
  });
});

describe('viewerReaches', () => {
  it('lets a platform viewer reach every surface and an org viewer the org-tier ones only', () => {
    expect(viewerReaches('platform', null)).toBe(true);
    expect(viewerReaches('platform', 'org')).toBe(true);
    expect(viewerReaches('org', 'org')).toBe(true);
    expect(viewerReaches('org', null)).toBe(false);
    expect(viewerReaches('org', undefined)).toBe(false);
  });
});

describe('a fork’s org-tier pages (t-817)', () => {
  it('with nothing registered, the roster is core’s alone', () => {
    expect(getAppOrgTierAdminPages()).toEqual([]);
    expect(orgTierAdminPages()).toEqual(ORG_TIER_ADMIN_PAGES);
    expect(adminPageTier('/admin/reports')).toBeNull();
  });

  it('opens a page the fork registers, on the first read and without anyone calling the init', () => {
    const init = vi.fn(() => {
      registerOrgTierAdminPage('/admin/reports');
      registerOrgTierAdminPage('/admin/reports/[id]');
    });
    fork.init = init;

    expect(adminPageTier('/admin/reports')).toBe('org');
    expect(adminPageTier('/admin/reports/r1')).toBe('org');
    // One pattern, one page: not the pages below it.
    expect(adminPageTier('/admin/reports/r1/edit')).toBeNull();
    // Core's pages are still core's, and the platform's still the platform's.
    expect(adminPageTier('/admin/orchestration/agents')).toBe('org');
    expect(adminPageTier('/admin/users')).toBeNull();
    expect(orgTierAdminPages()).toEqual([
      ...ORG_TIER_ADMIN_PAGES,
      '/admin/reports',
      '/admin/reports/[id]',
    ]);
    // Latched: every read after the first reuses the one run.
    expect(init).toHaveBeenCalledTimes(1);
  });

  it('lists a pattern registered twice once', () => {
    fork.init = () => {
      registerOrgTierAdminPage('/admin/reports');
      registerOrgTierAdminPage('/admin/reports');
    };
    expect(getAppOrgTierAdminPages()).toEqual(['/admin/reports']);
  });

  it('opens none of the fork’s pages when its init throws part-way, and says so', () => {
    fork.init = () => {
      registerOrgTierAdminPage('/admin/reports');
      throw new Error('boom');
    };

    expect(adminPageTier('/admin/reports')).toBeNull();
    expect(getAppOrgTierAdminPages()).toEqual([]);
    // Core's roster is untouched by the fork's failure.
    expect(adminPageTier('/admin/orchestration/agents')).toBe('org');
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('admin-tier: initAppOrgTierAdminPages threw'),
      expect.objectContaining({ error: expect.stringContaining('boom') })
    );
  });

  it.each([
    ['a path outside the admin console', '/reports'],
    ['the console root, which core owns', '/admin'],
    ['a pattern with no leading slash', 'admin/reports'],
    ['an empty segment after /admin', '/admin//reports'],
  ])('refuses %s, which rolls back the pages listed before it', (_label, pattern) => {
    fork.init = () => {
      registerOrgTierAdminPage('/admin/reports');
      registerOrgTierAdminPage(pattern);
    };

    expect(adminPageTier('/admin/reports')).toBeNull();
    expect(getAppOrgTierAdminPages()).toEqual([]);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('initAppOrgTierAdminPages threw'),
      expect.objectContaining({ error: expect.stringContaining('not an admin page pattern') })
    );
  });

  it('judges only the list it is handed, when handed one', () => {
    fork.init = () => registerOrgTierAdminPage('/admin/reports');
    expect(adminPageTier('/admin/reports', ['/admin/other'])).toBeNull();
    expect(adminPageTier('/admin/reports')).toBe('org');
  });
});
