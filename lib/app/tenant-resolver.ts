/**
 * App tenant-resolver registration (§106).
 *
 * **Fork-owned scaffold** — Sunrise ships this empty and does NOT change it
 * after release, so your edits here merge cleanly on upgrade (the stable
 * contract is this file's export, not its body). Treat it like the landing
 * page: a starting point you're expected to modify.
 *
 * Auto-wired: `proxy.ts` imports and calls this once at module load, then asks
 * the resolver you register on every request and forwards its answer as the
 * `x-sunrise-org` request header (proxy sole writer — any inbound copy is
 * stripped). The guards verify the caller is a member of the org it names; a
 * resolver picks the tenant, it never grants access.
 *
 * **Web-standard only** — this runs in the proxy: `Request`, `URL`, `Headers`,
 * and nothing that needs Node or Prisma. Answer from what you can verify
 * without I/O (the hostname, a signed cookie) and return `null` when you
 * cannot say.
 *
 * Example (a `<org-slug>.example.com` scheme — note the org ID, not the slug,
 * is what the header carries, so map it from something you can trust):
 *
 *   import { registerTenantResolver } from '@/lib/tenancy/resolver';
 *
 *   export function registerAppTenantResolver(): void {
 *     registerTenantResolver((request) => {
 *       const host = request.headers.get('host') ?? '';
 *       const [sub] = host.split('.');
 *       return sub && sub !== 'www' ? ORG_ID_BY_SUBDOMAIN[sub] ?? null : null;
 *     });
 *   }
 *
 * Full guide: .context/tenancy/context.md · CUSTOMIZATION.md §4
 */
export function registerAppTenantResolver(): void {
  // No app tenant resolver by default: the org comes from the session, the
  // API key, or — at single — the install org.
}
