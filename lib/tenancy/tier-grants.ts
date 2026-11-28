/**
 * Granting named admin tiers to a MEMBER (t-1123).
 *
 * An org often has people who need part of the console, not all of it: a
 * marketer who runs one area, a designer from an agency the org works with.
 * An app names those parts as tiers (`registerAdminTier()`,
 * `lib/auth/admin-tier.ts`, t-999). This module is the platform's record of
 * who holds them: an `OrgMembershipGrant` beside a MEMBER membership, listing
 * the tiers it opens.
 *
 * - **It widens a MEMBER and nobody else.** A MEMBER reaches nothing in the
 *   console, and a grant can only add tiers to that, so it fails closed. The
 *   org's OWNER/ADMIN already open every named tier without one. A grant is
 *   refused beside any other role, and cleared when a member's role leaves
 *   MEMBER (`changeMemberRole`), so a later demotion cannot bring back tiers
 *   granted long ago.
 * - **A closed list, checked on write.** Only a registered tier that is
 *   {@link GrantableAdminTier grantable} can be written by a person, or by an
 *   accepted invitation. A signup healed from its record (t-838) writes the
 *   tiers that were grantable when it signed up. A tier the app later stops
 *   registering admits nobody, and one that gains its own `holds()` stops
 *   reading the grant unless it is grantable, so a stale name opens nothing.
 * - **Written, never bound.** An org admin sets it directly
 *   (`setMemberTiers()` in `lib/tenancy/lifecycle.ts`), or the org invitation
 *   carries it (`InvitationMetadata.tiers`) and acceptance writes it with the
 *   membership, on both paths: a new account (`membershipForNewUser`) and an
 *   existing one (`acceptInvitationAsExistingUser` → `addMember`).
 * - **Held by default.** A tier registered without its own `holds()` is held
 *   by a MEMBER whose grant lists it ({@link membershipGrantHolds}).
 *
 * The grant goes with its membership (cascade), so removing the member, or
 * erasing them or their org, removes it; both export manifests carry it inside
 * the membership rows. Guide: `.context/auth/authorization.md`, "Granting
 * named tiers".
 *
 * Server-side: reads the tier registry (which runs the app's init) and Prisma.
 * The modules that write a membership load it lazily, so that init never runs
 * at their import.
 */

import { prisma } from '@/lib/db/client';
import { namedAdminTier, namedAdminTiers } from '@/lib/auth/org-tier-admin-pages';
import type { AdminText } from '@/lib/auth/admin-tier';
import type { AuthorizationPrincipal } from '@/lib/auth/authorization';
import { DEFAULT_ORG_ROLE } from '@/lib/tenancy/roles';
import { isMultiTenant } from '@/lib/tenancy/context';

/** The most tiers one grant may list. More than any app registers; a bound on what a request may send. */
export const MAX_GRANTED_TIERS = 32;

/** A tier an org admin may grant, as the Members page and the API show it. */
export interface GrantableAdminTier {
  name: string;
  /** The app's name for it (`registerAdminTier`'s `label`), when it gave one. */
  label?: AdminText;
  /** The app's one or two sentences on it, when it gave them. */
  description?: AdminText;
}

/**
 * The named tiers an org admin may grant, in registration order: empty unless
 * the app registered one that is grantable. What the invite form and a
 * member's row offer, and what every write is checked against.
 *
 * Empty at `TENANCY_MODE=single`: the policy admits nobody to a named tier
 * there (the org-tier arm is `multi` only), so a grant would open nothing,
 * and the page would offer a setting that does nothing.
 */
export function grantableAdminTiers(): readonly GrantableAdminTier[] {
  if (!isMultiTenant()) return [];
  const tiers: GrantableAdminTier[] = [];
  for (const name of namedAdminTiers()) {
    const definition = namedAdminTier(name);
    if (!definition?.grantable) continue;
    tiers.push({
      name,
      ...(definition.label === undefined ? {} : { label: definition.label }),
      ...(definition.description === undefined ? {} : { description: definition.description }),
    });
  }
  return tiers;
}

/** Is `name` a registered tier an org admin may grant? Never at `single` (see {@link grantableAdminTiers}). */
export function isGrantableTier(name: string): boolean {
  return isMultiTenant() && namedAdminTier(name)?.grantable === true;
}

/**
 * The grantable tiers among `asked`, once each, in registration order: what a
 * write keeps. A tier that is not registered, or not grantable, is dropped.
 */
export function grantableTiersAmong(asked: readonly string[]): string[] {
  const wanted = new Set(asked);
  return grantableAdminTiers()
    .map((tier) => tier.name)
    .filter((name) => wanted.has(name));
}

/**
 * The names among `asked` that cannot be granted, once each, in the order
 * asked: what a write from a person refuses, rather than quietly dropping a
 * tier they chose.
 */
export function ungrantableTiersAmong(asked: readonly string[]): string[] {
  return [...new Set(asked)].filter((name) => !isGrantableTier(name));
}

/**
 * Does the grant on this viewer's membership in the org they entered list
 * `tier`? The default `holds()` of a tier registered without one, and what an
 * app's own `holds()` calls to read the grant as part of its answer.
 *
 * True only for a MEMBER: by the role the guard told the policy, and by the
 * row, read now, so a role changed since the session began cannot hold a
 * tier on a grant that change cleared. One indexed read (the membership's
 * `(orgId, userId)` unique, with its grant). Throws on a failed read, which
 * the policy reads as no and logs.
 */
export async function membershipGrantHolds(
  viewer: Readonly<Pick<AuthorizationPrincipal, 'userId' | 'orgRole'> & { orgId: string }>,
  tier: string
): Promise<boolean> {
  if (viewer.orgRole !== DEFAULT_ORG_ROLE) return false;
  const membership = await prisma.orgMembership.findUnique({
    where: { orgId_userId: { orgId: viewer.orgId, userId: viewer.userId } },
    select: { role: true, grant: { select: { tiers: true } } },
  });
  return membership?.role === DEFAULT_ORG_ROLE && (membership.grant?.tiers ?? []).includes(tier);
}
