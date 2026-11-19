/**
 * App signup-org resolver registration (§134 t-1062).
 *
 * **Fork-owned scaffold** — Sunrise ships this empty and does NOT change it
 * after release, so your edits here merge cleanly on upgrade (the stable
 * contract is this file's export, not its body). Treat it like the other
 * `lib/app/*` seams.
 *
 * Auto-wired: `userCreateBeforeHook` (`lib/auth/config.ts`) calls this once,
 * lazily, before the first self-serve signup asks. Only at
 * `TENANCY_MODE=multi`, and only for a signup with no invitation or one from
 * the install org's own waitlist; invited signups and platform admins are
 * never asked, and at `single` nothing changes.
 *
 * With nothing registered, each such signup gets a new org of their own, as
 * its OWNER, and starts there. Register a resolver to choose otherwise:
 *
 *   import { prisma } from '@/lib/db/client';
 *   import { registerSignupOrgResolver } from '@/lib/tenancy/signup-org';
 *
 *   export function initAppSignupOrgResolver(): void {
 *     // People from a customer's domain join that customer's org.
 *     registerSignupOrgResolver(async ({ email }) => {
 *       const domain = email.split('@')[1]?.toLowerCase();
 *       const org = domain
 *         ? await prisma.org.findFirst({ where: { slug: ORG_SLUG_BY_DOMAIN[domain] } })
 *         : null;
 *       return org ? { kind: 'join', orgId: org.id } : { kind: 'own' };
 *     });
 *   }
 *
 * The resolver receives `{ email, emailVerified, name, signupMethod,
 * waitlistEntryId }` and answers one of:
 * - `{ kind: 'own', name? }` — a new org of their own, as OWNER (the default);
 * - `{ kind: 'join', orgId, role? }` — an existing org, as `role` (default
 *   MEMBER; taken as given, so name OWNER only when the match proves it);
 * - `{ kind: 'install' }` — the install org, as before this seam existed.
 *
 * Runs BEFORE the user row exists. On an email signup the address is not
 * proven yet (`emailVerified: false`): it is safe to match on only where the
 * install requires verification before sign-in (`REQUIRE_EMAIL_VERIFICATION`,
 * the production default), since otherwise anyone can sign up as any address.
 *
 * A resolver that throws, runs past 5 seconds, answers nothing, or names an
 * org that does not exist puts the signup in the install org, logged at
 * `error`: a fault here never refuses a signup. Empty = an org of their own
 * for every self-serve signup at `multi`.
 *
 * Full guide: CUSTOMIZATION.md §4 · .context/tenancy/identity.md
 */
export function initAppSignupOrgResolver(): void {
  // No app signup-org resolver by default.
}
