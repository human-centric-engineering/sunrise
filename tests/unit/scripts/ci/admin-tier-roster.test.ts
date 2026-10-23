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
 *
 * FORK NOTE — this file reads your `lib/app/admin-tier.ts`,
 * `lib/app/admin-tier-routes.ts` and `lib/app/admin-landing.ts` for real, and
 * judges them; it does not pin them. Filling them correctly passes here, and
 * the pins below stay core's. A failure names the entry that is wrong — a
 * route listed but not declared, a page that does not exist, a landing an org
 * admin may not open — so fix that entry rather than this file. Pin your
 * values in `tests/unit/lib/app/defaults.test.ts`.
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
import {
  CORE_ADMIN_SECTIONS,
  ORG_TIER_ADMIN_PAGES,
  ORG_TIER_ADMIN_ROUTES,
} from '@/lib/auth/admin-tier';
import {
  appOrgTierAdminPagesInitState,
  closedCoreOrgTierSections,
  getAppOrgTierAdminPages,
  orgTierAdminPages,
} from '@/lib/auth/org-tier-admin-pages';
import { APP_ORG_TIER_ADMIN_ROUTES } from '@/lib/app/admin-tier-routes';
import { appOrgAdminLandingRoute } from '@/lib/app/admin-landing';
import { defaultOrgAdminLanding, orgAdminLandingProblem } from '@/lib/auth/admin-landing';
import { coreNavSections } from '@/components/admin/admin-sidebar';
import { getRegisteredNavSections } from '@/lib/admin-nav/registry';

function tracked(dir: string): string[] {
  return execSync(`git ls-files --cached --others --exclude-standard -- ${dir}`, {
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean);
}

// Every module under app/ and lib/: the routes, and wherever a wrapper that
// bakes the tier in may live — lib/, or a fork's app/api/v1/app/x/_lib/.
const ROUTES: SourceFile[] = [...tracked('app'), ...tracked('lib')]
  .filter((p) => /\.tsx?$/.test(p) && !p.endsWith('.d.ts'))
  .map((path) => ({ path, source: readFileSync(path, 'utf8') }));
const PAGE_FILES = tracked('app/admin').filter((p) => p.endsWith('/page.tsx'));
// Core sections and whatever the fork registered: importing the sidebar has
// already run `initAppNav()`.
const itemsOf = (sections: typeof coreNavSections): NavItemFacts[] =>
  sections.flatMap((section) => [
    ...(section.items ?? []),
    ...(section.subgroups ?? []).flatMap((group) => group.items),
  ]);
const NAV_ITEMS: NavItemFacts[] = itemsOf([...coreNavSections, ...getRegisteredNavSections()]);

const TREE: RosterInput = {
  routes: ROUTES,
  listedRoutes: ORG_TIER_ADMIN_ROUTES,
  // The fork's, from lib/app/admin-tier-routes.ts: held to the same checks,
  // and pinned by the fork in tests/unit/lib/app/defaults.test.ts, not here.
  appListedRoutes: APP_ORG_TIER_ADMIN_ROUTES,
  listedPages: ORG_TIER_ADMIN_PAGES,
  // The fork's, from lib/app/admin-tier.ts: held to the same checks. Not
  // pinned here — the fork pins its own list in tests/unit/lib/app/defaults.test.ts.
  appListedPages: getAppOrgTierAdminPages(),
  pageFiles: PAGE_FILES,
  navItems: NAV_ITEMS,
  coreSections: CORE_ADMIN_SECTIONS,
  coreNavHrefs: itemsOf(coreNavSections).map((item) => item.href),
  // The core sections the fork closed, from lib/app/admin-tier.ts: its nav
  // items are judged against what is left open.
  closedSections: closedCoreOrgTierSections(),
};

describe('the pins', () => {
  it('opens exactly the customer’s sections, the mixed pages, Members and Support access to an org admin (t-811, t-812, t-813, t-823)', () => {
    // A page added here is a page every org OWNER/ADMIN can open: add it to
    // ORG_TIER_ADMIN_PAGES and here, in the same diff, and say why in the PR.
    expect(ORG_TIER_ADMIN_PAGES).toEqual([
      '/admin',
      '/admin/orchestration',
      '/admin/orchestration/costs',
      '/admin/orchestration/analytics',
      '/admin/orchestration/executions',
      '/admin/orchestration/mcp',
      '/admin/orchestration/agents',
      '/admin/orchestration/agents/new',
      '/admin/orchestration/agents/[id]',
      '/admin/orchestration/agents/compare',
      '/admin/orchestration/workflows',
      '/admin/orchestration/workflows/new',
      '/admin/orchestration/workflows/[id]',
      '/admin/orchestration/triggers',
      '/admin/orchestration/triggers/new',
      '/admin/orchestration/triggers/[id]',
      '/admin/orchestration/knowledge',
      '/admin/orchestration/knowledge/[id]/cleanup',
      '/admin/orchestration/conversations',
      '/admin/orchestration/conversations/[id]',
      '/admin/orchestration/evaluations',
      '/admin/orchestration/evaluations/new',
      '/admin/orchestration/evaluations/[id]',
      '/admin/orchestration/evaluations/datasets',
      '/admin/orchestration/evaluations/datasets/new',
      '/admin/orchestration/evaluations/datasets/[id]',
      '/admin/orchestration/evaluations/runs',
      '/admin/orchestration/evaluations/runs/new',
      '/admin/orchestration/evaluations/runs/[id]',
      '/admin/orchestration/experiments',
      '/admin/orchestration/experiments/[id]/compare',
      '/admin/orchestration/event-subscriptions',
      '/admin/orchestration/event-subscriptions/new',
      '/admin/orchestration/event-subscriptions/[id]',
      '/admin/orchestration/event-subscriptions/dlq',
      '/admin/orchestration/mcp/keys',
      '/admin/orchestration/approvals',
      '/admin/orchestration/executions/[id]',
      '/admin/orchestration/executions/live',
      '/admin/members',
      // §121 t-823: the org's consent to vendor support, over the org arm.
      '/admin/support-access',
    ]);
  });

  it('opens exactly the routes those pages call (t-811, t-812)', () => {
    // As above, for `withAdminAuth(…, { tier: 'org' })` — `path#METHOD`.
    expect(ORG_TIER_ADMIN_ROUTES).toEqual([
      'app/api/v1/admin/orchestration/agent-profiles/route.ts#GET',
      'app/api/v1/admin/orchestration/agents/[id]/capabilities/[capId]/route.ts#DELETE',
      'app/api/v1/admin/orchestration/agents/[id]/capabilities/[capId]/route.ts#PATCH',
      'app/api/v1/admin/orchestration/agents/[id]/capabilities/route.ts#GET',
      'app/api/v1/admin/orchestration/agents/[id]/capabilities/route.ts#POST',
      'app/api/v1/admin/orchestration/agents/[id]/capabilities/usage/route.ts#GET',
      'app/api/v1/admin/orchestration/agents/[id]/clone/route.ts#POST',
      'app/api/v1/admin/orchestration/agents/[id]/embed-tokens/[tokenId]/route.ts#DELETE',
      'app/api/v1/admin/orchestration/agents/[id]/embed-tokens/[tokenId]/route.ts#PATCH',
      'app/api/v1/admin/orchestration/agents/[id]/embed-tokens/route.ts#GET',
      'app/api/v1/admin/orchestration/agents/[id]/embed-tokens/route.ts#POST',
      'app/api/v1/admin/orchestration/agents/[id]/evaluation-trend/route.ts#GET',
      'app/api/v1/admin/orchestration/agents/[id]/instructions-history/route.ts#GET',
      'app/api/v1/admin/orchestration/agents/[id]/instructions-revert/route.ts#POST',
      'app/api/v1/admin/orchestration/agents/[id]/invite-tokens/[tokenId]/route.ts#DELETE',
      'app/api/v1/admin/orchestration/agents/[id]/invite-tokens/route.ts#GET',
      'app/api/v1/admin/orchestration/agents/[id]/invite-tokens/route.ts#POST',
      'app/api/v1/admin/orchestration/agents/[id]/quarantined-capabilities/route.ts#GET',
      'app/api/v1/admin/orchestration/agents/[id]/route.ts#DELETE',
      'app/api/v1/admin/orchestration/agents/[id]/route.ts#GET',
      'app/api/v1/admin/orchestration/agents/[id]/route.ts#PATCH',
      'app/api/v1/admin/orchestration/agents/[id]/versions/[versionId]/restore/route.ts#POST',
      'app/api/v1/admin/orchestration/agents/[id]/versions/[versionId]/route.ts#GET',
      'app/api/v1/admin/orchestration/agents/[id]/versions/route.ts#GET',
      'app/api/v1/admin/orchestration/agents/[id]/widget-config/route.ts#GET',
      'app/api/v1/admin/orchestration/agents/[id]/widget-config/route.ts#PATCH',
      'app/api/v1/admin/orchestration/agents/bulk/route.ts#POST',
      'app/api/v1/admin/orchestration/agents/compare/route.ts#GET',
      'app/api/v1/admin/orchestration/agents/export/route.ts#POST',
      'app/api/v1/admin/orchestration/agents/import/route.ts#POST',
      'app/api/v1/admin/orchestration/agents/route.ts#GET',
      'app/api/v1/admin/orchestration/agents/route.ts#POST',
      'app/api/v1/admin/orchestration/analytics/content-gaps/route.ts#GET',
      'app/api/v1/admin/orchestration/analytics/engagement/route.ts#GET',
      'app/api/v1/admin/orchestration/analytics/feedback/route.ts#GET',
      'app/api/v1/admin/orchestration/analytics/topics/route.ts#GET',
      'app/api/v1/admin/orchestration/analytics/unanswered/route.ts#GET',
      'app/api/v1/admin/orchestration/approvals/history/route.ts#GET',
      'app/api/v1/admin/orchestration/capabilities/route.ts#GET',
      'app/api/v1/admin/orchestration/chat/stream/route.ts#POST',
      'app/api/v1/admin/orchestration/chat/transcribe/route.ts#POST',
      'app/api/v1/admin/orchestration/conversations/[id]/messages/route.ts#GET',
      'app/api/v1/admin/orchestration/conversations/[id]/provenance.md/route.ts#GET',
      'app/api/v1/admin/orchestration/conversations/[id]/provenance/route.ts#GET',
      'app/api/v1/admin/orchestration/conversations/[id]/route.ts#DELETE',
      'app/api/v1/admin/orchestration/conversations/[id]/route.ts#GET',
      'app/api/v1/admin/orchestration/conversations/[id]/route.ts#PATCH',
      'app/api/v1/admin/orchestration/conversations/export/route.ts#GET',
      'app/api/v1/admin/orchestration/conversations/route.ts#GET',
      'app/api/v1/admin/orchestration/conversations/search/route.ts#GET',
      'app/api/v1/admin/orchestration/costs/alerts/route.ts#GET',
      'app/api/v1/admin/orchestration/costs/route.ts#GET',
      'app/api/v1/admin/orchestration/costs/summary/route.ts#GET',
      'app/api/v1/admin/orchestration/embedding-models/route.ts#GET',
      'app/api/v1/admin/orchestration/evaluations/[id]/complete/route.ts#POST',
      'app/api/v1/admin/orchestration/evaluations/[id]/logs/route.ts#GET',
      'app/api/v1/admin/orchestration/evaluations/[id]/rescore/route.ts#POST',
      'app/api/v1/admin/orchestration/evaluations/[id]/route.ts#GET',
      'app/api/v1/admin/orchestration/evaluations/[id]/route.ts#PATCH',
      'app/api/v1/admin/orchestration/evaluations/datasets/[id]/capture/route.ts#POST',
      'app/api/v1/admin/orchestration/evaluations/datasets/[id]/cases/[position]/route.ts#PATCH',
      'app/api/v1/admin/orchestration/evaluations/datasets/[id]/generate-cases/commit/route.ts#POST',
      'app/api/v1/admin/orchestration/evaluations/datasets/[id]/generate-cases/route.ts#POST',
      'app/api/v1/admin/orchestration/evaluations/datasets/[id]/route.ts#GET',
      'app/api/v1/admin/orchestration/evaluations/datasets/generate-from-description/commit/route.ts#POST',
      'app/api/v1/admin/orchestration/evaluations/datasets/generate-from-description/route.ts#POST',
      'app/api/v1/admin/orchestration/evaluations/datasets/route.ts#GET',
      'app/api/v1/admin/orchestration/evaluations/datasets/route.ts#POST',
      'app/api/v1/admin/orchestration/evaluations/graders/route.ts#GET',
      'app/api/v1/admin/orchestration/evaluations/route.ts#GET',
      'app/api/v1/admin/orchestration/evaluations/route.ts#POST',
      'app/api/v1/admin/orchestration/evaluations/runs/[id]/cancel/route.ts#POST',
      'app/api/v1/admin/orchestration/evaluations/runs/[id]/cases/route.ts#GET',
      'app/api/v1/admin/orchestration/evaluations/runs/[id]/route.ts#GET',
      'app/api/v1/admin/orchestration/evaluations/runs/estimate/route.ts#POST',
      'app/api/v1/admin/orchestration/evaluations/runs/route.ts#GET',
      'app/api/v1/admin/orchestration/evaluations/runs/route.ts#POST',
      'app/api/v1/admin/orchestration/executions/[id]/approve/route.ts#POST',
      'app/api/v1/admin/orchestration/executions/[id]/cancel/route.ts#POST',
      'app/api/v1/admin/orchestration/executions/[id]/live/route.ts#GET',
      'app/api/v1/admin/orchestration/executions/[id]/reject/route.ts#POST',
      'app/api/v1/admin/orchestration/executions/[id]/report.md/route.ts#GET',
      'app/api/v1/admin/orchestration/executions/[id]/rerun/route.ts#POST',
      'app/api/v1/admin/orchestration/executions/[id]/retry-step/route.ts#POST',
      'app/api/v1/admin/orchestration/executions/[id]/review/route.ts#POST',
      'app/api/v1/admin/orchestration/executions/[id]/route.ts#GET',
      'app/api/v1/admin/orchestration/executions/[id]/status/route.ts#GET',
      'app/api/v1/admin/orchestration/executions/route.ts#GET',
      'app/api/v1/admin/orchestration/experiments/[id]/compare/route.ts#GET',
      'app/api/v1/admin/orchestration/experiments/[id]/route.ts#DELETE',
      'app/api/v1/admin/orchestration/experiments/[id]/route.ts#PATCH',
      'app/api/v1/admin/orchestration/experiments/[id]/run/route.ts#POST',
      'app/api/v1/admin/orchestration/experiments/[id]/verdicts/route.ts#POST',
      'app/api/v1/admin/orchestration/experiments/route.ts#GET',
      'app/api/v1/admin/orchestration/experiments/route.ts#POST',
      'app/api/v1/admin/orchestration/knowledge/documents/[id]/agents/route.ts#GET',
      'app/api/v1/admin/orchestration/knowledge/documents/[id]/chunks/route.ts#GET',
      'app/api/v1/admin/orchestration/knowledge/documents/[id]/cleanup/changes/[changeId]/accept/route.ts#POST',
      'app/api/v1/admin/orchestration/knowledge/documents/[id]/cleanup/changes/[changeId]/reject/route.ts#POST',
      'app/api/v1/admin/orchestration/knowledge/documents/[id]/cleanup/changes/[changeId]/route.ts#GET',
      'app/api/v1/admin/orchestration/knowledge/documents/[id]/cleanup/finalise/route.ts#POST',
      'app/api/v1/admin/orchestration/knowledge/documents/[id]/cleanup/lock/route.ts#DELETE',
      'app/api/v1/admin/orchestration/knowledge/documents/[id]/cleanup/lock/route.ts#GET',
      'app/api/v1/admin/orchestration/knowledge/documents/[id]/cleanup/lock/route.ts#POST',
      'app/api/v1/admin/orchestration/knowledge/documents/[id]/cleanup/revisions/[version]/restore/route.ts#POST',
      'app/api/v1/admin/orchestration/knowledge/documents/[id]/cleanup/revisions/[version]/route.ts#GET',
      'app/api/v1/admin/orchestration/knowledge/documents/[id]/cleanup/revisions/route.ts#GET',
      'app/api/v1/admin/orchestration/knowledge/documents/[id]/cleanup/section/refine/route.ts#POST',
      'app/api/v1/admin/orchestration/knowledge/documents/[id]/cleanup/section/route.ts#POST',
      'app/api/v1/admin/orchestration/knowledge/documents/[id]/confirm/route.ts#POST',
      'app/api/v1/admin/orchestration/knowledge/documents/[id]/download/route.ts#GET',
      'app/api/v1/admin/orchestration/knowledge/documents/[id]/enrich-keywords/route.ts#POST',
      'app/api/v1/admin/orchestration/knowledge/documents/[id]/rechunk/route.ts#POST',
      'app/api/v1/admin/orchestration/knowledge/documents/[id]/retry/route.ts#POST',
      'app/api/v1/admin/orchestration/knowledge/documents/[id]/route.ts#DELETE',
      'app/api/v1/admin/orchestration/knowledge/documents/[id]/route.ts#GET',
      'app/api/v1/admin/orchestration/knowledge/documents/[id]/route.ts#PATCH',
      'app/api/v1/admin/orchestration/knowledge/documents/bulk/route.ts#POST',
      'app/api/v1/admin/orchestration/knowledge/documents/fetch-url/route.ts#POST',
      'app/api/v1/admin/orchestration/knowledge/documents/route.ts#GET',
      'app/api/v1/admin/orchestration/knowledge/documents/route.ts#POST',
      'app/api/v1/admin/orchestration/knowledge/embed/route.ts#POST',
      'app/api/v1/admin/orchestration/knowledge/embedding-status/route.ts#GET',
      'app/api/v1/admin/orchestration/knowledge/embeddings/route.ts#GET',
      'app/api/v1/admin/orchestration/knowledge/graph/route.ts#GET',
      'app/api/v1/admin/orchestration/knowledge/search/route.ts#POST',
      'app/api/v1/admin/orchestration/knowledge/tags/[id]/route.ts#GET',
      'app/api/v1/admin/orchestration/knowledge/tags/route.ts#GET',
      'app/api/v1/admin/orchestration/mcp/keys/[id]/rotate/route.ts#POST',
      'app/api/v1/admin/orchestration/mcp/keys/[id]/route.ts#PATCH',
      'app/api/v1/admin/orchestration/mcp/keys/route.ts#GET',
      'app/api/v1/admin/orchestration/mcp/keys/route.ts#POST',
      'app/api/v1/admin/orchestration/models/route.ts#GET',
      'app/api/v1/admin/orchestration/observability/dashboard-stats/route.ts#GET',
      'app/api/v1/admin/orchestration/provider-models/route.ts#GET',
      'app/api/v1/admin/orchestration/providers/[id]/test-model/route.ts#POST',
      'app/api/v1/admin/orchestration/providers/[id]/test/route.ts#POST',
      'app/api/v1/admin/orchestration/providers/route.ts#GET',
      'app/api/v1/admin/orchestration/triggers/[id]/route.ts#DELETE',
      'app/api/v1/admin/orchestration/triggers/[id]/route.ts#GET',
      'app/api/v1/admin/orchestration/triggers/[id]/route.ts#PATCH',
      'app/api/v1/admin/orchestration/triggers/route.ts#GET',
      'app/api/v1/admin/orchestration/triggers/route.ts#POST',
      'app/api/v1/admin/orchestration/webhooks/[id]/deliveries/route.ts#GET',
      'app/api/v1/admin/orchestration/webhooks/[id]/route.ts#DELETE',
      'app/api/v1/admin/orchestration/webhooks/[id]/route.ts#GET',
      'app/api/v1/admin/orchestration/webhooks/[id]/route.ts#PATCH',
      'app/api/v1/admin/orchestration/webhooks/[id]/test/route.ts#POST',
      'app/api/v1/admin/orchestration/webhooks/deliveries/[id]/retry/route.ts#POST',
      'app/api/v1/admin/orchestration/webhooks/deliveries/[id]/route.ts#DELETE',
      'app/api/v1/admin/orchestration/webhooks/dlq/replay/route.ts#POST',
      'app/api/v1/admin/orchestration/webhooks/dlq/route.ts#GET',
      'app/api/v1/admin/orchestration/webhooks/route.ts#GET',
      'app/api/v1/admin/orchestration/webhooks/route.ts#POST',
      'app/api/v1/admin/orchestration/workflows/[id]/cost-estimate/route.ts#GET',
      'app/api/v1/admin/orchestration/workflows/[id]/cost-estimate/route.ts#POST',
      'app/api/v1/admin/orchestration/workflows/[id]/discard-draft/route.ts#POST',
      'app/api/v1/admin/orchestration/workflows/[id]/dry-run/route.ts#POST',
      'app/api/v1/admin/orchestration/workflows/[id]/execute/route.ts#POST',
      'app/api/v1/admin/orchestration/workflows/[id]/publish/route.ts#POST',
      'app/api/v1/admin/orchestration/workflows/[id]/rollback/route.ts#POST',
      'app/api/v1/admin/orchestration/workflows/[id]/route.ts#DELETE',
      'app/api/v1/admin/orchestration/workflows/[id]/route.ts#GET',
      'app/api/v1/admin/orchestration/workflows/[id]/route.ts#PATCH',
      'app/api/v1/admin/orchestration/workflows/[id]/save-as-template/route.ts#POST',
      'app/api/v1/admin/orchestration/workflows/[id]/schedules/[scheduleId]/route.ts#DELETE',
      'app/api/v1/admin/orchestration/workflows/[id]/schedules/[scheduleId]/route.ts#PATCH',
      'app/api/v1/admin/orchestration/workflows/[id]/schedules/route.ts#GET',
      'app/api/v1/admin/orchestration/workflows/[id]/schedules/route.ts#POST',
      'app/api/v1/admin/orchestration/workflows/[id]/versions/route.ts#GET',
      'app/api/v1/admin/orchestration/workflows/route.ts#GET',
      'app/api/v1/admin/orchestration/workflows/route.ts#POST',
      'app/api/v1/admin/orchestration/workflows/templates/route.ts#GET',
    ]);
  });
});

describe('the tree', () => {
  it('matches the roster: every declaration listed, every listing declared and real', () => {
    expect(findAdminTierRosterProblems(TREE)).toEqual([]);
  });

  it('judged the fork’s pages as its init left them, not an empty list a throw left behind', () => {
    // A throwing init rolls the fork's list back to empty, and an empty list
    // has nothing to report — so without this the tree passes while every
    // fork page ships closed. The init's own log says why it threw.
    expect(appOrgTierAdminPagesInitState()).toBe('ok');
  });

  it('lands an org admin on a page they may open (t-928)', () => {
    // A landing outside the org tier turns an org admin away the moment they
    // arrive; /admin falls back to the default at runtime, and this says so in CI.
    const landing = appOrgAdminLandingRoute ?? defaultOrgAdminLanding(orgTierAdminPages());
    expect(orgAdminLandingProblem(landing, orgTierAdminPages())).toBeNull();
  });

  it('sees the tree it judges', () => {
    // A check that reads nothing passes everything; these are the floor.
    expect(ROUTES.length).toBeGreaterThan(100);
    expect(PAGE_FILES.length).toBeGreaterThan(50);
    expect(NAV_ITEMS.length).toBeGreaterThan(15);
    expect(PAGE_FILES).toContain('app/admin/orchestration/agents/page.tsx');
    // Modules beside the routes are read too, where a fork's wrapper may sit.
    expect(ROUTES.map((r) => r.path)).toContain('app/admin/page.tsx');
  });
});

describe('the core sections', () => {
  it('names every top-level admin section core ships (t-817)', () => {
    // A fork's page may not sit in one of these. Adding a core section means
    // adding it here and in CORE_ADMIN_SECTIONS in the same diff; the tree
    // check above fails for a core page or nav item in a section left out.
    expect(CORE_ADMIN_SECTIONS).toEqual([
      'features',
      'logs',
      'members',
      'orchestration',
      'orgs',
      'overview',
      'support-access',
      'users',
    ]);
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

  it('a literal page a listed [x] pattern also names (t-817)', () => {
    expect(
      findAdminTierRosterProblems(
        input({
          pageFiles: ['app/admin/reports/[id]/page.tsx', 'app/admin/reports/settings/page.tsx'],
          appListedPages: ['/admin/reports/[id]'],
        })
      )
    ).toEqual([
      expect.stringContaining(
        '/admin/reports/settings: not listed, but the listed pattern /admin/reports/[id]'
      ),
    ]);
  });

  it('reads a page in a route group by its URL, which the group is not part of', () => {
    expect(
      findAdminTierRosterProblems(
        input({
          pageFiles: [
            'app/admin/reports/[id]/page.tsx',
            'app/admin/reports/(tabs)/settings/page.tsx',
          ],
          appListedPages: ['/admin/reports/[id]'],
        })
      )
    ).toEqual([expect.stringContaining('/admin/reports/settings: not listed')]);
  });

  it('a core section with no page, and a core page or nav item outside the core sections', () => {
    expect(
      findAdminTierRosterProblems(
        input({
          listedPages: ['/admin/orchestration/agents'],
          coreSections: ['orchestration', 'gone'],
          coreNavHrefs: ['/admin/billing', '/admin'],
        })
      )
    ).toEqual([
      expect.stringContaining('CORE_ADMIN_SECTIONS lists gone'),
      expect.stringContaining('/admin/billing: core'),
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
          `${ROUTE}#${method}: declared tier 'org' but not listed in ORG_TIER_ADMIN_ROUTES (core's) or lib/app/admin-tier-routes.ts (the fork's).`,
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
      `${path}#withOrgAdmin: declared tier 'org' but not listed in ORG_TIER_ADMIN_ROUTES (core's) or lib/app/admin-tier-routes.ts (the fork's).`,
    ]);
  });

  it('accepts a fork’s route listed in its own list, not core’s (t-927)', () => {
    const path = 'app/api/v1/app/reports/route.ts';
    const source = `export const GET = withAdminAuth(h, { tier: 'org', ${OWNED} });`;
    const fork = input({ routes: [{ path, source }], appListedRoutes: [`${path}#GET`] });
    expect(findAdminTierRosterProblems(fork)).toEqual([]);
    // …and the same route unlisted fails, naming the fork's list as a home for it.
    expect(findAdminTierRosterProblems({ ...fork, appListedRoutes: [] })).toEqual([
      expect.stringContaining("or lib/app/admin-tier-routes.ts (the fork's)"),
    ]);
  });

  it('a route the fork lists that does not declare the tier, named as the fork’s (t-927)', () => {
    expect(
      findAdminTierRosterProblems(
        input({ routes: [route(`{ ${OWNED} }`)], appListedRoutes: [`${ROUTE}#GET`] })
      )
    ).toEqual([
      `${ROUTE}#GET: listed in lib/app/admin-tier-routes.ts but does not declare tier 'org'.`,
    ]);
  });

  it('a core route the fork re-lists in its own list (t-927)', () => {
    expect(
      findAdminTierRosterProblems(
        input({
          routes: [route(`{ tier: 'org', ${OWNED} }`)],
          listedRoutes: [`${ROUTE}#GET`],
          appListedRoutes: [`${ROUTE}#GET`],
        })
      )
    ).toEqual([
      `${ROUTE}#GET: listed in lib/app/admin-tier-routes.ts, but it is core's and ORG_TIER_ADMIN_ROUTES already lists it. Remove it from the fork's list.`,
    ]);
  });

  it('holds a fork’s wrapper to the same checks: listed, literal tier, ownership (t-927)', () => {
    const path = 'app/api/v1/app/reports/_lib/read-route.ts';
    const wrapper = (options: string): SourceFile => ({
      path,
      source: `export const withReportsRead = (h: H) => withAdminAuth(h, ${options});`,
    });
    const listed = { appListedRoutes: [`${path}#withReportsRead`] };
    expect(
      findAdminTierRosterProblems(
        input({ routes: [wrapper(`{ tier: 'org', ${OWNED} }`)], ...listed })
      )
    ).toEqual([]);
    expect(
      findAdminTierRosterProblems(input({ routes: [wrapper(`{ tier: 'org' }`)], ...listed }))
    ).toEqual([expect.stringContaining('no `ownership`')]);
    expect(
      findAdminTierRosterProblems(
        input({ routes: [wrapper(`{ tier: TIER, ${OWNED} }`)], ...listed })
      )
    ).toEqual([
      expect.stringContaining('not the literal'),
      expect.stringContaining('listed in lib/app/admin-tier-routes.ts but does not declare'),
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

  it('holds a fork’s pages to the same checks, and names them as the fork’s', () => {
    expect(
      findAdminTierRosterProblems(
        input({
          appListedPages: [
            '/admin/orchestration/agents',
            '/admin/reports',
            '/admin/reports/[...slug]',
          ],
        })
      )
    ).toEqual([
      '/admin/reports: listed in lib/app/admin-tier.ts but app/admin/reports/page.tsx does not exist.',
      expect.stringMatching(
        /^\/admin\/reports\/\[\.\.\.slug\]: listed in lib\/app\/admin-tier\.ts with a catch-all/
      ),
    ]);
  });

  it('lets an org-tier nav item point at a page the fork listed, and at no other', () => {
    const fork = input({
      appListedPages: ['/admin/orchestration/agents'],
      navItems: [{ href: '/admin/orchestration/agents', tier: 'org' }],
    });
    expect(findAdminTierRosterProblems(fork)).toEqual([]);
    expect(findAdminTierRosterProblems({ ...fork, appListedPages: [] })).toEqual([
      expect.stringContaining('nav item /admin/orchestration/agents'),
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

  it('judges a fork’s nav item against the sections left open, and not core’s own (t-929)', () => {
    const closing = input({
      listedPages: ['/admin/orchestration/agents'],
      navItems: [
        { href: '/admin/orchestration/agents', tier: 'org' },
        { href: '/admin/orchestration/agents?from=reports', tier: 'org' },
      ],
      coreNavHrefs: ['/admin/orchestration/agents'],
    });
    // Nothing closed: both items point at an open page.
    expect(findAdminTierRosterProblems(closing)).toEqual([]);
    // Orchestration closed: the sidebar hides core's item, so it is not
    // reported; the fork's link to the same page would bounce an org admin.
    expect(findAdminTierRosterProblems({ ...closing, closedSections: ['orchestration'] })).toEqual([
      "nav item /admin/orchestration/agents?from=reports: marked tier 'org' over a page in a core section lib/app/admin-tier.ts closed to org admins, so an org admin would follow it to a redirect.",
    ]);
  });

  it('reports a fork route declared org-tier in a core section the fork closed (t-929)', () => {
    const fork = input({
      routes: [route(`{ tier: 'org', ${OWNED} }`)],
      appListedRoutes: [`${ROUTE}#GET`],
    });
    expect(findAdminTierRosterProblems(fork)).toEqual([]);
    expect(findAdminTierRosterProblems({ ...fork, closedSections: ['orchestration'] })).toEqual([
      `${ROUTE}#GET: declared tier 'org' in a core section lib/app/admin-tier.ts closed to org admins, so the guard refuses org admins it. Move the route out of the section or drop its tier.`,
    ]);
  });

  it('reads one declaration per exported handler, by method', () => {
    expect(tierDeclarations(route(`{ tier: 'org', ${OWNED} }`))).toEqual([
      { at: `${ROUTE}#GET`, literal: true, declaresOwnership: true },
    ]);
  });
});
