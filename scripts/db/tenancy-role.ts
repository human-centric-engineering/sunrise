/**
 * Create or remove the restricted app role row isolation needs (§107 t-707).
 *
 *   TENANCY_APP_ROLE_PASSWORD=… npm run db:tenancy:role -- --create
 *   npm run db:tenancy:role -- --drop
 *
 * **Why a second role is required, not optional.** A table's owner is never
 * subject to its policies unless FORCE is on, and a `BYPASSRLS` role is never
 * subject to them at all. On Neon the deploy role (`neondb_owner`) is not a
 * superuser but has `BYPASSRLS`; locally the owner is usually `postgres`. An
 * app connecting as either sees every row whatever the policies say (Spike
 * register item 7). So at `TENANCY_MODE=multi` the app connects as this role
 * — `LOGIN NOBYPASSRLS`, not the owner — and `MIGRATE_DATABASE_URL` keeps the
 * owner for migrations, seeds and `db:tenancy:enable|disable`.
 *
 * Grants: `USAGE` on the current schema, `SELECT/INSERT/UPDATE/DELETE` on its
 * tables — except `_prisma_migrations`, which the app never touches and a
 * compromised app role must not be able to forge — and `USAGE/SELECT` on its
 * sequences, plus `ALTER DEFAULT PRIVILEGES` for the connecting (owner) role
 * so tables and sequences future migrations create are covered without
 * re-running this. The password is sent as a SCRAM-SHA-256 verifier computed
 * here, never as cleartext, and the script refuses to touch a role that is
 * the one running it, a superuser, `BYPASSRLS`, or a table owner.
 *
 * `--create` is idempotent: an existing role has its password reset and its
 * grants re-applied. `--drop` revokes the default privileges and every grant
 * first, then drops the role — Neon refuses `DROP OWNED BY`, and a role that
 * still holds a grant cannot be dropped anywhere. The role name comes from
 * `TENANCY_APP_ROLE` (default `sunrise_app`); the password only ever from
 * `TENANCY_APP_ROLE_PASSWORD`, never an argument (it would show in `ps`).
 *
 * Connects with `MIGRATE_DATABASE_URL` when set, else `DATABASE_URL` — a role
 * that can `CREATE ROLE` and owns the tables. Exit 0 done, 2 could not run.
 *
 * @see .context/tenancy/isolation.md#the-role-split
 */

import { Client } from 'pg';
import { logger } from '@/lib/logging';
import { ownerDsn, scramSha256Verifier } from '@/lib/tenancy/isolation';

const DEFAULT_ROLE = 'sunrise_app';
const ROLE_NAME = /^[a-z_][a-z0-9_]*$/;
type Action = 'create' | 'drop';

function parseAction(argv: readonly string[]): Action {
  const create = argv.includes('--create');
  const drop = argv.includes('--drop');
  if (create === drop) throw new Error('Pass exactly one of --create or --drop');
  return create ? 'create' : 'drop';
}

async function roleExists(client: Client, role: string): Promise<boolean> {
  const { rows } = await client.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM pg_roles WHERE rolname = $1',
    [role]
  );
  return rows[0]?.n === '1';
}

async function currentSchema(client: Client): Promise<string> {
  const { rows } = await client.query<{ schema: string }>('SELECT current_schema() AS schema');
  const schema = rows[0]?.schema;
  if (!schema) throw new Error('could not determine the current schema');
  return client.escapeIdentifier(schema);
}

/**
 * Refuse to touch a role this script must never demote: the one running it,
 * a superuser, a `BYPASSRLS` role, or the owner of any table in the schema.
 * `--create` on an existing role re-asserts `NOSUPERUSER NOBYPASSRLS` and
 * resets the password, so `TENANCY_APP_ROLE=postgres` would otherwise lock
 * the operator out of their own database.
 */
async function refuseIfPrivileged(client: Client, role: string): Promise<void> {
  const { rows } = await client.query<{
    is_self: boolean;
    is_super: boolean;
    bypasses: boolean;
    owns_tables: boolean;
  }>(
    `SELECT r.rolname = current_user AS is_self,
            r.rolsuper AS is_super,
            r.rolbypassrls AS bypasses,
            EXISTS (
              SELECT 1 FROM pg_class c
              JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE c.relowner = r.oid AND c.relkind IN ('r', 'p') AND n.nspname = current_schema()
            ) AS owns_tables
       FROM pg_roles r WHERE r.rolname = $1`,
    [role]
  );
  const row = rows[0];
  if (!row) return;
  const why = row.is_self
    ? 'it is the role running this script'
    : row.is_super
      ? 'it is a superuser'
      : row.bypasses
        ? 'it has BYPASSRLS'
        : row.owns_tables
          ? 'it owns tables in the current schema'
          : null;
  if (why) {
    throw new Error(
      `refusing to change role "${role}": ${why}. The app role must be a separate, unprivileged login — set TENANCY_APP_ROLE to a new name.`
    );
  }
}

async function create(client: Client, role: string, password: string): Promise<void> {
  const r = client.escapeIdentifier(role);
  const pw = client.escapeLiteral(scramSha256Verifier(password));
  const s = await currentSchema(client);
  await refuseIfPrivileged(client, role);
  // The app never reads or writes the migration ledger; a compromised app
  // role must not be able to mark a migration applied so a deploy skips it.
  // The ledger has to exist for that to hold: created before the first
  // `migrate deploy`, the default privileges above would grant it later.
  const ledger = await client.query<{ present: boolean }>(
    `SELECT to_regclass(${client.escapeLiteral(`${s}._prisma_migrations`)}) IS NOT NULL AS present`
  );
  if (!ledger.rows[0]?.present) {
    throw new Error(
      'the database has no _prisma_migrations table — run `npm run db:migrate:deploy` before creating the app role'
    );
  }
  if (await roleExists(client, role)) {
    // No SUPERUSER / BYPASSRLS words here: mentioning either on ALTER ROLE
    // needs a superuser whatever the value (measured), and the guard above
    // has already proven this role is neither. CREATE ROLE has no such rule.
    await client.query(`ALTER ROLE ${r} WITH LOGIN NOCREATEDB NOCREATEROLE PASSWORD ${pw}`);
    logger.info(`  role ${role}: exists — password reset, attributes re-asserted`);
  } else {
    await client.query(
      `CREATE ROLE ${r} WITH LOGIN NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD ${pw}`
    );
    logger.info(`  role ${role}: created (LOGIN NOBYPASSRLS)`);
  }
  await client.query(`GRANT USAGE ON SCHEMA ${s} TO ${r}`);
  await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${s} TO ${r}`);
  // The app never reads or writes the migration ledger (checked to exist above).
  await client.query(`REVOKE ALL ON ${s}."_prisma_migrations" FROM ${r}`);
  await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${s} TO ${r}`);
  // For the tables future migrations create — as the role running them (this one).
  await client.query(
    `ALTER DEFAULT PRIVILEGES IN SCHEMA ${s} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${r}`
  );
  await client.query(
    `ALTER DEFAULT PRIVILEGES IN SCHEMA ${s} GRANT USAGE, SELECT ON SEQUENCES TO ${r}`
  );
  logger.info(
    `  grants on schema ${s}: USAGE, DML on all tables, USAGE/SELECT on sequences, default privileges`
  );
}

async function drop(client: Client, role: string): Promise<void> {
  const r = client.escapeIdentifier(role);
  if (!(await roleExists(client, role))) {
    logger.info(`  role ${role}: absent — nothing to drop`);
    return;
  }
  await refuseIfPrivileged(client, role);
  const s = await currentSchema(client);
  // Revoke explicitly and in this order: default privileges, then the grants
  // they would otherwise keep re-creating, then the role.
  await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${s} REVOKE ALL ON TABLES FROM ${r}`);
  await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${s} REVOKE ALL ON SEQUENCES FROM ${r}`);
  await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA ${s} FROM ${r}`);
  await client.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${s} FROM ${r}`);
  await client.query(`REVOKE ALL ON SCHEMA ${s} FROM ${r}`);
  await client.query(`DROP ROLE ${r}`);
  logger.info(`  role ${role}: grants revoked, role dropped`);
}

async function main(): Promise<void> {
  const action = parseAction(process.argv.slice(2));
  const role = process.env.TENANCY_APP_ROLE ?? DEFAULT_ROLE;
  if (!ROLE_NAME.test(role)) {
    throw new Error(`TENANCY_APP_ROLE "${role}" must match ${ROLE_NAME}`);
  }
  const dsn = ownerDsn();
  if (!dsn) throw new Error('set MIGRATE_DATABASE_URL (or DATABASE_URL) to the owner role’s DSN');
  const password = process.env.TENANCY_APP_ROLE_PASSWORD;
  if (action === 'create' && !password) {
    throw new Error('set TENANCY_APP_ROLE_PASSWORD (never pass a password as an argument)');
  }

  logger.info(`db:tenancy:role --${action} (${role})`);
  const client = new Client({ connectionString: dsn });
  await client.connect();
  try {
    await client.query('BEGIN');
    if (action === 'create') await create(client, role, password!);
    else await drop(client, role);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    await client.end().catch(() => undefined);
  }
  process.exit(0);
}

main().catch((err: unknown) => {
  logger.error(`db:tenancy:role failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
});
