/**
 * Coverage guard: every tenant-owned table has its `org_isolation` policy in
 * the migration, and no other table does (§107 t-707).
 *
 * Prisma cannot model policies — `prisma migrate diff` neither lists nor
 * drops them — so nothing else notices a tenant-owned table the migration
 * forgot, or a policy on a table that should not have one. This test parses
 * every migration's SQL (creates minus drops, in apply order) and compares it
 * with the tenant-owned set the generated client derives (the same roster the
 * chokepoint, the switch and the drift probes read), and fails naming the
 * table.
 *
 * If this test names a table you just added: your model carries `orgId`, so
 * it is tenant-owned and needs a policy. Append
 * `orgIsolationPolicySql('<table>')` (from `lib/tenancy/isolation.ts`) to a
 * NEW migration — never edit a migration that has shipped — and the T-series
 * drift probe for it appears on its own. A policy on a non-tenant table is
 * the opposite mistake: RLS would enforce an `orgId` the table does not have.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { tenantOwnedModels } from '@/lib/tenancy/classification';
import { ORG_ISOLATION_POLICY, orgIsolationPolicySql } from '@/lib/tenancy/isolation';

const MIGRATIONS = path.join(process.cwd(), 'prisma/migrations');

/**
 * Every migration's SQL, in the order Prisma applies them, joined — so a
 * fork's later migration adding (or dropping) a policy counts the same as
 * the one that shipped the set.
 */
function allMigrationSql(): string {
  return readdirSync(MIGRATIONS, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
    .map((name) => readFileSync(path.join(MIGRATIONS, name, 'migration.sql'), 'utf8'))
    .join('\n');
}

/** A real generated client on an adapter that never connects — the roster needs no query. */
const client = new PrismaClient({
  adapter: {
    provider: 'postgres',
    adapterName: 'never',
    connect: () => Promise.reject(new Error('never connects')),
  },
});

// Identifiers quoted or bare — a hand-written statement is as real as a generated one.
const IDENT = '"?([A-Za-z_][A-Za-z0-9_]*)"?';
const CREATE_POLICY = new RegExp(`CREATE POLICY ${IDENT} ON ${IDENT}`, 'g');
const DROP_POLICY = new RegExp(`DROP POLICY (?:IF EXISTS )?${IDENT} ON ${IDENT}`, 'g');
const DROP_TABLE = new RegExp(`DROP TABLE (?:IF EXISTS )?${IDENT}`, 'g');

/**
 * Every `(policy, table)` a migration text creates, every one it drops, and
 * every table it drops — a dropped table takes its policies with it.
 */
function policiesIn(sql: string): {
  created: Array<{ policy: string; table: string }>;
  dropped: Array<{ policy: string; table: string }>;
  droppedTables: string[];
} {
  const pair = (m: RegExpMatchArray) => ({ policy: m[1], table: m[2] });
  return {
    created: [...sql.matchAll(CREATE_POLICY)].map(pair),
    dropped: [...sql.matchAll(DROP_POLICY)].map(pair),
    droppedTables: [...sql.matchAll(DROP_TABLE)].map((m) => m[1]),
  };
}

/** The names the guard would report: tables owed a policy, and tables carrying a stray one. */
function coverageGaps(sql: string, roster: ReadonlyMap<string, string>) {
  const tenantTables = new Set(roster.values());
  const covered = new Map<string, number>();
  const { created, dropped, droppedTables } = policiesIn(sql);
  for (const { policy, table } of created) {
    if (policy !== ORG_ISOLATION_POLICY) continue;
    covered.set(table, (covered.get(table) ?? 0) + 1);
  }
  for (const { policy, table } of dropped) {
    if (policy !== ORG_ISOLATION_POLICY) continue;
    const n = (covered.get(table) ?? 0) - 1;
    if (n <= 0) covered.delete(table);
    else covered.set(table, n);
  }
  for (const table of droppedTables) covered.delete(table);
  return {
    missing: [...tenantTables].filter((t) => !covered.has(t)).sort(),
    stray: [...covered.keys()].filter((t) => !tenantTables.has(t)).sort(),
    duplicated: [...covered.entries()].filter(([, n]) => n > 1).map(([t]) => t),
  };
}

describe('org_isolation policy coverage', () => {
  const sql = allMigrationSql();
  const roster = tenantOwnedModels(client);

  it('finds the roster and the migrations', () => {
    expect(roster.size).toBeGreaterThan(40);
    expect(policiesIn(sql).created.length).toBeGreaterThan(40);
  });

  it('gives every tenant-owned table exactly one org_isolation policy, and no other table any', () => {
    const gaps = coverageGaps(sql, roster);
    expect(
      gaps.missing,
      'tenant-owned tables with no org_isolation policy in the migration — add orgIsolationPolicySql(table) to a new migration'
    ).toEqual([]);
    expect(
      gaps.stray,
      'tables with an org_isolation policy that are not tenant-owned — RLS would enforce an orgId they do not have'
    ).toEqual([]);
    expect(gaps.duplicated).toEqual([]);
  });

  it('carries each policy verbatim as lib/tenancy/isolation.ts defines it', () => {
    // The text is what the chokepoint's GUCs and the NULLIF rule are proven
    // against; a hand-edited clause here would diverge from that proof.
    for (const table of roster.values()) {
      expect(sql, `policy text for ${table}`).toContain(orgIsolationPolicySql(table));
    }
  });

  it('has both arms in both clauses of every org_isolation policy', () => {
    // Only this policy's statements: a fork's or §115's own policies are
    // theirs to shape. Coverage (exactly one per table) is the case above.
    const blocks = sql
      .split(/(?=CREATE POLICY )/)
      .filter((b) => b.startsWith(`CREATE POLICY "${ORG_ISOLATION_POLICY}"`));
    expect(blocks.length).toBeGreaterThanOrEqual(roster.size);
    for (const block of blocks) {
      const [using, withCheck] = block.split('WITH CHECK');
      expect(using).toContain("current_setting('app.bypass_rls', true) = 'on'");
      expect(using).toContain(`"orgId" = NULLIF(current_setting('app.current_org', true), '')`);
      expect(withCheck).toContain("current_setting('app.bypass_rls', true) = 'on'");
      expect(withCheck).toContain(`"orgId" = NULLIF(current_setting('app.current_org', true), '')`);
    }
  });

  describe('the rule, shown to fire', () => {
    it('names a tenant-owned table whose policy was removed', () => {
      const without = sql.replace(orgIsolationPolicySql('ai_cost_log'), '');
      expect(coverageGaps(without, roster).missing).toEqual(['ai_cost_log']);
    });

    it('names a tenant-owned table the migration never covered', () => {
      const grown = new Map([...roster, ['AppWidget', 'app_widget']]);
      expect(coverageGaps(sql, grown).missing).toEqual(['app_widget']);
    });

    it('names a policy on a table that is not tenant-owned', () => {
      const stray = sql + '\n' + orgIsolationPolicySql('feature_flag');
      expect(coverageGaps(stray, roster).stray).toEqual(['feature_flag']);
    });

    it("counts a fork's later migration, and a DROP POLICY, the same as the shipped set", () => {
      const grown = new Map([...roster, ['AppWidget', 'app_widget']]);
      const later = sql + '\n' + orgIsolationPolicySql('app_widget');
      expect(coverageGaps(later, grown).missing).toEqual([]);
      const droppedLater = sql + '\nDROP POLICY "org_isolation" ON "ai_cost_log";';
      expect(coverageGaps(droppedLater, roster).missing).toEqual(['ai_cost_log']);
      // Bare identifiers count too — a hand-written statement is as real as a generated one.
      const droppedBare = sql + '\nDROP POLICY org_isolation ON ai_cost_log;';
      expect(coverageGaps(droppedBare, roster).missing).toEqual(['ai_cost_log']);
    });

    it('lets a dropped table take its policy with it rather than reporting it stray forever', () => {
      const shrunk = new Map([...roster].filter(([m]) => m !== 'AiCostLog'));
      expect(coverageGaps(sql, shrunk).stray).toEqual(['ai_cost_log']);
      const dropped = sql + '\nDROP TABLE "ai_cost_log";';
      expect(coverageGaps(dropped, shrunk).stray).toEqual([]);
    });
  });
});
