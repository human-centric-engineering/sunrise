/**
 * App erasure cleanup-hook registrations (GDPR Art. 17).
 *
 * **Fork-owned scaffold** — Sunrise ships this empty and does NOT change it
 * after release, so your edits here merge cleanly on upgrade (the stable
 * contract is this file's export, not its body). Treat it like the other
 * `lib/app/*` seams.
 *
 * Auto-wired: `getErasureCleanupHooks()` (`lib/privacy/erasure-hooks.ts`) calls
 * this once before its first read, in the module graph `eraseUser()` runs in.
 * Add `registerErasureCleanupHook({ name, cleanupExternal?, scrubInTransaction? })`
 * calls for app data the FK cascade cannot reach: object-storage blobs, search
 * documents, and PII left on rows your `ON DELETE SET NULL` tables keep.
 *
 * Must be synchronous — register here, do the async work inside the hook.
 *
 * Full guide + example: .context/privacy/data-erasure.md · CUSTOMIZATION.md §4
 */
export function initAppErasureHooks(): void {
  // No app erasure hooks by default.
}
