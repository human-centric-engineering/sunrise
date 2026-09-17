/**
 * Tenancy constants.
 *
 * Side-effect-free (no Prisma client, no better-auth, no `next/*`) for the
 * same reason `lib/auth/constants.ts` is: these are read by the identity
 * migration's tests, by seeds and smoke scripts, and by the database hooks in
 * `lib/auth/config.ts` — none of which should instantiate anything to learn a
 * string.
 */

/**
 * Fixed primary key of the install org.
 *
 * The `AUTH_BOOTSTRAP_ID = 'singleton'` precedent: a literal rather than a
 * lookup, so the identity migration, the user-creation hook and the guard's
 * "no org chosen at `single` ⇒ the install org" rule (§106 t-671) all name the
 * same row without a query. The migration
 * (`prisma/migrations/20260917120000_org_identity`) inserts it with this id
 * and `ON CONFLICT DO NOTHING`; `tests/unit/lib/tenancy/migration.test.ts`
 * asserts the SQL and this constant agree.
 *
 * The install org can never be suspended or deleted (§106 ruling b) — it is
 * the one row principle 1 of the tenancy design promises always exists.
 */
export const INSTALL_ORG_ID = 'install';

/** Slug of the install org — the URL-facing name of {@link INSTALL_ORG_ID}. */
export const INSTALL_ORG_SLUG = 'install';
