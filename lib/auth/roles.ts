/**
 * Role vocabulary — the single source of truth for `User.role`.
 *
 * `User.role` is a free-form `String` on the schema (`prisma/schema/auth.prisma`)
 * with two values by convention. Before this module that convention lived as a
 * bare `'ADMIN'` literal in 37 places across route handlers, client components,
 * Zod schemas, seeds and smoke scripts — so a fork adding a third value (a
 * platform-staff tier, an org-scoped role) had no canonical list, no type
 * safety, and no way to find every site but a string hunt (#366 item 3).
 *
 * Deliberately the same shape as its sibling `lib/auth/account.ts`, which is
 * the precedent #366 names. **The properties are the requirement, not the
 * style:** side-effect-free, and importing nothing from Prisma, better-auth or
 * `next/*`. That is what lets a `'use client'` component, a seed, a smoke
 * script and a route handler all read the same list — and several of the
 * comparison sites are in client components, so a roles module that reached for
 * the session would be unusable by the callers that need it most. It is the
 * same constraint that forced `lib/auth/api-key-scopes.ts` out of
 * `lib/auth/api-keys.ts`.
 *
 * ## The two axes, and why this one is named "platform"
 *
 * `role` is the **permission** axis. `accountType` (HUMAN / SERVICE) is the
 * **nature** axis and is kept orthogonal to it in `account.ts` rather than
 * overloaded onto `role` — a distinction #279 was filed over. A third,
 * **org-scoped** axis arrives with multi-tenancy: at that point today's global
 * `ADMIN` narrows to meaning platform staff, and a customer's own administrator
 * becomes a separate org role rather than a third value here.
 *
 * {@link isPlatformAdmin} carries that word already, before the org axis
 * exists, so the narrowing is a documentation change rather than a rename
 * across a fresh set of call sites.
 *
 * ## Adding a role
 *
 * Add it to {@link USER_ROLES}. Everything that enumerates the vocabulary reads
 * from there — the Zod schemas, the client-side session validator, the admin
 * form's select options, the badge variants — so the new value becomes
 * mintable, selectable and validated without a sweep.
 *
 * What it does **not** do is decide anything: a new role grants nothing until
 * some guard asks about it. That is deliberate, and it is why this module has
 * one predicate rather than a `hasRole(x)` for every value.
 *
 * @see lib/auth/account.ts — the `accountType` axis, and the shape this follows
 * @see tests/unit/auth-role-literals.test.ts — the guard that keeps the sweep swept
 */

/**
 * Every role `User.role` may hold.
 *
 * The order is not meaningful — this is a set of known values, not a ladder.
 * Nothing derives seniority from position, and a reader who assumes it does
 * would be wrong the moment a non-comparable role is added.
 */
export const USER_ROLES = ['USER', 'ADMIN'] as const;

/** A known `User.role` value. */
export type UserRole = (typeof USER_ROLES)[number];

/**
 * The role a new user gets, and the fallback when a stored value is
 * unrecognised. Typed as the literal rather than as `UserRole`, so a Prisma
 * `where` fragment built from it keeps its narrow type.
 */
export const DEFAULT_USER_ROLE = 'USER' as const;

/**
 * The platform-staff role — "this principal operates the install", not "this
 * principal administers their own organisation".
 *
 * Compare against this rather than writing `'ADMIN'`, and prefer
 * {@link isPlatformAdmin} where the question is about a principal rather than
 * about a value being written.
 */
export const PLATFORM_ADMIN_ROLE = 'ADMIN' as const;

/**
 * Is `value` a role this install knows about?
 *
 * The narrowing form, for data crossing a boundary — a session field the client
 * types do not cover, a form submission, a row written before a role was
 * renamed. An unrecognised value is not a role, and callers should fall back to
 * {@link DEFAULT_USER_ROLE} rather than trusting it.
 */
export function isUserRole(value: unknown): value is UserRole {
  return typeof value === 'string' && (USER_ROLES as readonly string[]).includes(value);
}

/**
 * Is this principal platform staff?
 *
 * Takes a structural shape rather than a session type, so the one predicate
 * serves a better-auth session user, a Prisma `User` row, and the raw object
 * the client-side session hook validates — none of which share a type, and all
 * of which were asking this question with their own `=== 'ADMIN'`.
 *
 * Null-safe on purpose: several call sites read through an optional session
 * (`session?.user?.role`), and making each one guard separately is how a
 * missing check becomes a truthiness bug.
 */
export function isPlatformAdmin(principal: { role?: string | null } | null | undefined): boolean {
  return principal?.role === PLATFORM_ADMIN_ROLE;
}

/**
 * The human-readable label for a role, as shown in the admin forms.
 *
 * Derived from the value rather than mapped from a table, so a role added to
 * {@link USER_ROLES} appears in the role selects with a sensible label instead
 * of requiring a second edit somewhere else — which is the drift this module
 * exists to remove. A fork wanting different wording overrides at the call
 * site; this is a default, not a translation layer.
 */
export function roleLabel(role: UserRole): string {
  return role.charAt(0) + role.slice(1).toLowerCase();
}
