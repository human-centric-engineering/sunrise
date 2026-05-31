/**
 * Shared auth constants.
 *
 * Kept in a side-effect-free module (no `better-auth` / Prisma client / email
 * config imports) so it can be pulled into lightweight contexts — seed scripts,
 * the database hooks in `config.ts` — without instantiating the auth server.
 */

/**
 * Email of the non-login SYSTEM config-owner user seeded by
 * `prisma/seeds/001-system-owner.ts`.
 *
 * This account exists solely to own seeded orchestration configuration
 * (workflows, capabilities, provider models, judges, etc. all set
 * `createdBy = <the ADMIN user>`). It has role `ADMIN` but **no credential
 * `Account`**, so it can never log in.
 *
 * The first-human-is-admin bootstrap in `userCreateBeforeHook` excludes this
 * address when deciding whether a fresh database has any real users yet — so
 * the first person who signs up still becomes the admin.
 */
export const SYSTEM_USER_EMAIL = 'system@sunrise.local';

/**
 * Fixed primary key of the singleton `AuthBootstrap` row.
 *
 * The first-human-is-admin promotion in `userCreateBeforeHook` is gated on the
 * ABSENCE of this row. Once the first admin exists the row is written (in
 * `userCreateAfterHook`) and the promotion can never fire again — even if every
 * human account is later deleted and the live user count returns to zero. This
 * closes the re-bootstrap privilege-escalation window that a pure live-count
 * check would leave open.
 */
export const AUTH_BOOTSTRAP_ID = 'singleton';
