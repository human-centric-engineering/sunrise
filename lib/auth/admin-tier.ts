/**
 * Which admin surfaces are the org's — the one roster (§111 t-810).
 *
 * Every admin surface is the **platform's** unless it says otherwise: an
 * undeclared API route, page or nav item admits a platform admin and nobody
 * else, which is what every one of them did before this module existed. A
 * surface that is the customer's says so, and only then may an org
 * OWNER/ADMIN of the entered org use it. Fail-closed by construction, so an
 * upgrade opens nothing a fork did not opt into, and opening a surface is a
 * one-line, reviewed diff.
 *
 * The declarations live in three places, and this module is what makes them
 * one roster:
 *
 * - **API routes** declare at the call site: `withAdminAuth(handler, { tier:
 *   'org' })`. The guard passes it to the policy as `scope.tier`; the policy
 *   decides. {@link ORG_TIER_ADMIN_ROUTES} lists them, and
 *   `tests/unit/scripts/ci/admin-tier-roster.test.ts` fails naming any route
 *   marked org-tier that is not listed (or listed and not marked).
 * - **Pages** declare here, in {@link ORG_TIER_ADMIN_PAGES}, because a page
 *   cannot: Next.js refuses unknown exports from a `page.tsx`, and a check a
 *   page has to remember to call is fail-OPEN for every page that forgets. A
 *   fork lists its own in `lib/app/admin-tier.ts` with
 *   {@link registerOrgTierAdminPage}. The admin layout reads both lists on
 *   every full load (`orgTierAdminPages()` in
 *   `lib/auth/org-tier-admin-pages.ts`) and hands them to the client gate,
 *   which judges every in-app navigation against them
 *   (`components/admin/admin-tier-gate.tsx`), both through {@link adminPageTier}.
 * - **Nav items** carry `tier` (`lib/admin-nav/registry.ts`), and the sidebar
 *   shows an org admin only those. A core item marked `'org'` must point at a
 *   page listed here; the roster test holds that.
 *
 * **Where the refusal actually happens.** The API is the authority: a page is
 * a shell over `serverFetch` calls, and every one of those reaches a guard that
 * asks the policy with the route's own tier. The page-level refusal is the
 * layout's, and a layout runs on a full load only — Next.js does not re-render
 * it on in-app navigation (see the framework's authentication guide, "Layouts
 * and auth checks"). The client gate covers that navigation for the reader; it
 * is not a security boundary and does not claim to be. A database check in
 * `proxy.ts` would cover it server-side, and the framework says not to put one
 * there: the proxy runs on every route, prefetches included.
 *
 * **Imports nothing.** Read by `proxy.ts` (on every request), a server layout,
 * client components and the fork's scaffold, so it stays a leaf: the scaffold
 * imports the registrar from here, and this must not import the scaffold back.
 * Running the fork's init lives in `lib/auth/org-tier-admin-pages.ts`, which
 * the server layout alone reads — one realm, so the list a client gate judges
 * by is the list the server built, not one the browser rebuilt.
 *
 * @see lib/auth/authorization.ts — `AuthorizationScope.tier`, and the default policy's tier arm
 * @see .context/auth/authorization.md — "Admin tiers"
 * @see lib/app/admin-tier.ts — the fork's pages
 * @see lib/auth/org-tier-admin-pages.ts — the fork's init, and the combined list
 */

/**
 * The tier an admin surface may declare. Only one value: the absence of a
 * tier is the platform tier, so there is no `'platform'` to pass and no way
 * to declare one that widens anything.
 */
export type AdminTier = 'org';

/**
 * Who the admin console is for, as the layout worked it out for one viewer:
 * a platform admin sees every surface, an org admin the org-tier ones only.
 */
export type AdminViewerTier = 'platform' | 'org';

/**
 * Admin pages an org OWNER/ADMIN may open, as route patterns: the path under
 * `app/` with dynamic segments written as the directory names them
 * (`/admin/orchestration/agents/[id]`). Each entry is one page. A pattern does
 * NOT cover the pages below it, so a sub-page added later is the platform's
 * until it is listed — the same fail-closed default as everything else here.
 *
 * The customer's sections (§111 t-811): the pages the control-plane map in
 * `.context/architecture/multi-tenancy.md` puts on the customer's side. And
 * the mixed pages (§111 t-812) — the orchestration dashboard, costs,
 * executions and the MCP landing — which an org admin opens to their org's
 * half: each page asks who is viewing (`lib/auth/admin-page-viewer.ts`) and
 * renders its platform-ops panels for a platform viewer only, and the routes
 * behind those panels stay undeclared. Analytics is listed with them but has
 * no platform-ops half: every figure on it is the org's, so it does not ask.
 * `/admin` itself is here so it can send an org admin to the dashboard; the
 * overview it sends a platform admin to is not. Members (§111 t-813) is the org's
 * roster, over `/api/v1/orgs/[id]/members`, which the org arm already admits
 * an org admin to; Users stays the platform's. Support access (§121 t-823) is
 * the org's consent to vendor support, over `/api/v1/orgs/[id]/support-grants`,
 * the same org arm. The roster test
 * pins this list, so widening it fails until the test is updated in the same
 * diff. Frozen, because it is a constant and not a registry: nothing adds to
 * it at runtime. A fork's pages go in a registry of their own beside it
 * ({@link registerOrgTierAdminPage}), which this list never sees.
 */
export const ORG_TIER_ADMIN_PAGES: readonly string[] = Object.freeze([
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
  // A legacy URL that redirects to the executions page. Listed because the
  // `[id]` pattern above names its URL too, and the roster check wants every
  // page a pattern names on the list by name.
  '/admin/orchestration/executions/live',
  '/admin/members',
  '/admin/support-access',
]);

/**
 * The top-level admin sections core owns: the first segment under `/admin` of
 * every core admin page. A fork's page may not sit inside one
 * ({@link registerOrgTierAdminPage}), which is what keeps the fork's list from
 * reaching a core page — a platform one, `/admin/users`, or one a core upgrade
 * adds later under a section the fork had widened. The roster test holds this
 * to the tree: every core page listed here and every core nav item is under
 * one of these, and each is a directory under `app/admin`.
 */
export const CORE_ADMIN_SECTIONS: readonly string[] = Object.freeze([
  'features',
  'logs',
  'members',
  'orchestration',
  'orgs',
  'overview',
  'support-access',
  'users',
]);

/** One literal segment of a page's path: what a directory under `app/` that is a URL segment may be called. */
const STATIC_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._~-]*$/;
/** One dynamic segment, `[id]` — not a catch-all `[...x]` or an optional one `[[...x]]`. */
const DYNAMIC_SEGMENT = /^\[[A-Za-z0-9_-]+\]$/;

/** The fork's org-tier page patterns, in registration order. */
const appPages = new Set<string>();
/** {@link appPages} as a frozen array, rebuilt only after it changes. */
let appPagesView: readonly string[] | null = null;

/**
 * List one of the fork's admin pages as org-tier. Call it from
 * `initAppOrgTierAdminPages()` in `lib/app/admin-tier.ts`: that is what runs
 * under the init gate, so a throw part-way rolls back every page the init
 * listed. A call at the scaffold's module scope still registers, but outside
 * the rollback.
 *
 * Takes one pattern, written as {@link ORG_TIER_ADMIN_PAGES} writes its own:
 * `/admin/` then literal segments and `[x]` dynamic ones, nothing else. Throws,
 * so a mistake opens nothing, on:
 *
 * - anything else — a trailing slash, an empty segment, a query string, a
 *   route group, a catch-all. The matcher reads none of them, so each would
 *   be a page the fork believes it opened that stays closed, or the reverse;
 * - a dynamic first segment (`/admin/[slug]`), which names every top-level
 *   admin page there is;
 * - a first segment that is one of {@link CORE_ADMIN_SECTIONS}. Those pages
 *   are core's, and core's org-tier ones are already listed; a fork that
 *   could list the rest would open a platform page (`/admin/users`) without
 *   editing a core file.
 *
 * Idempotent: listing a pattern twice lists it once.
 */
export function registerOrgTierAdminPage(pattern: string): void {
  const refuse = (why: string): never => {
    throw new TypeError(`registerOrgTierAdminPage: ${JSON.stringify(pattern)} ${why}`);
  };
  if (typeof pattern !== 'string' || !pattern.startsWith('/admin/')) {
    refuse('is not an admin page pattern — write the path under app/, starting /admin/.');
  }
  const segments = pattern.split('/').slice(2);
  if (!segments.every((s) => STATIC_SEGMENT.test(s) || DYNAMIC_SEGMENT.test(s))) {
    refuse(
      'is not an admin page pattern — write the path under app/ with literal and [x] segments only: no trailing slash, query, route group or catch-all.'
    );
  }
  if (!STATIC_SEGMENT.test(segments[0])) {
    refuse('starts with a dynamic segment, which would name every top-level admin page.');
  }
  if (CORE_ADMIN_SECTIONS.includes(segments[0])) {
    refuse(
      `is inside /admin/${segments[0]}, which is core's — put the fork's pages in a section of its own.`
    );
  }
  if (appPages.has(pattern)) return;
  appPages.add(pattern);
  appPagesView = null;
}

/**
 * What the fork has registered so far, without running its init. For the init
 * gate in `lib/auth/org-tier-admin-pages.ts`; read the list through
 * `getAppOrgTierAdminPages()` there, which runs the init first.
 *
 * @internal
 */
export function registeredAppOrgTierAdminPages(): readonly string[] {
  appPagesView ??= Object.freeze([...appPages]);
  return appPagesView;
}

/**
 * Put the fork's registrations back to a list {@link registeredAppOrgTierAdminPages}
 * returned — the init gate's rollback, and the tests' reset.
 *
 * @internal
 */
export function restoreAppOrgTierAdminPages(pages: readonly string[]): void {
  appPages.clear();
  for (const pattern of pages) appPages.add(pattern);
  appPagesView = null;
}

/**
 * Admin API handlers declared `tier: 'org'`, as `path#METHOD`. Documentation
 * the roster test holds to the tree, not a list anything reads at runtime:
 * the declaration at the call site is what the guard acts on.
 */
export const ORG_TIER_ADMIN_ROUTES: readonly string[] = Object.freeze([
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

/**
 * The request header `proxy.ts` writes with the request's pathname, so the
 * admin layout — which Next.js does not hand a pathname — can tell which page
 * it is wrapping. The proxy is its sole writer: it sets it on every request it
 * forwards, overwriting whatever a client sent.
 */
export const ADMIN_PATHNAME_HEADER = 'x-sunrise-pathname';

/** Does one route pattern name this pathname? Segment for segment; `[x]` takes any one segment. */
export function matchesAdminPagePattern(pattern: string, pathname: string): boolean {
  const want = segmentsOf(pattern);
  const got = segmentsOf(pathname);
  if (want.length !== got.length) return false;
  return want.every((segment, i) =>
    /^\[[^.[\]]+\]$/.test(segment) ? got[i] !== '' : segment === got[i]
  );
}

function segmentsOf(path: string): string[] {
  return path.replace(/\/+$/, '').split('/').slice(1);
}

/**
 * The tier a page declares, or `null` for the platform's. A missing pathname
 * is the platform's too: an unknown page is the one that must not open.
 *
 * Judges against the list it is handed, which has no default: a default of
 * core's list alone would silently leave out the fork's. The server reads the
 * whole list from `orgTierAdminPages()` (`lib/auth/org-tier-admin-pages.ts`);
 * a client component is handed it by the layout.
 */
export function adminPageTier(
  pathname: string | null | undefined,
  pages: readonly string[]
): AdminTier | null {
  if (!pathname) return null;
  return pages.some((pattern) => matchesAdminPagePattern(pattern, pathname)) ? 'org' : null;
}

/** May a viewer of this tier see a surface of that one? */
export function viewerReaches(
  viewer: AdminViewerTier,
  surface: AdminTier | null | undefined
): boolean {
  return viewer === 'platform' || surface === 'org';
}
