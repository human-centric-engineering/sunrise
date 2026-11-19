/**
 * App welcome route — where a member of an org whose onboarding is unfinished
 * lands after sign-in.
 *
 * **Fork-owned scaffold** — Sunrise ships this `null` (= nobody is redirected)
 * and does NOT change this file after release, so your edits here merge
 * cleanly on upgrade (the stable contract is this file's export, not its
 * value).
 *
 * Every org created after §134 t-1063 starts with its onboarding unfinished
 * (`Org.settings.awaitingOnboarding`); the install org and every org that
 * existed before read as finished. Set this to your welcome page, and a
 * signed-in member of an unfinished org who reaches the landing route
 * (`lib/app/auth-landing.ts`) is redirected here instead, by the proxy. Once
 * the welcome step is done, your server code calls
 * `markOrgOnboarded(orgId)` (`lib/tenancy/onboarding.ts`) and they land on the
 * usual route from then on. The welcome page itself is yours.
 *
 *   export const appWelcomeRoute: string | null = '/welcome';
 *
 * Must be a root-relative path, and not the landing route itself (that would
 * redirect to itself): either mistake throws at module load, as the landing
 * route does. Add its prefix to `lib/app/protected-routes.ts` so a signed-out
 * visitor is sent to login rather than shown the page.
 *
 * This is per org. A person's own first-run tour (one per user, inside an org
 * that is already set up) is product UI and stays yours: Sunrise records
 * nothing per user for it.
 *
 * Full guide: CUSTOMIZATION.md §4 · .context/tenancy/identity.md
 */

/** Where a member of an unfinished org lands. `null` = nobody is redirected. */
export const appWelcomeRoute: string | null = null;
