/**
 * Account-type predicates — the single source of truth for distinguishing real
 * human users from non-login SERVICE principals (e.g. the seeded
 * `system@sunrise.local` config-owner).
 *
 * `User.accountType` (HUMAN | SERVICE) is orthogonal to `User.role` (the
 * permission axis). Every query that counts, lists, or gates on "real admins"
 * or "real users" MUST use these fragments instead of re-implementing the
 * filter inline — that inline duplication (originally `email !== SYSTEM_USER_EMAIL`)
 * was the root cause of the admin-miscount / lockout findings in PR #279.
 *
 * Side-effect-free (no Prisma client / better-auth imports) so it is safe to
 * import from seeds, hooks, and route handlers alike.
 */

/** Matches real, login-capable users (excludes SERVICE principals). */
export const humanWhere = { accountType: 'HUMAN' } as const;

/** Matches real human admins — the "is there still a real operator?" predicate. */
export const humanAdminWhere = { role: 'ADMIN', accountType: 'HUMAN' } as const;

/** Matches non-login SERVICE principals (the seeded config-owner). */
export const serviceAccountWhere = { accountType: 'SERVICE' } as const;
