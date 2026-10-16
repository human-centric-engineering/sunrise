/**
 * Tests: which pages the org-tier roster names (§111 t-810)
 *
 * A pattern names one page: segment for segment, `[x]` taking any one
 * segment, and never the pages below it. Everything it does not name is the
 * platform's, including a missing pathname.
 *
 * And the fork's registrar (t-817): what it refuses, so that a fork's list
 * cannot reach a page core owns. Running the fork's init is
 * `org-tier-admin-pages.test.ts`.
 */
import { describe, it, expect, afterEach } from 'vitest';

import {
  adminPageTier,
  CORE_ADMIN_SECTIONS,
  matchesAdminPagePattern,
  ORG_TIER_ADMIN_PAGES,
  registeredAppOrgTierAdminPages,
  registerOrgTierAdminPage,
  restoreAppOrgTierAdminPages,
  viewerReaches,
} from '@/lib/auth/admin-tier';

afterEach(() => {
  restoreAppOrgTierAdminPages([]);
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

  it('on core’s roster, the customer’s pages are the org’s and the platform’s are not (t-811)', () => {
    // What the roster holds is pinned in tests/unit/scripts/ci/admin-tier-roster.test.ts.
    const core = ORG_TIER_ADMIN_PAGES;
    expect(core).toContain('/admin/orchestration/agents/[id]');
    expect(adminPageTier('/admin/orchestration/agents', core)).toBe('org');
    expect(adminPageTier('/admin/orchestration/agents/cmagent00000000000000001', core)).toBe('org');
    expect(adminPageTier('/admin/orchestration/providers', core)).toBeNull();
    expect(adminPageTier('/admin/orchestration/knowledge/tags', core)).toBeNull();
    expect(adminPageTier('/admin/users', core)).toBeNull();
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

describe('registerOrgTierAdminPage (t-817)', () => {
  it('lists a pattern of the fork’s own, once however often it is listed', () => {
    registerOrgTierAdminPage('/admin/reports');
    registerOrgTierAdminPage('/admin/reports/[id]');
    registerOrgTierAdminPage('/admin/reports');

    expect(registeredAppOrgTierAdminPages()).toEqual(['/admin/reports', '/admin/reports/[id]']);
  });

  it('hands back the same frozen list until it changes, and a new one after', () => {
    registerOrgTierAdminPage('/admin/reports');
    const first = registeredAppOrgTierAdminPages();
    expect(Object.isFrozen(first)).toBe(true);
    expect(registeredAppOrgTierAdminPages()).toBe(first);

    registerOrgTierAdminPage('/admin/reports'); // already listed: no change
    expect(registeredAppOrgTierAdminPages()).toBe(first);

    registerOrgTierAdminPage('/admin/billing');
    expect(registeredAppOrgTierAdminPages()).not.toBe(first);
    expect(first).toEqual(['/admin/reports']); // a snapshot taken earlier is unchanged
  });

  it.each([
    ['a path outside the admin console', '/reports', 'not an admin page pattern'],
    ['the console root, which core owns', '/admin', 'not an admin page pattern'],
    ['a pattern with no leading slash', 'admin/reports', 'not an admin page pattern'],
    ['an empty segment', '/admin//reports', 'not an admin page pattern'],
    // The matcher strips a trailing slash; the roster check looks for
    // app/admin/reports//page.tsx. Refused so the two cannot disagree.
    ['a trailing slash', '/admin/reports/', 'not an admin page pattern'],
    ['a query string', '/admin/reports?tab=1', 'not an admin page pattern'],
    [
      'a route group, which is not in the URL',
      '/admin/(fork)/reports',
      'not an admin page pattern',
    ],
    [
      'a catch-all, which the matcher never matches',
      '/admin/reports/[...slug]',
      'not an admin page pattern',
    ],
    ['an optional catch-all', '/admin/reports/[[...slug]]', 'not an admin page pattern'],
    ['a parallel-route slot', '/admin/reports/@panel', 'not an admin page pattern'],
    ['a dot segment', '/admin/reports/..', 'not an admin page pattern'],
    // `[slug]` names /admin/users, /admin/settings — every top-level page.
    ['a dynamic first segment', '/admin/[slug]', 'starts with a dynamic segment'],
    [
      'a dynamic first segment with more below',
      '/admin/[slug]/edit',
      'starts with a dynamic segment',
    ],
    // Core's sections: a platform page, and room for one a core upgrade adds.
    ['a core platform page', '/admin/users', "which is core's"],
    ['a page under a core section', '/admin/orchestration/fork-page', "which is core's"],
    ['a dynamic page under a core section', '/admin/orchestration/[x]', "which is core's"],
    ['core’s own org-tier page', '/admin/members', "which is core's"],
  ])('refuses %s (%s)', (_label, pattern, why) => {
    expect(() => registerOrgTierAdminPage(pattern)).toThrow(why);
    expect(registeredAppOrgTierAdminPages()).toEqual([]);
  });

  it('refuses every core section, by name', () => {
    for (const section of CORE_ADMIN_SECTIONS) {
      expect(() => registerOrgTierAdminPage(`/admin/${section}`)).toThrow("which is core's");
    }
  });

  it('accepts a dynamic segment below a static first one', () => {
    registerOrgTierAdminPage('/admin/reports/[id]/edit');
    expect(adminPageTier('/admin/reports/r1/edit', registeredAppOrgTierAdminPages())).toBe('org');
  });
});
