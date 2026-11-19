/**
 * Post-authentication landing route — platform resolver.
 *
 * Platform-owned. Resolves the fork seam (`lib/app/auth-landing.ts`) against the
 * platform default once, at module load, so the ~10 sites that send a user into
 * the authenticated app import one constant instead of each repeating
 * `appAuthLandingRoute ?? '/dashboard'` — a shape that drifts the moment one
 * site is missed, which is the failure this seam exists to end.
 *
 * Safe in every realm it is imported into (edge proxy, server components,
 * client components): pure string work, no framework or Node APIs.
 *
 * `proxy.ts` imports `AUTH_LANDING_ROUTE` at module scope and matches nearly
 * every request path, so a throw here doesn't just surface once — it fails
 * the edge middleware for essentially every request, in every environment,
 * until the seam value is fixed. That's the intended trade: broad and loud
 * beats narrow and silent for a value this many redirects depend on, but it
 * does mean a bad seam value is caught as a site-wide outage, not a scoped
 * page error.
 */
import { appAuthLandingRoute, appAuthLandingLabel } from '@/lib/app/auth-landing';
import { appWelcomeRoute } from '@/lib/app/welcome';
import { normalizeRootRelativePath } from '@/lib/security/sanitize';

/** Sunrise's own landing route, used when the fork seam is `null`. */
export const DEFAULT_AUTH_LANDING_ROUTE = '/dashboard';

/** Sunrise's own name for that destination, used when the fork seam is `null`. */
export const DEFAULT_AUTH_LANDING_LABEL = 'Dashboard';

/**
 * Fail loudly on a bad seam value rather than falling back to `/dashboard`.
 *
 * Falling back would recreate the exact failure #473 is about — an app that
 * looks configured and silently sends its users somewhere else — and here the
 * value reaches `safeCallbackUrl()` as the *fallback*, which that helper does
 * not validate. A build-time constant in the fork's own file is caught on the
 * first page load in dev, so a throw costs a fork one clear error and buys every
 * fork the guarantee that the landing route is same-origin.
 */
function resolveAuthLandingRoute(): string {
  if (appAuthLandingRoute === null) return DEFAULT_AUTH_LANDING_ROUTE;

  // Take the NORMALIZED value, not the raw one: a seam value containing tab/LF/CR
  // is judged on what the URL parser will see, so returning the input would hand
  // every consuming redirect a string that resolves somewhere else.
  const normalized = normalizeRootRelativePath(appAuthLandingRoute.trim());
  if (normalized === null) {
    throw new Error(
      `Invalid appAuthLandingRoute in lib/app/auth-landing.ts: ${JSON.stringify(appAuthLandingRoute)}. ` +
        'Must be a root-relative path such as "/app" — an absolute or protocol-relative URL ' +
        'would redirect authenticated users off-site.'
    );
  }

  return normalized;
}

/**
 * Fail loudly on an empty (but non-null) label, same rationale as the route:
 * an empty string is a valid non-null value, so `?? DEFAULT_AUTH_LANDING_LABEL`
 * would never catch it, and it would render as blank copy ("Back to ",
 * "Redirecting to ...") at every consuming site.
 */
function resolveAuthLandingLabel(): string {
  if (appAuthLandingLabel === null) return DEFAULT_AUTH_LANDING_LABEL;

  const trimmed = appAuthLandingLabel.trim();
  if (trimmed === '') {
    throw new Error(
      'Invalid appAuthLandingLabel in lib/app/auth-landing.ts: empty string. ' +
        'Leave it `null` to use the platform default, or set real display copy.'
    );
  }

  return trimmed;
}

/**
 * Where an authenticated user lands. Import this rather than hardcoding
 * `/dashboard`, so a fork's landing route is one edit and not eight.
 */
export const AUTH_LANDING_ROUTE = resolveAuthLandingRoute();

/**
 * What to call that destination in user-visible copy. Import this rather than
 * writing "Dashboard", so a fork's rename lands everywhere the route does.
 */
export const AUTH_LANDING_LABEL = resolveAuthLandingLabel();

/**
 * The path part of a root-relative route, without its query, fragment or a
 * trailing slash: `/app/?x=1` and `/app` are the same page to the router.
 */
export function routePathname(route: string): string {
  const { pathname } = new URL(route, 'http://localhost');
  return pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
}

/**
 * The auth pages (login, signup, password reset). The proxy sends a signed-in
 * user away from these, and from any path beneath them, to the landing route.
 */
export const AUTH_ROUTES: readonly string[] = ['/login', '/signup', '/reset-password'];

/** Whether `pathname` is one of {@link AUTH_ROUTES} or a path beneath it. */
export function isAuthRoutePath(pathname: string): boolean {
  return AUTH_ROUTES.some((route) => pathname === route || pathname.startsWith(`${route}/`));
}

/**
 * Fail loudly on a bad welcome route, for the landing route's reasons: it is
 * a redirect target. A welcome route on the landing route's own path would
 * redirect a member of an unfinished org to the page they were already
 * redirected from, for as long as the org stays unfinished, so that throws too.
 * So does one on or under an auth route: the proxy sends a signed-in user from
 * there back to the landing route, which sends them to the welcome route again.
 */
function resolveWelcomeRoute(): string | null {
  if (appWelcomeRoute === null) return null;

  const normalized = normalizeRootRelativePath(appWelcomeRoute.trim());
  if (normalized === null) {
    throw new Error(
      `Invalid appWelcomeRoute in lib/app/welcome.ts: ${JSON.stringify(appWelcomeRoute)}. ` +
        'Must be a root-relative path such as "/welcome".'
    );
  }
  if (routePathname(normalized) === routePathname(AUTH_LANDING_ROUTE)) {
    throw new Error(
      `Invalid appWelcomeRoute in lib/app/welcome.ts: ${JSON.stringify(appWelcomeRoute)} is the ` +
        'landing route itself, so a member of an unfinished org would be redirected to it forever. ' +
        'Give the welcome step its own page.'
    );
  }
  if (isAuthRoutePath(routePathname(normalized))) {
    throw new Error(
      `Invalid appWelcomeRoute in lib/app/welcome.ts: ${JSON.stringify(appWelcomeRoute)} is on an ` +
        `auth route (${AUTH_ROUTES.join(', ')}), which sends a signed-in user back to the landing ` +
        'route, so a member of an unfinished org would loop between the two. ' +
        'Give the welcome step a page outside the auth routes.'
    );
  }

  return normalized;
}

/**
 * Where a signed-in member of an org whose onboarding is unfinished lands
 * instead of {@link AUTH_LANDING_ROUTE} (§134 t-1063), or `null` when the app
 * sets none and nobody is redirected. The proxy applies it; see
 * `lib/tenancy/onboarding.ts`.
 */
export const AUTH_WELCOME_ROUTE = resolveWelcomeRoute();
