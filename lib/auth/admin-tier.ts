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
 *   page has to remember to call is fail-OPEN for every page that forgets. The
 *   admin layout reads this list on every full load and the client gate on
 *   every in-app navigation (`components/admin/admin-tier-gate.tsx`).
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
 * **Client-safe.** Read by `proxy.ts`, a server layout and two client
 * components, so it imports nothing.
 *
 * @see lib/auth/authorization.ts — `AuthorizationScope.tier`, and the default policy's tier arm
 * @see .context/auth/authorization.md — "Admin tiers"
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
 * Empty: t-810 builds the mechanism and opens nothing. The roster test pins
 * this list, so widening it fails until the test is updated in the same diff.
 * Frozen, because it is a constant and not a registry: nothing adds to it at
 * runtime (and `lib/tenancy/process-state.ts` would have to vet it if anything
 * could).
 */
export const ORG_TIER_ADMIN_PAGES: readonly string[] = Object.freeze([]);

/**
 * Admin API handlers declared `tier: 'org'`, as `path#METHOD`. Documentation
 * the roster test holds to the tree, not a list anything reads at runtime:
 * the declaration at the call site is what the guard acts on.
 */
export const ORG_TIER_ADMIN_ROUTES: readonly string[] = Object.freeze([]);

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
 */
export function adminPageTier(
  pathname: string | null | undefined,
  pages: readonly string[] = ORG_TIER_ADMIN_PAGES
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
