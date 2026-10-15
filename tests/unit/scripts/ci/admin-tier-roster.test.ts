/**
 * Tests: the org-tier roster is what the tree declares (§111 t-810)
 *
 * Ruling 5 on §111: the admin surfaces an org OWNER/ADMIN may use are one
 * roster (`lib/auth/admin-tier.ts`), and widening it fails a test until the
 * roster is updated in the same diff. Two halves:
 *
 * - **the pins** — `ORG_TIER_ADMIN_PAGES` and `ORG_TIER_ADMIN_ROUTES` as
 *   written below. Opening a page or a route means editing the roster AND this
 *   file, so the opening is never a side effect of some other change;
 * - **the tree** — every route declared `tier: 'org'` is listed and every
 *   listed one declares it (with an `ownership` decision), every listed page
 *   exists, and no core nav item marked org-tier points at an unlisted page.
 *
 * Whole-tree: declared in `ALWAYS_RUN_TESTS`, because no import chain connects
 * a new route's `tier` to this file.
 */
import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
  findAdminTierRosterProblems,
  tierDeclarations,
  type NavItemFacts,
  type RosterInput,
  type SourceFile,
} from '@/scripts/ci/admin-tier-roster';
import { ORG_TIER_ADMIN_PAGES, ORG_TIER_ADMIN_ROUTES } from '@/lib/auth/admin-tier';
import { coreNavSections } from '@/components/admin/admin-sidebar';
import { getRegisteredNavSections } from '@/lib/admin-nav/registry';

function tracked(dir: string): string[] {
  return execSync(`git ls-files --cached --others --exclude-standard -- ${dir}`, {
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean);
}

// The routes, and every module under lib/ — where a wrapper that bakes the
// tier in would live.
const ROUTES: SourceFile[] = [
  ...tracked('app').filter((p) => /\/route\.tsx?$/.test(p)),
  ...tracked('lib').filter((p) => /\.tsx?$/.test(p) && !p.endsWith('.d.ts')),
].map((path) => ({ path, source: readFileSync(path, 'utf8') }));
const PAGE_FILES = tracked('app/admin').filter((p) => p.endsWith('/page.tsx'));
// Core sections and whatever the fork registered: importing the sidebar has
// already run `initAppNav()`.
const NAV_ITEMS: NavItemFacts[] = [...coreNavSections, ...getRegisteredNavSections()].flatMap(
  (section) => [
    ...(section.items ?? []),
    ...(section.subgroups ?? []).flatMap((group) => group.items),
  ]
);

const TREE: RosterInput = {
  routes: ROUTES,
  listedRoutes: ORG_TIER_ADMIN_ROUTES,
  listedPages: ORG_TIER_ADMIN_PAGES,
  pageFiles: PAGE_FILES,
  navItems: NAV_ITEMS,
};

describe('the pins', () => {
  it('opens no admin page to an org admin', () => {
    // t-810 builds the mechanism and opens nothing. A page added here is a
    // page every org OWNER/ADMIN can open: add it to ORG_TIER_ADMIN_PAGES and
    // here, in the same diff, and say why in the PR.
    expect(ORG_TIER_ADMIN_PAGES).toEqual([]);
  });

  it('opens no admin API route to an org admin', () => {
    // As above, for `withAdminAuth(…, { tier: 'org' })` — `path#METHOD`.
    expect(ORG_TIER_ADMIN_ROUTES).toEqual([]);
  });
});

describe('the tree', () => {
  it('matches the roster: every declaration listed, every listing declared and real', () => {
    expect(findAdminTierRosterProblems(TREE)).toEqual([]);
  });

  it('sees the tree it judges', () => {
    // A check that reads nothing passes everything; these are the floor.
    expect(ROUTES.length).toBeGreaterThan(100);
    expect(PAGE_FILES.length).toBeGreaterThan(50);
    expect(NAV_ITEMS.length).toBeGreaterThan(15);
    expect(PAGE_FILES).toContain('app/admin/orchestration/agents/page.tsx');
  });
});

describe('what it catches', () => {
  const ROUTE = 'app/api/v1/admin/orchestration/fixture/route.ts';
  const OWNED = `ownership: { decidedBy: 'policy' }`;
  const route = (options: string): SourceFile => ({
    path: ROUTE,
    source: `export const GET = withAdminAuth(async () => ok(), ${options});\nexport const POST = withAdminAuth(async () => ok());`,
  });
  const input = (over: Partial<RosterInput>): RosterInput => ({
    routes: [],
    listedRoutes: [],
    listedPages: [],
    pageFiles: ['app/admin/orchestration/agents/page.tsx'],
    navItems: [],
    ...over,
  });

  it('accepts a consistent roster — the control every case below differs from by one thing', () => {
    expect(
      findAdminTierRosterProblems(
        input({
          routes: [route(`{ tier: 'org', ${OWNED} }`)],
          listedRoutes: [`${ROUTE}#GET`],
          listedPages: ['/admin/orchestration/agents'],
          navItems: [{ href: '/admin/orchestration/agents', tier: 'org' }],
        })
      )
    ).toEqual([]);
  });

  it('a route declared org-tier and not listed', () => {
    expect(
      findAdminTierRosterProblems(input({ routes: [route(`{ tier: 'org', ${OWNED} }`)] }))
    ).toEqual([expect.stringContaining('not listed in ORG_TIER_ADMIN_ROUTES')]);
  });

  it('a route listed and not declared', () => {
    expect(
      findAdminTierRosterProblems(
        input({ routes: [route(`{ ${OWNED} }`)], listedRoutes: [`${ROUTE}#GET`] })
      )
    ).toEqual([expect.stringContaining('does not declare tier')]);
  });

  it('a tier review cannot read, written as a variable or hidden in a spread', () => {
    for (const options of [
      `{ tier: TIER, ${OWNED} }`,
      `{ ...ORG_OPTIONS_WITH_tier }`,
      'ORG_tier_OPTIONS',
    ]) {
      expect(findAdminTierRosterProblems(input({ routes: [route(options)] }))).toEqual([
        expect.stringContaining('not the literal'),
      ]);
    }
  });

  it('an org-tier route with no ownership decision', () => {
    expect(
      findAdminTierRosterProblems(
        input({ routes: [route(`{ tier: 'org' }`)], listedRoutes: [`${ROUTE}#GET`] })
      )
    ).toEqual([expect.stringContaining('no `ownership`')]);
  });

  it('a listed page that does not exist, and one listed below a real page', () => {
    expect(
      findAdminTierRosterProblems(
        input({ listedPages: ['/admin/nowhere', '/admin/orchestration/agents/[id]/nowhere'] })
      )
    ).toEqual([
      expect.stringContaining('/admin/nowhere: listed'),
      expect.stringContaining('/admin/orchestration/agents/[id]/nowhere: listed'),
    ]);
  });

  it('a nav item marked org-tier over a page the roster does not list', () => {
    expect(
      findAdminTierRosterProblems(
        input({ navItems: [{ href: '/admin/orchestration/agents', tier: 'org' }] })
      )
    ).toEqual([expect.stringContaining('nav item /admin/orchestration/agents')]);
  });

  it.each([
    ['a quoted key', `export const GET = withAdminAuth(h, { 'tier': 'org' });`, 'GET'],
    [
      'a call under `as`',
      `export const GET = withAdminAuth(h, { tier: 'org' }) as Handler;`,
      'GET',
    ],
    [
      'a call under `satisfies`',
      `export const POST = withAdminAuth(h, { tier: 'org' }) satisfies H;`,
      'POST',
    ],
    ['an outer wrapper call', `export const GET = wrap(withAdminAuth(h, { tier: 'org' }));`, 'GET'],
    [
      'an export specifier',
      `const handler = withAdminAuth(h, { tier: 'org' });\nexport { handler as PATCH };`,
      'PATCH',
    ],
    [
      'a call inside an exported function',
      `export async function DELETE(req: Request) { return withAdminAuth(h, { tier: 'org' })(req); }`,
      'DELETE',
    ],
  ])(
    'sees a declaration written with %s — the guard acts on it, so the roster must',
    (_l, source, method) => {
      expect(findAdminTierRosterProblems(input({ routes: [{ path: ROUTE, source }] }))).toEqual(
        expect.arrayContaining([
          `${ROUTE}#${method}: declared tier 'org' but not listed in ORG_TIER_ADMIN_ROUTES.`,
        ])
      );
    }
  );

  it('sees the guard imported under another name', () => {
    const source = `import { withAdminAuth as guard } from '@/lib/auth/guards';\nexport const GET = guard(h, { tier: 'org' });`;
    expect(tierDeclarations({ path: ROUTE, source })).toEqual([
      { at: `${ROUTE}#GET`, literal: true, declaresOwnership: false },
    ]);
  });

  it('records a handler exported under two methods once per method', () => {
    const source = `const handler = withAdminAuth(h, { tier: 'org', ${OWNED} });\nexport { handler as GET, handler as HEAD };`;
    expect(tierDeclarations({ path: ROUTE, source }).map((d) => d.at)).toEqual([
      `${ROUTE}#GET`,
      `${ROUTE}#HEAD`,
    ]);
  });

  it('reports a wrapper that bakes the tier in, under its own name', () => {
    const path = 'lib/api/org-admin.ts';
    const source = `export const withOrgAdmin = (h: H) => withAdminAuth(h, { tier: 'org', ${OWNED} });`;
    expect(findAdminTierRosterProblems(input({ routes: [{ path, source }] }))).toEqual([
      `${path}#withOrgAdmin: declared tier 'org' but not listed in ORG_TIER_ADMIN_ROUTES.`,
    ]);
  });

  it('treats a computed key that mentions tier as unreadable', () => {
    expect(
      findAdminTierRosterProblems(input({ routes: [route(`{ [TIER_KEY]: 'org', ${OWNED} }`)] }))
    ).toEqual([expect.stringContaining('not the literal')]);
  });

  it('a listed page with a catch-all or route-group segment, which the matcher cannot match', () => {
    expect(
      findAdminTierRosterProblems(
        input({
          listedPages: ['/admin/docs/[...slug]', '/admin/docs/[[...slug]]', '/admin/(org)/agents'],
          pageFiles: [
            'app/admin/docs/[...slug]/page.tsx',
            'app/admin/docs/[[...slug]]/page.tsx',
            'app/admin/(org)/agents/page.tsx',
          ],
        })
      )
    ).toEqual([
      expect.stringContaining('[...slug]: listed'),
      expect.stringContaining('[[...slug]]: listed'),
      expect.stringContaining('(org)/agents: listed'),
    ]);
  });

  it('reads a nav href as the page it opens, without its query or fragment', () => {
    expect(
      findAdminTierRosterProblems(
        input({
          listedPages: ['/admin/orchestration/agents'],
          navItems: [{ href: '/admin/orchestration/agents?tab=mine#top', tier: 'org' }],
        })
      )
    ).toEqual([]);
  });

  it('reads one declaration per exported handler, by method', () => {
    expect(tierDeclarations(route(`{ tier: 'org', ${OWNED} }`))).toEqual([
      { at: `${ROUTE}#GET`, literal: true, declaresOwnership: true },
    ]);
  });
});
