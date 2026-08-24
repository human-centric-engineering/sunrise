/**
 * The Sunrise platform version this checkout corresponds to.
 *
 * SOURCE OF TRUTH for the Sunrise version. Do NOT derive this from
 * `package.json.version` — forks edit that with their own app's version, and
 * Sunrise's version would silently follow the fork's. The fork's app version
 * lives in `lib/app-version.ts` (a separate file by design). See
 * `VERSIONING.md` for the full rationale and the public-surface contract this
 * version commits to.
 *
 * Bumped by Sunrise maintainers as part of cutting a release (one-line edit
 * + git tag + CHANGELOG entry — see CONTRIBUTING.md "Cutting a release").
 * Forks merge this file along with the rest of upstream; they do NOT edit it.
 *
 * # Conventions
 *
 * - **Server-side use only.** This file is platform-agnostic (no Next.js
 *   imports — consumed by the orchestration MCP tier as well as Next.js
 *   routes), so we deliberately do NOT mark it `server-only`. Do not import
 *   this constant in a `'use client'` component.
 * - **Not on `/api/health`.** That endpoint is unauthenticated, and this
 *   version names the exact upstream release — and therefore the exact
 *   published issues — for every Sunrise-derived deployment, not just one.
 *   It is served from `GET /api/v1/admin/stats` as `system.sunriseVersion`
 *   (behind `withAdminAuth`) and rendered by `components/admin/system-info.tsx`
 *   on `/admin/overview`. Reach it from a client component through that
 *   route; from a server component, import it here. Two other routes also
 *   return it — the MCP settings route and the MCP `initialize` handshake —
 *   and both are authenticated. Keep it that way: the invariant is that no
 *   unauthenticated surface carries it (#531).
 */
export const SUNRISE_VERSION = '0.10.0';
