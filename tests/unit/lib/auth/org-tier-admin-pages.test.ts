/**
 * Tests: every org-tier admin page, core's then the fork's (t-817)
 *
 * The fork's pages come from `lib/app/admin-tier.ts`, run lazily by the first
 * read and rolled back whole on a throw. The combined list is built once and
 * reused, because the admin layout reads it on every request.
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
  adminPageTier,
  closeCoreOrgTierSection,
  ORG_TIER_ADMIN_PAGES,
  registerAdminTier,
  registerOrgTierAdminPage,
} from '@/lib/auth/admin-tier';
import {
  __resetAppOrgTierAdminPagesForTests,
  appOrgTierAdminPagesInitState,
  closedCoreOrgTierSections,
  getAppOrgTierAdminPages,
  namedAdminTier,
  namedAdminTiers,
  namedTierAdminPages,
  orgScopedAdminPages,
  orgTierAdminPages,
} from '@/lib/auth/org-tier-admin-pages';
import type { ClosableCoreOrgTierSection } from '@/lib/auth/admin-tier';

beforeEach(() => {
  fork.init = () => {};
  __resetAppOrgTierAdminPagesForTests();
  vi.mocked(logger.error).mockClear();
});
afterEach(() => {
  __resetAppOrgTierAdminPagesForTests();
});

describe('orgTierAdminPages', () => {
  it('with nothing registered, is core’s roster alone', () => {
    expect(getAppOrgTierAdminPages()).toEqual([]);
    expect(orgTierAdminPages()).toEqual(ORG_TIER_ADMIN_PAGES);
    expect(appOrgTierAdminPagesInitState()).toBe('ok');
  });

  it('opens a page the fork registers, on the first read and without anyone calling the init', () => {
    const init = vi.fn(() => {
      registerOrgTierAdminPage('/admin/reports');
      registerOrgTierAdminPage('/admin/reports/[id]');
    });
    fork.init = init;

    const pages = orgTierAdminPages();
    expect(pages).toEqual([...ORG_TIER_ADMIN_PAGES, '/admin/reports', '/admin/reports/[id]']);
    expect(adminPageTier('/admin/reports', pages)).toBe('org');
    expect(adminPageTier('/admin/reports/r1', pages)).toBe('org');
    // One pattern, one page: not the pages below it.
    expect(adminPageTier('/admin/reports/r1/edit', pages)).toBeNull();
    // Core's pages are still core's, and the platform's still the platform's.
    expect(adminPageTier('/admin/orchestration/agents', pages)).toBe('org');
    expect(adminPageTier('/admin/users', pages)).toBeNull();
    // Latched: every read after the first reuses the one run.
    orgTierAdminPages();
    expect(init).toHaveBeenCalledTimes(1);
  });

  it('builds the combined list once, and again only when the fork’s list changes', () => {
    fork.init = () => registerOrgTierAdminPage('/admin/reports');

    const first = orgTierAdminPages();
    expect(Object.isFrozen(first)).toBe(true);
    expect(orgTierAdminPages()).toBe(first);

    // A registration after the init settled (one at a module's top level).
    registerOrgTierAdminPage('/admin/billing');
    const second = orgTierAdminPages();
    expect(second).not.toBe(first);
    expect(second).toEqual([...ORG_TIER_ADMIN_PAGES, '/admin/reports', '/admin/billing']);
  });

  it('opens none of the fork’s pages when its init throws part-way, and says so', () => {
    fork.init = () => {
      registerOrgTierAdminPage('/admin/reports');
      throw new Error('boom');
    };

    expect(orgTierAdminPages()).toEqual(ORG_TIER_ADMIN_PAGES);
    expect(getAppOrgTierAdminPages()).toEqual([]);
    expect(appOrgTierAdminPagesInitState()).toBe('failed');
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('admin-tier: initAppOrgTierAdminPages threw'),
      expect.objectContaining({ error: expect.stringContaining('boom') })
    );
  });

  it('opens none of them when the init lists a page the registrar refuses', () => {
    fork.init = () => {
      registerOrgTierAdminPage('/admin/reports');
      registerOrgTierAdminPage('/admin/users');
    };

    expect(orgTierAdminPages()).toEqual(ORG_TIER_ADMIN_PAGES);
    expect(appOrgTierAdminPagesInitState()).toBe('failed');
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('initAppOrgTierAdminPages threw'),
      expect.objectContaining({ error: expect.stringContaining("which is core's") })
    );
  });
});

describe('closing a core section to org admins (t-929)', () => {
  it('closes nothing as shipped: the list is core’s and the fork’s, whole', () => {
    expect(closedCoreOrgTierSections()).toEqual([]);
    expect(orgTierAdminPages()).toEqual(ORG_TIER_ADMIN_PAGES);
    expect(orgScopedAdminPages()).toEqual(orgTierAdminPages());
  });

  it('takes every orchestration page off the list, and keeps /admin, Members, Support access, Waitlist and the fork’s', () => {
    fork.init = () => {
      registerOrgTierAdminPage('/admin/leads');
      closeCoreOrgTierSection('orchestration');
    };

    const pages = orgTierAdminPages();
    // The population was non-empty before: core lists orchestration pages.
    expect(ORG_TIER_ADMIN_PAGES.filter((p) => p.startsWith('/admin/orchestration')).length).toBe(
      38
    );
    expect(pages).toEqual([
      '/admin',
      '/admin/members',
      '/admin/support-access',
      '/admin/waitlist',
      '/admin/leads',
    ]);
    expect(adminPageTier('/admin/orchestration', pages)).toBeNull();
    expect(adminPageTier('/admin/orchestration/agents/a1', pages)).toBeNull();
    expect(adminPageTier('/admin/members', pages)).toBe('org');
    expect(closedCoreOrgTierSections()).toEqual(['orchestration']);
  });

  it('still names the closed pages as one org’s, for the header', () => {
    fork.init = () => closeCoreOrgTierSection('orchestration');

    expect(adminPageTier('/admin/orchestration/agents', orgScopedAdminPages())).toBe('org');
    expect(adminPageTier('/admin/orchestration/agents', orgTierAdminPages())).toBeNull();
    // Built once with the narrowed list, not on every read.
    expect(orgScopedAdminPages()).toBe(orgScopedAdminPages());
  });

  it('rebuilds the list when a section is closed after the init settled', () => {
    const first = orgTierAdminPages();
    closeCoreOrgTierSection('orchestration');
    expect(orgTierAdminPages()).not.toBe(first);
    expect(adminPageTier('/admin/orchestration', orgTierAdminPages())).toBeNull();
  });

  it('closes nothing when the init throws after closing, and says so', () => {
    fork.init = () => {
      closeCoreOrgTierSection('orchestration');
      throw new Error('boom');
    };

    expect(orgTierAdminPages()).toEqual(ORG_TIER_ADMIN_PAGES);
    expect(closedCoreOrgTierSections()).toEqual([]);
    expect(appOrgTierAdminPagesInitState()).toBe('failed');
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('closed core sections rolled back'),
      expect.anything()
    );
  });

  it('closes nothing when the init names a section it may not close', () => {
    fork.init = () => {
      closeCoreOrgTierSection('orchestration');
      closeCoreOrgTierSection('members' as ClosableCoreOrgTierSection);
    };

    expect(closedCoreOrgTierSections()).toEqual([]);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('initAppOrgTierAdminPages threw'),
      expect.objectContaining({
        error: expect.stringContaining('not a core section a fork may close'),
      })
    );
  });
});

describe('named tiers (t-999)', () => {
  const holds = (): boolean => true;

  it('registers none as shipped', () => {
    expect(namedAdminTiers()).toEqual([]);
    expect(namedTierAdminPages()).toEqual([]);
    expect(namedAdminTier('page_designs')).toBeUndefined();
  });

  it('reads the tiers and their pages through the same lazy init, once', () => {
    const init = vi.fn(() => {
      registerAdminTier('page_designs', { holds, landing: '/admin/designs' });
      registerOrgTierAdminPage('/admin/designs', { tier: 'page_designs' });
      registerOrgTierAdminPage('/admin/leads');
    });
    fork.init = init;

    expect(namedAdminTiers()).toEqual(['page_designs']);
    expect(namedAdminTier('page_designs')).toEqual({ holds, landing: '/admin/designs' });
    expect(namedTierAdminPages()).toEqual([{ pattern: '/admin/designs', tier: 'page_designs' }]);
    // An org admin opens the named tier's page too, so it is on their list,
    // and it shows one org's rows, so the header names the org on it.
    expect(orgTierAdminPages()).toEqual([
      ...ORG_TIER_ADMIN_PAGES,
      '/admin/designs',
      '/admin/leads',
    ]);
    expect(orgScopedAdminPages()).toContain('/admin/designs');
    expect(init).toHaveBeenCalledTimes(1);
  });

  it('rolls a tier back with its pages when the init throws part-way, and says so', () => {
    fork.init = () => {
      registerAdminTier('page_designs', { holds });
      registerOrgTierAdminPage('/admin/designs', { tier: 'page_designs' });
      throw new Error('boom');
    };

    expect(namedAdminTiers()).toEqual([]);
    expect(namedAdminTier('page_designs')).toBeUndefined();
    expect(namedTierAdminPages()).toEqual([]);
    expect(orgTierAdminPages()).toEqual(ORG_TIER_ADMIN_PAGES);
    expect(appOrgTierAdminPagesInitState()).toBe('failed');
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('initAppOrgTierAdminPages threw'),
      expect.objectContaining({ error: expect.stringContaining('boom') })
    );
  });

  it('rolls everything back when the init declares a page for a tier it never registered', () => {
    fork.init = () => {
      registerAdminTier('media', { holds });
      registerOrgTierAdminPage('/admin/media', { tier: 'media' });
      registerOrgTierAdminPage('/admin/designs', { tier: 'page_designs' });
    };

    expect(namedAdminTiers()).toEqual([]);
    expect(namedTierAdminPages()).toEqual([]);
    expect(getAppOrgTierAdminPages()).toEqual([]);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('initAppOrgTierAdminPages threw'),
      expect.objectContaining({
        error: expect.stringContaining('register the tier before its pages'),
      })
    );
  });
});
