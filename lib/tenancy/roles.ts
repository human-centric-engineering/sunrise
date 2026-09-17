/**
 * Org-role vocabulary — the single source of truth for `OrgMembership.role`.
 *
 * The second permission axis. `User.role` (`lib/auth/roles.ts`) says what a
 * principal may do to the *platform*; this says what they may do inside one
 * *org*. The two are deliberately separate modules with separate literals,
 * because a platform `ADMIN` and an org `ADMIN` are different grants — the
 * first operates the install, the second administers one customer — and a
 * shared constant would invite `isPlatformAdmin(member)` to mean something it
 * does not. `tests/unit/auth-role-literals.test.ts` polices both vocabularies:
 * a bare `'OWNER'` outside this file fails the build the way a bare `'ADMIN'`
 * outside `lib/auth/roles.ts` does.
 *
 * The set is **closed** — three values, by design principle 8 of
 * `.context/architecture/multi-tenancy-design.md` ("org roles stop at
 * OWNER / ADMIN / MEMBER"; a fork's product tiers sit beneath the org, not on
 * this column). That is why the schema column is a Prisma `enum` where
 * `User.role` is a free-form string: the database refuses a fourth value, and
 * `tests/unit/lib/tenancy/roles.test.ts` asserts this list and the enum agree.
 *
 * Same shape and the same constraint as `lib/auth/roles.ts`: side-effect-free,
 * importing nothing from Prisma, better-auth or `next/*`, so a `'use client'`
 * component, a seed, a smoke script and a route handler all read one list.
 *
 * @see lib/auth/roles.ts — the platform axis, and the shape this follows
 * @see lib/tenancy/constants.ts — the install org's fixed identity
 */

/**
 * Every role an `OrgMembership.role` may hold.
 *
 * Listed most- to least-privileged, and {@link orgAdministers} reads that
 * order — but nothing else does, and a role that is not comparable to the
 * others must not be slotted in by position.
 */
export const ORG_ROLES = ['OWNER', 'ADMIN', 'MEMBER'] as const;

/** A known `OrgMembership.role` value. */
export type OrgRole = (typeof ORG_ROLES)[number];

/** The role a member gets when nothing chooses one — the invitation flow's default. */
export const DEFAULT_ORG_ROLE = 'MEMBER' as const;

/**
 * The role the org's founding member holds, and the one the identity
 * migration gives every platform admin in the install org. An org keeps at
 * least one of these (§106 t-672 enforces it).
 */
export const ORG_OWNER_ROLE = 'OWNER' as const;

/** Administers the org without the OWNER's standing — may not remove the last OWNER. */
export const ORG_ADMIN_ROLE = 'ADMIN' as const;

/**
 * Is `value` an org role this install knows about?
 *
 * The narrowing form for data crossing a boundary — invitation metadata, a
 * form field, a header. An unrecognised value is not a role.
 */
export function isOrgRole(value: unknown): value is OrgRole {
  return typeof value === 'string' && (ORG_ROLES as readonly string[]).includes(value);
}

/**
 * Does this org role administer the org — manage members, settings, and
 * (once §106 t-671 lands) satisfy the authorization policy's org arm?
 *
 * OWNER and ADMIN both do; the difference between them is standing, not
 * capability: only an OWNER cannot be removed as the org's last one. Takes a
 * bare role rather than a membership row so the one predicate serves a Prisma
 * row, a session claim and a test fixture alike. Null-safe for the same reason
 * `isPlatformAdmin` is — several call sites read through an optional
 * membership.
 */
export function orgAdministers(role: string | null | undefined): boolean {
  return role === ORG_OWNER_ROLE || role === ORG_ADMIN_ROLE;
}
