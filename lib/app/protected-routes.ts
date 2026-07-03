/**
 * App-owned protected route prefixes.
 *
 * **Fork-owned scaffold** — Sunrise ships this empty (`[]`) and does NOT change
 * it after release, so your edits merge cleanly on upgrade (the stable contract
 * is this export, not its value). Treat it like the landing page: a starting
 * point you're expected to modify.
 *
 * The model is *append*, not replacement: prefixes listed here are **merged
 * with** the platform's core protected routes (`/dashboard`, `/settings`,
 * `/profile`) at proxy startup — the core prefixes always stay protected. Any
 * request whose path starts with a listed prefix gets the cheap edge
 * redirect-to-login when the visitor has no session cookie. Append your fork's
 * new authenticated top-level sections here (e.g. `/projects`) instead of
 * editing the `proxy.ts` literal.
 *
 * Scope: this is only the "is-logged-in-at-all" edge gate. Per-resource
 * membership / ownership authorisation (the finer grain) stays in the guard
 * layer above (`withAuth` / `withAdminAuth` in `lib/auth/guards.ts`) — a prefix
 * here does not grant or check any specific permission.
 *
 * Format: leading-slash, no-trailing-slash prefixes (e.g. `/projects`). The
 * proxy ignores any entry that doesn't start with `/` — in particular an empty
 * string, which would otherwise match every path and lock the whole app behind
 * the login redirect.
 *
 * Boundary-clean: a plain string array (no imports), so this stays within the
 * `lib/app/**` framework-agnostic boundary and is safe to import at the proxy
 * runtime.
 *
 * Full guide: CUSTOMIZATION.md
 */
export const appProtectedRoutes: string[] = [];
