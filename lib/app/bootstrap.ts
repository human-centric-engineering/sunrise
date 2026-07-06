/**
 * App boot seam — one-time server startup work.
 *
 * **Fork-owned scaffold** — Sunrise ships this empty and does NOT change it
 * after release, so your edits here merge cleanly on upgrade (the stable
 * contract is this file's `initApp` export, not its body). Treat it like the
 * landing page: a starting point you're expected to modify.
 *
 * Auto-wired: `instrumentation.ts`'s `register()` calls `initApp()` once per
 * server process, right after the `NEXT_RUNTIME === 'nodejs'` check and
 * **before** the dev-only maintenance-ticker guards — so it runs in production
 * too. The call is isolated in a try/catch there: a boot failure here is logged
 * but never crashes instrumentation or stops the dev ticker arming.
 *
 * Keep core out of it: `instrumentation.ts` imports only this file. If your
 * fork boots a framework tier, import its entry point **dynamically** from here
 * (`await import('@/lib/framework')`) — a *static* framework specifier is
 * resolved at `next build` time and breaks the build in vanilla Sunrise (and in
 * any fork without that folder). A framework-tier fork typically boots its own
 * tier here and then delegates to a fresh reserved leaf hook (e.g.
 * `lib/app/leaf-bootstrap.ts`) so a leaf-on-framework fork can still hook boot
 * without colliding on this file.
 *
 * Full guide: CUSTOMIZATION.md §4 · the reserved `/framework` fork tier.
 */
export async function initApp(): Promise<void> {
  // No app boot work by default.
}
