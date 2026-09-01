/**
 * App rate-limit registrations.
 *
 * **Fork-owned scaffold** — Sunrise ships this empty and does NOT change it
 * after release, so your edits here merge cleanly on upgrade (the stable
 * contract is this file's export, not its body). Treat it like the landing
 * page: a starting point you're expected to modify.
 *
 * Auto-wired: the rate-limit middleware imports and calls this once at module
 * load (middleware runtime). Add `registerRateLimitTier()` /
 * `registerRateLimitKeyResolver()` / `registerRateLimitRule()` calls —
 * registration is namespace-scoped and fails fast (it throws if a rule could
 * shadow a Sunrise-protected surface, or names a custom key whose resolver
 * hasn't been registered yet — resolvers first, then rules).
 *
 * Full guide + example: CUSTOMIZATION.md §4 · .context/security/rate-limiting.md
 */
export function registerAppRateLimits(): void {
  // No app rate-limit tiers/rules by default.
}
