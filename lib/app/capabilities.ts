/**
 * App capability registrations (fork-readiness — the `lib/app/` bootstrap surface).
 *
 * This function is **auto-wired**: `registerBuiltInCapabilities()` calls it once
 * in the **server route-handler runtime** (the realm the chat handler and the
 * agent-call executor run in), right before the built-ins are flushed into the
 * dispatcher — so an app capability is available the first time an agent's tools
 * are resolved. You don't wire anything; just add `registerAppCapability()`
 * calls to the body.
 *
 * Why a dedicated file (not one shared bootstrap): Next.js bundles middleware,
 * server route-handlers, and the client as three separate module realms, so a
 * registration only takes effect in the realm where it runs. Each `lib/app/`
 * file is imported by the core consumer in the matching realm — capabilities
 * here (server), rate-limit in `lib/app/rate-limit.ts` (middleware), nav in
 * `lib/app/admin-nav.ts` (client).
 *
 * Default: empty (a no-op). To add a tool, import the registrar and your
 * `BaseCapability` subclass, then register it:
 *
 * ```ts
 * import { registerAppCapability } from '@/lib/orchestration/capabilities';
 * import { LookupOrderCapability } from '@/lib/app/capabilities/lookup-order';
 *
 * export function initAppCapabilities(): void {
 *   registerAppCapability(new LookupOrderCapability());
 * }
 * ```
 *
 * @see .context/orchestration/capabilities.md — the app-author guide
 */
export function initAppCapabilities(): void {
  // No app capabilities by default. See the JSDoc example above.
}
