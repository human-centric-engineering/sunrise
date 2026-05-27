/**
 * App admin-nav registrations (fork-readiness — the `lib/app/` bootstrap surface).
 *
 * This function is **auto-wired**: `components/admin/admin-sidebar.tsx` imports
 * and calls it once, at module load, in the **client runtime** (and during the
 * server render of the client component) — so app sections are in the registry
 * before the sidebar first reads it. You don't wire anything; just add
 * `registerNavSection()` calls to the body.
 *
 * Why a dedicated file (not one shared bootstrap): Next.js bundles middleware,
 * server route-handlers, and the client as three separate module realms, so a
 * registration only takes effect in the realm where it runs. The sidebar is a
 * `'use client'` component, so its registry must be populated in the client
 * bundle — hence this file (not the server-side `lib/app/capabilities.ts` /
 * `lib/app/rate-limit.ts`). Keep this file client-safe: no server-only imports
 * (DB, `next/server`, secrets) — just the registrar and icon components.
 *
 * Default: empty (a no-op). To add a section, import the registrar (and an
 * icon), then register it. Use a `title` distinct from the core sections
 * ("Overview", "Management", "AI Orchestration", "System"):
 *
 * ```ts
 * import { registerNavSection } from '@/lib/admin-nav/registry';
 * import { CreditCard } from 'lucide-react';
 *
 * export function initAppNav(): void {
 *   registerNavSection({
 *     title: 'Billing',
 *     items: [
 *       { href: '/admin/billing', label: 'Invoices', icon: CreditCard, description: 'Customer invoices' },
 *     ],
 *   });
 * }
 * ```
 *
 * @see .context/admin/orchestration.md and lib/admin-nav/registry.ts
 */
export function initAppNav(): void {
  // No app nav sections by default. See the JSDoc example above.
}
