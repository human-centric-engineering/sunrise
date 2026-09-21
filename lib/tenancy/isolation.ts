/**
 * Row isolation — the policy, the switch, and the probes (§107 t-707).
 *
 * Three things the database side of tenancy needs, defined once so the
 * migration that ships the policies, the test that checks their coverage,
 * the `db:tenancy:enable|disable` script and the drift probes cannot drift
 * from each other:
 *
 *   • **The policy.** One `org_isolation` policy per tenant-owned table,
 *     `USING` and `WITH CHECK` both `orgId = NULLIF(current_setting(
 *     'app.current_org', true), '')` with the bypass arm
 *     `current_setting('app.bypass_rls', true) = 'on'` in front. `NULLIF` is
 *     load-bearing: an unset GUC reads as `''`, and `"orgId" = ''` is false
 *     for every row, so a query that forgot the setter sees nothing — the
 *     playbook's proof. The bypass arm is what `runAsSystem` and a data
 *     migration under FORCE use (design doc, Spike register items 7 and 9).
 *     `CREATE POLICY` on a table without `ENABLE ROW LEVEL SECURITY` is inert
 *     (item 4), which is how the policies version with the schema while a
 *     single-tenant install pays nothing.
 *   • **The switch.** `ENABLE` + `FORCE ROW LEVEL SECURITY`, or `DISABLE` +
 *     `NO FORCE` — two independent `pg_class` flags (`relrowsecurity`,
 *     `relforcerowsecurity`); `DISABLE` alone leaves FORCE set. The plan is
 *     computed from the flags as read, so a second run is a no-op that says so.
 *   • **The probes** live beside the other drift primitives —
 *     `tenancyDriftProbes()` in `lib/db/drift-probes.ts` — a T-series derived
 *     from the tenant-owned roster: `policyExists` always,
 *     `rlsEnabled({ requireForced: true })` at `multi`, never a hand-written
 *     row per table. `prisma migrate diff` does not see policies at all, so
 *     the probes are the only thing that notices a dropped one.
 *
 * This module is side-effect-free (no client, no env) so the migration
 * generator, the coverage test and the switch script can all read the policy
 * text without a database. The roster comes from
 * `lib/tenancy/classification.ts` (a model joins by carrying `orgId`; no
 * registration step), so a fork's tenant-owned model gets a policy, a probe
 * and the switch the moment the column lands — and the coverage test names
 * it until the migration carries its policy.
 *
 * @see .context/tenancy/isolation.md
 * @see prisma/migrations/20260920120000_org_isolation_policies/migration.sql
 */

import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';

/**
 * The DSN the owner-side tools connect with: `MIGRATE_DATABASE_URL` when it
 * is set to something, else `DATABASE_URL`. A blank value counts as unset —
 * the templated-but-empty shape a container env file produces — so the
 * fallback here agrees with `prisma.config.ts`'s, and `pg` never sees `''`
 * (which it would read as "libpq defaults": localhost as the current user).
 */
export function ownerDsn(
  env: Record<string, string | undefined> = process.env
): string | undefined {
  return env.MIGRATE_DATABASE_URL || env.DATABASE_URL || undefined;
}

/** The one policy name every tenant-owned table carries. */
export const ORG_ISOLATION_POLICY = 'org_isolation';

/** The GUC the policies read the org from; set per transaction by the chokepoint. */
export const CURRENT_ORG_SETTING = 'app.current_org';

/** The GUC that bypasses the policies; set per transaction under `runAsSystem`. */
export const BYPASS_RLS_SETTING = 'app.bypass_rls';

/** The predicate both policy clauses share. */
export const ORG_ISOLATION_PREDICATE =
  `current_setting('${BYPASS_RLS_SETTING}', true) = 'on'\n` +
  `    OR "orgId" = NULLIF(current_setting('${CURRENT_ORG_SETTING}', true), '')`;

/**
 * The `CREATE POLICY` statement for one table — what the migration carries,
 * verbatim, and what the coverage test expects to find there.
 */
export function orgIsolationPolicySql(table: string): string {
  return (
    `CREATE POLICY "${ORG_ISOLATION_POLICY}" ON "${table}"\n` +
    `  USING (\n    ${ORG_ISOLATION_PREDICATE}\n  )\n` +
    `  WITH CHECK (\n    ${ORG_ISOLATION_PREDICATE}\n  );`
  );
}

/** The two `pg_class` flags the switch reads and sets. */
export interface RlsFlags {
  table: string;
  enabled: boolean;
  forced: boolean;
}

export type TenancySwitch = 'enable' | 'disable';

/** One table's part of a switch plan: the statements to run, or none. */
export interface RlsPlanEntry {
  table: string;
  /** Empty when the table is already in the requested state. */
  statements: string[];
}

/**
 * What `db:tenancy:enable|disable` has to run, from the flags as read. A
 * table already in the requested state gets no statement — that is the
 * idempotence the script reports per table.
 */
export function planRlsSwitch(flags: readonly RlsFlags[], mode: TenancySwitch): RlsPlanEntry[] {
  return flags.map(({ table, enabled, forced }) => {
    const statements: string[] = [];
    if (mode === 'enable') {
      if (!enabled) statements.push(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);
      if (!forced) statements.push(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
    } else {
      if (enabled) statements.push(`ALTER TABLE "${table}" DISABLE ROW LEVEL SECURITY`);
      if (forced) statements.push(`ALTER TABLE "${table}" NO FORCE ROW LEVEL SECURITY`);
    }
    return { table, statements };
  });
}

/**
 * Rows whose `NULL` org is a meaning, not a gap — the backfill must leave
 * them alone. A predicate narrows the backfill to the rows it may touch;
 * `null` skips the table entirely.
 *
 *   • A platform (`admin`-scoped) API key binds no org by design:
 *     `withAdminAuth` refuses one that carries an org, so binding it would
 *     lock every platform key out. The §106 backfill migration made the same
 *     exception; this is that predicate, kept in one place.
 *   • `AiCostLog` is the one tenant-owned relation that is `SetNull`: erasing
 *     an org detaches its spend rather than deleting it (t-705 ruling), and
 *     a detached row is indistinguishable from an interim one. Binding them
 *     would hand an erased org's per-call usage to the install org's export.
 *     They stay `NULL` — visible to `runAsSystem` (platform billing), to no
 *     org — which is what "detached" means.
 */
export const BACKFILL_EXEMPTIONS: Readonly<Record<string, string | null>> = {
  ai_api_key: `NOT ('admin' = ANY("scopes"))`,
  ai_cost_log: null,
};

/**
 * The backfill `enable` runs first: a row still carrying `NULL` — born between
 * the column's migration and the chokepoint stamping it, or written under
 * `runAsSystem` — would be invisible to every org once the policies enforce,
 * so it becomes the install org's, the answer `single` already gives it —
 * except the rows {@link BACKFILL_EXEMPTIONS} names, whose `NULL` is the
 * point. (At `multi` a platform key is to be read by its resolver under the
 * bypass, never through a policy — the entry §107 t-709 adds.)
 */
export function backfillNullOrgSql(table: string): string | null {
  const exemption = BACKFILL_EXEMPTIONS[table];
  if (exemption === null) return null;
  const keep = exemption ? ` AND ${exemption}` : '';
  return `UPDATE "${table}" SET "orgId" = $1 WHERE "orgId" IS NULL${keep}`;
}

/** The slice of a `pg` client the switch needs — one query at a time, in the caller's transaction. */
export interface SqlRunner {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
}

/** What one run of the switch did to one table. */
export interface SwitchEntry {
  table: string;
  before: RlsFlags;
  after: RlsFlags;
  statements: string[];
  /** Rows the backfill bound to the install org (enable only; 0 otherwise). */
  backfilled: number;
}

export interface SwitchReport {
  mode: TenancySwitch;
  entries: SwitchEntry[];
  /** True when every table was already in the requested state. */
  noop: boolean;
}

function isFlagsRow(row: unknown): row is { table: string; enabled: boolean; forced: boolean } {
  return (
    typeof row === 'object' &&
    row !== null &&
    typeof (row as { table?: unknown }).table === 'string' &&
    typeof (row as { enabled?: unknown }).enabled === 'boolean' &&
    typeof (row as { forced?: unknown }).forced === 'boolean'
  );
}

/**
 * Read `relrowsecurity` / `relforcerowsecurity` for the given tables in the
 * current schema, in the order given. A table the catalog does not know is
 * an error — the roster and the database disagree, which is a migration
 * that has not run, not a table to skip.
 */
export async function readRlsFlags(db: SqlRunner, tables: readonly string[]): Promise<RlsFlags[]> {
  const { rows } = await db.query(
    `SELECT c.relname AS table, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = current_schema()
        AND c.relkind IN ('r', 'p')
        AND c.relname = ANY($1)`,
    [tables]
  );
  const byTable = new Map<string, RlsFlags>();
  for (const row of rows) {
    if (!isFlagsRow(row)) throw new Error('pg_class returned a row of an unexpected shape');
    byTable.set(row.table, { table: row.table, enabled: row.enabled, forced: row.forced });
  }
  const missing = tables.filter((t) => !byTable.has(t));
  if (missing.length > 0) {
    throw new Error(
      `Tenant-owned table(s) missing from the database: ${missing.join(', ')} — run the migrations first`
    );
  }
  return tables.map((t) => byTable.get(t)!);
}

/**
 * Refuse to enforce on a table with no `org_isolation` policy: RLS enabled
 * with no policy is default-deny — zero rows for every org, an outage —
 * and a policy can be missing without any migration noticing
 * (`prisma migrate diff` does not see them). Same catalog, one round trip.
 */
async function requirePolicies(db: SqlRunner, tables: readonly string[]): Promise<void> {
  const { rows } = await db.query(
    `SELECT tablename AS table FROM pg_policies
      WHERE schemaname = current_schema() AND policyname = $1 AND tablename = ANY($2)`,
    [ORG_ISOLATION_POLICY, tables]
  );
  const present = new Set(
    rows.map((r) =>
      typeof r === 'object' && r !== null ? (r as { table?: unknown }).table : undefined
    )
  );
  const missing = tables.filter((t) => !present.has(t));
  if (missing.length > 0) {
    throw new Error(
      `No ${ORG_ISOLATION_POLICY} policy on: ${missing.join(', ')} — enabling RLS there would deny every row. ` +
        'Run the migrations (or restore the policy) first; npm run db:drift-check names it.'
    );
  }
}

/**
 * Run the switch inside the caller's transaction: read the flags, backfill
 * `NULL` orgs to the install org (enable only, before anything enforces),
 * apply the plan, read the flags back. Every table reports what happened to
 * it; a table already in the requested state reports no statements.
 */
export async function runTenancySwitch(
  db: SqlRunner,
  tables: readonly string[],
  mode: TenancySwitch,
  installOrgId: string
): Promise<SwitchReport> {
  // Under FORCE a NOBYPASSRLS owner updates nothing and reports success
  // (Spike register item 7); the bypass GUC is what lets a data change through
  // whatever role the migrate DSN turns out to be.
  await db.query(`SELECT set_config('${BYPASS_RLS_SETTING}', 'on', true)`);
  const before = await readRlsFlags(db, tables);
  if (mode === 'enable') await requirePolicies(db, tables);
  const plan = planRlsSwitch(before, mode);
  const backfilled = new Map<string, number>();
  if (mode === 'enable') {
    for (const table of tables) {
      const sql = backfillNullOrgSql(table);
      if (sql === null) continue;
      const { rowCount } = await db.query(sql, [installOrgId]);
      backfilled.set(table, rowCount ?? 0);
    }
  }
  for (const entry of plan) {
    for (const statement of entry.statements) await db.query(statement);
  }
  const after = await readRlsFlags(db, tables);
  const wanted = mode === 'enable';
  const wrong = after.filter((f) => f.enabled !== wanted || f.forced !== wanted);
  if (wrong.length > 0) {
    throw new Error(
      `After ${mode}, ${wrong.map((f) => f.table).join(', ')} did not reach the requested state`
    );
  }
  const entries = plan.map((entry, i) => ({
    table: entry.table,
    before: before[i],
    after: after[i],
    statements: entry.statements,
    backfilled: backfilled.get(entry.table) ?? 0,
  }));
  return { mode, entries, noop: entries.every((e) => e.statements.length === 0) };
}

const SCRAM_ITERATIONS = 4096;

/**
 * The SCRAM-SHA-256 verifier Postgres stores for a password — computed here
 * so the cleartext never crosses the wire or lands in a server log:
 * `CREATE ROLE … PASSWORD '<cleartext>'` is written verbatim by
 * `log_statement = 'ddl'`, the hardened default on most managed Postgres.
 * Postgres accepts a pre-computed verifier in place of the password (what
 * `psql \password` sends); the shape is RFC 7677 with Postgres's framing:
 * `SCRAM-SHA-256$<iterations>:<salt>$<StoredKey>:<ServerKey>`, base64.
 */
export function scramSha256Verifier(password: string, salt = randomBytes(16)): string {
  const salted = pbkdf2Sync(password.normalize('NFKC'), salt, SCRAM_ITERATIONS, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  return (
    `SCRAM-SHA-256$${SCRAM_ITERATIONS}:${salt.toString('base64')}` +
    `$${storedKey.toString('base64')}:${serverKey.toString('base64')}`
  );
}
