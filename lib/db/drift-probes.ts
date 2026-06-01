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
 * Existence probe by column name in information_schema.columns. Used for
 * GENERATED columns (e.g. the tsvector column on ai_knowledge_chunk).
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
