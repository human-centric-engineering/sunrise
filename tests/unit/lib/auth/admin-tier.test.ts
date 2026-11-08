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
 *
 * And named tiers (t-999): what `registerAdminTier()` refuses, so no named
 * tier can widen `'org'`; which tier a page is in, by the pattern Next.js
 * serves it by; and who reaches which page, swept over core's whole roster.
 */
import { describe, it, expect, afterEach } from 'vitest';

import {
  ADMIN_INDEX_PATH,
  adminPageTier,
  adminPageTierOf,
  mostSpecificAdminPagePattern,
  reachesAdminPage,
  registerAdminTier,
  registeredAppNamedTierAdminPages,
  registeredNamedAdminTiers,
  restoreNamedAdminTiers,
  type AdminReach,
  type NamedTierAdminPage,
  adminSectionOf,
  CLOSABLE_CORE_ORG_TIER_SECTIONS,
  closeCoreOrgTierSection,
  effectiveRouteTier,
  registeredClosedCoreOrgTierSections,
  restoreClosedCoreOrgTierSections,
  withoutClosedSections,
  type ClosableCoreOrgTierSection,
  CORE_ADMIN_SECTIONS,
  matchesAdminPagePattern,
  ORG_TIER_ADMIN_PAGES,
  registeredAppOrgTierAdminPages,
  registerOrgTierAdminPage,
  restoreAppOrgTierAdminPages,
} from '@/lib/auth/admin-tier';

afterEach(() => {
  restoreAppOrgTierAdminPages([]);
  restoreNamedAdminTiers([]);
  restoreClosedCoreOrgTierSections([]);
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

describe('closeCoreOrgTierSection (t-929)', () => {
  it('closes orchestration and nothing else: Members and Support access stay openable', () => {
    expect(CLOSABLE_CORE_ORG_TIER_SECTIONS).toEqual(['orchestration']);
  });

  it('records a section once however often it is closed', () => {
    closeCoreOrgTierSection('orchestration');
    closeCoreOrgTierSection('orchestration');
    expect(registeredClosedCoreOrgTierSections()).toEqual(['orchestration']);
  });

  it.each(['members', 'support-access', 'users', 'Orchestration', ''])(
    'refuses %j, so a typo closes nothing',
    (name) => {
      expect(() => closeCoreOrgTierSection(name as ClosableCoreOrgTierSection)).toThrow(
        'not a core section a fork may close'
      );
      expect(registeredClosedCoreOrgTierSections()).toEqual([]);
    }
  );
});

describe('adminSectionOf', () => {
  it.each([
    ['/admin/orchestration', 'orchestration'],
    ['/admin/orchestration/agents/[id]', 'orchestration'],
    ['/api/v1/admin/orchestration/agents', 'orchestration'],
    ['/api/v1/admin/orchestration', 'orchestration'],
    ['/admin/members', 'members'],
    ['/admin', null],
    ['/api/v1/orgs/o1/members', null],
    ['/api/v1/app/admin/orchestration', null],
    ['/dashboard', null],
    [null, null],
  ])('%s is in %s', (path, section) => {
    expect(adminSectionOf(path)).toBe(section);
  });
});

describe('withoutClosedSections', () => {
  it('returns the list it was handed when nothing is closed', () => {
    expect(withoutClosedSections(ORG_TIER_ADMIN_PAGES, [])).toBe(ORG_TIER_ADMIN_PAGES);
  });

  it('drops the closed section’s pages and keeps the console index', () => {
    expect(
      withoutClosedSections(
        ['/admin', '/admin/orchestration', '/admin/orchestration/agents', '/admin/members'],
        ['orchestration']
      )
    ).toEqual(['/admin', '/admin/members']);
  });
});

describe('effectiveRouteTier', () => {
  const AGENTS = '/api/v1/admin/orchestration/agents';

  it('is the declaration, untouched, when nothing is closed — a missing pathname included', () => {
    expect(effectiveRouteTier('org', AGENTS, [])).toBe('org');
    expect(effectiveRouteTier('org', undefined, [])).toBe('org');
    expect(effectiveRouteTier(undefined, AGENTS, [])).toBeUndefined();
  });

  it('is the platform’s for a route in a closed section', () => {
    expect(effectiveRouteTier('org', AGENTS, ['orchestration'])).toBeUndefined();
    expect(
      effectiveRouteTier('org', `${AGENTS}/a1/capabilities`, ['orchestration'])
    ).toBeUndefined();
  });

  it.each([
    ['an encoded letter', '/api/v1/admin/%6Frchestration/agents'],
    ['an encoded slash', '/api/v1/admin/orchestration%2Fagents'],
  ])('reads the section through %s, which names the same route', (_l, path) => {
    expect(effectiveRouteTier('org', path, ['orchestration'])).toBeUndefined();
    // Control: the same spelling outside a closed section keeps its tier.
    expect(
      effectiveRouteTier('org', path.replace('rchestration', 'thers'), ['orchestration'])
    ).toBe('org');
  });

  it('is the platform’s for a pathname that will not decode', () => {
    expect(
      effectiveRouteTier('org', '/api/v1/admin/%E0%A4%A/agents', ['orchestration'])
    ).toBeUndefined();
    expect(effectiveRouteTier('org', '/api/v1/admin/%E0%A4%A/agents', [])).toBe('org');
  });

  it('judges only the section segment, so a stray `%` deeper in the path closes nothing', () => {
    expect(effectiveRouteTier('org', '/api/v1/admin/reports/50%', ['orchestration'])).toBe('org');
    expect(
      effectiveRouteTier('org', '/api/v1/admin/orchestration/50%', ['orchestration'])
    ).toBeUndefined();
  });

  it('is the platform’s with a section closed and no pathname to judge', () => {
    expect(effectiveRouteTier('org', undefined, ['orchestration'])).toBeUndefined();
  });

  it('leaves a route outside the closed section as it declared', () => {
    expect(effectiveRouteTier('org', '/api/v1/admin/leads', ['orchestration'])).toBe('org');
    expect(effectiveRouteTier('org', '/api/v1/app/leads', ['orchestration'])).toBe('org');
  });

  it('never widens an undeclared route', () => {
    expect(effectiveRouteTier(undefined, '/api/v1/admin/leads', ['orchestration'])).toBeUndefined();
  });
});

const holds = (): boolean => true;

describe('registerAdminTier (t-999)', () => {
  it('registers a tier, once, in registration order', () => {
    registerAdminTier('page_designs', { holds, landing: '/admin/designs' });
    registerAdminTier('media', { holds });
    // The same definition again is a no-op, as under HMR.
    registerAdminTier('media', { holds });
    expect(registeredNamedAdminTiers().map(([name]) => name)).toEqual(['page_designs', 'media']);
    expect(registeredNamedAdminTiers()[0][1]).toEqual({ holds, landing: '/admin/designs' });
    expect(Object.isFrozen(registeredNamedAdminTiers()[0][1])).toBe(true);
  });

  it.each([
    ['org', /reserved/],
    ['platform', /reserved/],
    ['Org', /not a tier name/],
    ['page designs', /not a tier name/],
    ['1st', /not a tier name/],
    ['', /not a tier name/],
    ['a'.repeat(49), /not a tier name/],
  ])('refuses the name %j, so no named tier reads as core’s', (name, why) => {
    expect(() => registerAdminTier(name, { holds })).toThrow(why);
    expect(registeredNamedAdminTiers()).toEqual([]);
  });

  it('refuses a tier with no holds(), or with a landing that is not a plain admin path', () => {
    expect(() => registerAdminTier('media', {} as unknown as { holds: () => boolean })).toThrow(
      /no holds\(\)/
    );
    for (const landing of ['/designs', '/admin/designs/[id]', '/admin/designs/', '/admin/x?y=1']) {
      expect(() => registerAdminTier('media', { holds, landing })).toThrow(/landing/);
    }
    expect(registeredNamedAdminTiers()).toEqual([]);
  });

  it('replaces a definition registered again, as a hot reload of the scaffold does', () => {
    registerAdminTier('media', { holds });
    const view = registeredNamedAdminTiers();
    const reloaded = (): boolean => false;
    registerAdminTier('media', { holds: reloaded, landing: '/admin/media' });
    // One tier, in its first place, answering with the new holds().
    expect(registeredNamedAdminTiers()).toEqual([
      ['media', { holds: reloaded, landing: '/admin/media' }],
    ]);
    expect(registeredNamedAdminTiers()).not.toBe(view);
  });
});

describe('registerOrgTierAdminPage with a tier (t-999)', () => {
  it('lists a page for a registered named tier, among the pages an org admin opens', () => {
    registerAdminTier('page_designs', { holds });
    registerOrgTierAdminPage('/admin/designs', { tier: 'page_designs' });
    registerOrgTierAdminPage('/admin/designs/settings');
    expect(registeredAppOrgTierAdminPages()).toEqual(['/admin/designs', '/admin/designs/settings']);
    expect(registeredAppNamedTierAdminPages()).toEqual([
      { pattern: '/admin/designs', tier: 'page_designs' },
    ]);
  });

  it('refuses a tier nobody registered first, opening nothing', () => {
    expect(() => registerOrgTierAdminPage('/admin/designs', { tier: 'page_designs' })).toThrow(
      /register the tier before its pages/
    );
    expect(registeredAppOrgTierAdminPages()).toEqual([]);
  });

  it('refuses a page in two tiers, either way round', () => {
    registerAdminTier('page_designs', { holds });
    registerOrgTierAdminPage('/admin/designs', { tier: 'page_designs' });
    expect(() => registerOrgTierAdminPage('/admin/designs')).toThrow(/already listed for tier/);
    registerOrgTierAdminPage('/admin/leads');
    expect(() => registerOrgTierAdminPage('/admin/leads', { tier: 'page_designs' })).toThrow(
      /already listed for tier "org"/
    );
    // Listing again for the same tier is a no-op.
    registerOrgTierAdminPage('/admin/designs', { tier: 'page_designs' });
    expect(registeredAppNamedTierAdminPages()).toHaveLength(1);
  });

  it('keeps a named tier out of core’s sections, as it keeps the org tier out', () => {
    registerAdminTier('page_designs', { holds });
    expect(() =>
      registerOrgTierAdminPage('/admin/orchestration/agents', { tier: 'page_designs' })
    ).toThrow(/core's/);
    expect(() => registerOrgTierAdminPage('/admin/users', { tier: 'page_designs' })).toThrow(
      /core's/
    );
  });

  it('restores both lists, and drops a tier for a page the restored list does not hold', () => {
    registerAdminTier('page_designs', { holds });
    registerOrgTierAdminPage('/admin/designs', { tier: 'page_designs' });
    const pages = registeredAppOrgTierAdminPages();
    const tiers = registeredAppNamedTierAdminPages();
    restoreAppOrgTierAdminPages([]);
    expect(registeredAppNamedTierAdminPages()).toEqual([]);
    restoreAppOrgTierAdminPages(pages, tiers);
    expect(registeredAppNamedTierAdminPages()).toEqual(tiers);
    restoreAppOrgTierAdminPages([], tiers);
    expect(registeredAppNamedTierAdminPages()).toEqual([]);
  });
});

describe('adminPageTierOf (t-999)', () => {
  const NAMED: NamedTierAdminPage[] = [
    { pattern: '/admin/designs/[id]', tier: 'page_designs' },
    { pattern: '/admin/designs', tier: 'page_designs' },
  ];
  const PAGES = [
    '/admin/designs',
    '/admin/designs/[id]',
    '/admin/designs/settings',
    '/admin/leads',
  ];

  it('names the tier a page was registered for, and org for the rest of the list', () => {
    expect(adminPageTierOf('/admin/designs', PAGES, NAMED)).toBe('page_designs');
    expect(adminPageTierOf('/admin/designs/d1', PAGES, NAMED)).toBe('page_designs');
    expect(adminPageTierOf('/admin/leads', PAGES, NAMED)).toBe('org');
    expect(adminPageTierOf('/admin/users', PAGES, NAMED)).toBeNull();
    expect(adminPageTierOf(null, PAGES, NAMED)).toBeNull();
  });

  it('resolves a page by the pattern Next.js serves it by, so a named [id] opens no org page beside it', () => {
    // `/admin/designs/[id]` names `/admin/designs/settings` too; Next.js
    // serves the literal page, which is the org's.
    expect(matchesAdminPagePattern('/admin/designs/[id]', '/admin/designs/settings')).toBe(true);
    expect(adminPageTierOf('/admin/designs/settings', PAGES, NAMED)).toBe('org');
    // …whichever order the patterns were listed in.
    expect(adminPageTierOf('/admin/designs/settings', [...PAGES].reverse(), NAMED)).toBe('org');
  });

  it('prefers a literal segment at the first place two patterns differ', () => {
    const pages = ['/admin/a/[x]/c', '/admin/a/b/[y]', '/admin/a/[x]/[y]'];
    expect(mostSpecificAdminPagePattern('/admin/a/b/c', pages)).toBe('/admin/a/b/[y]');
    expect(mostSpecificAdminPagePattern('/admin/a/z/c', pages)).toBe('/admin/a/[x]/c');
    expect(mostSpecificAdminPagePattern('/admin/a/z/q', pages)).toBe('/admin/a/[x]/[y]');
    expect(mostSpecificAdminPagePattern('/admin/b', pages)).toBeNull();
  });

  it('with nothing named, answers as adminPageTier does', () => {
    for (const path of ['/admin/orchestration/agents/a1', '/admin/users', '/admin']) {
      expect(adminPageTierOf(path, ORG_TIER_ADMIN_PAGES, [])).toBe(
        adminPageTier(path, ORG_TIER_ADMIN_PAGES)
      );
    }
  });
});

describe('reachesAdminPage (t-999)', () => {
  const NAMED: NamedTierAdminPage[] = [{ pattern: '/admin/designs/[id]', tier: 'page_designs' }];
  const PAGES = [...ORG_TIER_ADMIN_PAGES, '/admin/designs/[id]', '/admin/designs/settings'];
  /** A concrete URL for a pattern: each `[x]` becomes `x1`. */
  const urlOf = (pattern: string) => pattern.replace(/\[([^\]]+)\]/g, '$11');
  const reaches = (reach: AdminReach, path: string) =>
    reachesAdminPage(reach, path, adminPageTierOf(path, PAGES, NAMED));

  const HOLDER: AdminReach = { tiers: ['page_designs'], landing: '/admin/designs' };
  const ORG_ADMIN: AdminReach = { tiers: ['org', 'page_designs'], landing: null };

  it('opens a holder their tier’s page', () => {
    expect(reaches(HOLDER, '/admin/designs/d1')).toBe(true);
  });

  it('opens a holder no org-tier page on core’s whole roster, and no platform page', () => {
    // Every core org-tier page, as a URL, but `/admin` (below).
    const orgPages = ORG_TIER_ADMIN_PAGES.filter((p) => p !== ADMIN_INDEX_PATH).map(urlOf);
    expect(orgPages.length).toBeGreaterThan(30);
    for (const path of [...orgPages, '/admin/designs/settings']) {
      expect([path, reaches(HOLDER, path)]).toEqual([path, false]);
    }
    for (const path of ['/admin/users', '/admin/overview', '/admin/orgs', '/admin/logs']) {
      expect([path, reaches(HOLDER, path)]).toEqual([path, false]);
    }
  });

  it('opens a holder no page of a tier they do not hold', () => {
    const other: AdminReach = { tiers: ['media'], landing: null };
    expect(reaches(other, '/admin/designs/d1')).toBe(false);
  });

  it('lets a holder with a landing through /admin, which only sends them on — and one without, not', () => {
    expect(reaches(HOLDER, ADMIN_INDEX_PATH)).toBe(true);
    expect(reaches({ tiers: ['page_designs'], landing: null }, ADMIN_INDEX_PATH)).toBe(false);
    // Only /admin itself: not a page below it.
    expect(reaches(HOLDER, '/admin/orchestration')).toBe(false);
  });

  it('opens an org admin the named tier’s page and the org pages, and a platform admin everything', () => {
    for (const path of [
      '/admin/designs/d1',
      '/admin/designs/settings',
      '/admin/members',
      '/admin',
    ]) {
      expect(reaches(ORG_ADMIN, path)).toBe(true);
    }
    expect(reaches(ORG_ADMIN, '/admin/users')).toBe(false);
    expect(reaches('platform', '/admin/users')).toBe(true);
    expect(reaches('platform', '/admin/designs/d1')).toBe(true);
  });

  it('opens nothing to a viewer the policy admitted to no tier', () => {
    const none: AdminReach = { tiers: [], landing: null };
    for (const path of ['/admin', '/admin/members', '/admin/designs/d1', '/admin/users']) {
      expect(reaches(none, path)).toBe(false);
    }
  });
});
