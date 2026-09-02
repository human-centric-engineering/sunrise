/**
 * Drift-probe primitives + the app-extension registry.
 *
 * A "drift probe" checks the deployed Postgres for one object the Prisma schema
 * cannot model (a GIN/HNSW index, a partial-unique index, a CHECK constraint, a
 * GENERATED column, a hand-written FK constraint, …). `scripts/db/check-drift.ts`
 * runs Sunrise's own A-series probes; forks register their own here so CI checks
 * them alongside, without editing the platform script.
 *
 * Why this exists: `prisma migrate dev` computes desired state from the schema
 * and emits `DROP` for any deployed object it can't represent. The drop is
 * silent in a schema-only test suite but breaks search / dedupe / referential
 * integrity at runtime. These probes are the post-migration sanity check.
 *
 * Fork usage: see `lib/app/db-drift.ts` (the scaffold you edit) and
 * `CUSTOMIZATION.md` §5 / `.context/database/prisma-unmodelled-objects.md`.
 */

import { prisma } from '@/lib/db/client';

export interface ProbeResult {
  ok: boolean;
  note?: string;
}

export type Probe = () => Promise<ProbeResult>;

export interface DriftObject {
  /** Unique, human-readable label shown in the check output (e.g. "A3 idx_knowledge_embedding"). */
  name: string;
  /** What kind of object this is (e.g. "HNSW index", "FK constraint"). */
  kind: string;
  /** The table the object lives on, for the failure message ("—" for system objects). */
  table: string;
  probe: Probe;
}

/**
 * Existence probe by index name in pg_indexes.
 */
export function indexExists(indexName: string): Probe {
  return async () => {
    const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*)::bigint AS count
      FROM pg_indexes
      WHERE indexname = ${indexName}
    `;
    return { ok: Number(rows[0]?.count ?? 0n) === 1 };
  };
}

/**
 * Existence probe by constraint name in pg_constraint. An optional
 * `predicateContains` substring asserts the constraint definition text — use it
 * to confirm a tightened CHECK predicate (or, for a hand-written FK, the
 * referenced table / `ON DELETE` action) actually landed.
 */
export function constraintExists(constraintName: string, predicateContains?: string): Probe {
  return async () => {
    const rows = await prisma.$queryRaw<Array<{ def: string | null }>>`
      SELECT pg_get_constraintdef(oid) AS def
      FROM pg_constraint
      WHERE conname = ${constraintName}
    `;
    const def = rows[0]?.def;
    if (!def) return { ok: false };
    if (predicateContains && !def.includes(predicateContains)) {
      return {
        ok: false,
        note: `definition missing "${predicateContains}" — saw: ${def}`,
      };
    }
    return { ok: true };
  };
}

/**
 * Existence probe by column name in information_schema.columns.
 *
 * For a column that must be `GENERATED ALWAYS`, use `generatedColumnExists`
 * instead — this probe only asks whether a column of that name is present, and
 * a plain column of the same name satisfies it while never being populated.
 */
export function columnExists(tableName: string, columnName: string): Probe {
  return async () => {
    const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*)::bigint AS count
      FROM information_schema.columns
      WHERE table_name = ${tableName}
        AND column_name = ${columnName}
    `;
    return { ok: Number(rows[0]?.count ?? 0n) === 1 };
  };
}

/**
 * Existence probe for a column that MUST be `GENERATED ALWAYS AS (...) STORED`.
 *
 * Prefer this over `columnExists` for generated columns. A migration that
 * dropped the column and recreated it as a plain column of the same type leaves
 * a row in `information_schema.columns`, so `columnExists` passes and the drift
 * check reports green — while the column is never populated again.
 *
 * That failure is worse than a dropped index. A missing index degrades a query
 * to a sequential scan: slow, but correct. A generated column that stopped
 * being generated means every row written after the migration holds NULL, so
 * the feature reading it silently returns nothing for new data while continuing
 * to return correct results for old data. It reads as "the system doesn't know
 * about recent content" — easy to misdiagnose as an ingestion bug.
 *
 * `information_schema.columns.is_generated` is standard SQL and returns
 * `'ALWAYS'` or `'NEVER'`, so there is no version sensitivity here.
 */
export function generatedColumnExists(tableName: string, columnName: string): Probe {
  return async () => {
    const rows = await prisma.$queryRaw<Array<{ is_generated: string | null }>>`
      SELECT is_generated
      FROM information_schema.columns
      WHERE table_name = ${tableName}
        AND column_name = ${columnName}
    `;
    const isGenerated = rows[0]?.is_generated;
    if (!isGenerated) return { ok: false, note: 'column missing entirely' };
    if (isGenerated !== 'ALWAYS') {
      return {
        ok: false,
        note: `column exists but is not GENERATED — saw is_generated="${isGenerated}". It will never be populated.`,
      };
    }
    return { ok: true };
  };
}

/**
 * Probe that Row-Level Security is ENABLED — and, by default, FORCED — on a
 * table (`pg_class.relrowsecurity` / `relforcerowsecurity`).
 *
 * Why the FORCE default: a table's owner bypasses its own RLS policies unless
 * `ALTER TABLE … FORCE ROW LEVEL SECURITY` has been applied, and that bypass
 * fails **open** — every query works, no error is ever raised, and the only
 * symptom is rows crossing a boundary they shouldn't. Like the
 * `generatedColumnExists` / `columnExists` split above, the weaker state is the
 * one that reads as healthy, so the probe asserts the stronger one. Pass
 * `{ requireForced: false }` only for a table you deliberately left unforced
 * (e.g. the app role can never own it), and say why at the registration site.
 *
 * Lookup is scoped to `current_schema()` — unlike the count-based probes
 * above, this one reads `rows[0]`, and a same-named table in a backup or
 * shadow schema could otherwise answer for the live one (a silent GREEN over
 * an unprotected table, the worst failure mode a drift check can have).
 * Partitioned parents (`relkind 'p'`) count: they support RLS fully, and
 * excluding them would misreport a partitioned tenant table as missing. RLS
 * being enabled says nothing about which policies exist; pair with
 * `policyExists`.
 */
export function rlsEnabled(tableName: string, opts?: { requireForced?: boolean }): Probe {
  const requireForced = opts?.requireForced ?? true;
  return async () => {
    const rows = await prisma.$queryRaw<Array<{ enabled: boolean | null; forced: boolean | null }>>`
      SELECT c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced
      FROM pg_class c
      WHERE c.relname = ${tableName}
        AND c.relkind IN ('r', 'p')
        AND c.relnamespace = current_schema()::regnamespace
    `;
    const row = rows[0];
    if (!row) return { ok: false, note: 'table missing entirely' };
    if (!row.enabled) {
      return {
        ok: false,
        note: 'RLS is not enabled — every role reads every row. Run ALTER TABLE … ENABLE ROW LEVEL SECURITY (see db:tenancy:enable once it ships).',
      };
    }
    if (requireForced && !row.forced) {
      return {
        ok: false,
        note: 'RLS is enabled but not FORCED — the table owner bypasses every policy, silently. Run ALTER TABLE … FORCE ROW LEVEL SECURITY, or register with { requireForced: false } and record why.',
      };
    }
    return { ok: true };
  };
}

/**
 * Existence probe for one named RLS policy on one table (`pg_policies`).
 *
 * The companion to `rlsEnabled`, and the probe every RLS table needs: policies
 * are Prisma-unmodelled objects, so `prisma migrate dev` emits `DROP POLICY`
 * for them exactly as it does for the HNSW indexes this registry was built
 * around. A policy can also exist while RLS is disabled (`CREATE POLICY` on an
 * un-enabled table is inert), so register both probes per protected table.
 * Scoped to `current_schema()` so a same-named policy in a backup schema can
 * neither answer for a dropped live policy nor inflate the count past 1.
 */
export function policyExists(tableName: string, policyName: string): Probe {
  return async () => {
    const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*)::bigint AS count
      FROM pg_policies
      WHERE schemaname = current_schema()
        AND tablename = ${tableName}
        AND policyname = ${policyName}
    `;
    return { ok: Number(rows[0]?.count ?? 0n) === 1 };
  };
}

/**
 * App-registered drift probes. Populated by `registerAppDriftProbe()` calls
 * from `lib/app/db-drift.ts`; read by `scripts/db/check-drift.ts`.
 */
const appDriftProbes: DriftObject[] = [];

/**
 * Register one fork-owned unmodelled object so CI probes it alongside the
 * A-series. Throws on a duplicate `name` within the app set so a copy-paste
 * slip fails loudly rather than silently shadowing an earlier probe.
 */
export function registerAppDriftProbe(obj: DriftObject): void {
  if (appDriftProbes.some((existing) => existing.name === obj.name)) {
    throw new Error(
      `Duplicate app drift probe name: "${obj.name}". Each registered probe needs a unique name.`
    );
  }
  appDriftProbes.push(obj);
}

/**
 * The app-registered probes, in registration order. Returns a copy so callers
 * can't mutate the registry.
 */
export function getAppDriftProbes(): DriftObject[] {
  return [...appDriftProbes];
}

/**
 * Clear the app registry. For tests and for the dev-server hot-reload case
 * where `registerAppDriftProbes()` re-runs on every edit.
 */
export function resetAppDriftProbes(): void {
  appDriftProbes.length = 0;
}

/**
 * Concatenate the platform (A-series) probes with the app-registered ones,
 * throwing if an app probe reuses a platform probe `name` — a fork must not be
 * able to shadow a Sunrise probe and silently disable it.
 */
export function mergeDriftProbes(
  platform: readonly DriftObject[],
  app: readonly DriftObject[]
): DriftObject[] {
  const platformNames = new Set(platform.map((p) => p.name));
  for (const probe of app) {
    if (platformNames.has(probe.name)) {
      throw new Error(
        `App drift probe "${probe.name}" collides with a platform (A-series) probe name; choose a distinct name.`
      );
    }
  }
  return [...platform, ...app];
}
