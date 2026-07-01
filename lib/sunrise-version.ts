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
 *   routes), so we deliberately do NOT mark it `server-only`. Render the
 *   version in client components by fetching `/api/health` (which exposes
 *   it as the `sunrise` field), not by importing this constant in a
 *   `'use client'` component.
 */
export const SUNRISE_VERSION = '0.5.0';
