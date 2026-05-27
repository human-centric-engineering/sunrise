/**
 * App rate-limit registrations (fork-readiness — the `lib/app/` bootstrap surface).
 *
 * This function is **auto-wired**: Sunrise's rate-limit middleware imports and
 * calls it once, at module load, in the **middleware runtime** — the realm
 * `proxy.ts` evaluates the policy in. You don't wire anything; just add your
 * `registerRateLimitTier()` / `registerRateLimitRule()` calls to the body.
 *
 * Why a dedicated file (not one shared bootstrap): Next.js bundles middleware,
 * server route-handlers, and the client as three separate module realms, so a
 * registration only takes effect in the realm where it runs. Each `lib/app/`
 * file is imported by the core consumer in the matching realm — rate-limit here
 * (middleware), capabilities in `lib/app/capabilities.ts` (server), nav in
 * `lib/app/admin-nav.ts` (client). Separate files also keep the lean middleware
 * bundle free of capability/Prisma code.
 *
 * Default: empty (a no-op). Most apps never need this — every `/api/v1/**` route
 * already inherits the 100/min `api` tier. Reach for it only when a route needs
 * a genuinely different cap or keying. To use it, import the toolkit and fill
 * in the body:
 *
 * ```ts
 * import { createRateLimiter, registerRateLimitTier } from '@/lib/security/rate-limit';
 * import { registerRateLimitRule } from '@/lib/security/rate-limit-policy';
 * import { SECURITY_CONSTANTS } from '@/lib/security/constants';
 *
 * export function registerAppRateLimits(): void {
 *   registerRateLimitTier(
 *     'billing',
 *     createRateLimiter({
 *       interval: SECURITY_CONSTANTS.RATE_LIMIT.DEFAULT_INTERVAL,
 *       maxRequests: 40,
 *       uniqueTokenPerInterval: SECURITY_CONSTANTS.RATE_LIMIT.MAX_UNIQUE_TOKENS,
 *     })
 *   );
 *   registerRateLimitRule({ match: /^\/api\/v1\/billing\//, tier: 'billing', key: 'session-user' });
 * }
 * ```
 *
 * Registration is order-safe and fails fast: `registerRateLimitRule` throws at
 * call time if a matcher could shadow a Sunrise-protected surface
 * (`/api/v1/admin/**`, `/api/auth/**`, `/api/v1/auth/**`, `/api/v1/mcp/**`), and
 * `registerRateLimitTier` throws on a name that collides with a built-in tier —
 * so a misconfiguration aborts boot rather than silently weakening a cap.
 *
 * @see .context/security/rate-limiting.md — App / Fork Extension
 */
export function registerAppRateLimits(): void {
  // No app rate-limit tiers/rules by default. See the JSDoc example above.
}
