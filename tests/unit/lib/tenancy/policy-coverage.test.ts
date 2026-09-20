/**
 * Coverage guard: every tenant-owned table has its `org_isolation` policy in
 * the migration, and no other table does (§107 t-707).
 *
 * Prisma cannot model policies — `prisma migrate diff` neither lists nor
 * drops them — so nothing else notices a tenant-owned table the migration
 * forgot, or a policy on a table that should not have one. This test parses
 * the migration SQL and compares it with the tenant-owned set the generated
 * client derives (the same roster the chokepoint, the switch and the drift
 * probes read), and fails naming the table.
 *
 * If this test names a table you just added: your model carries `orgId`, so
 * it is tenant-owned and needs a policy. Append
 * `orgIsolationPolicySql('<table>')` (from `lib/tenancy/isolation.ts`) to a
 * NEW migration — never edit a migration that has shipped — and the T-series
 * drift probe for it appears on its own. A policy on a non-tenant table is
 * the opposite mistake: RLS would enforce an `orgId` the table does not have.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { tenantOwnedModels } from '@/lib/tenancy/classification';
import { ORG_ISOLATION_POLICY, orgIsolationPolicySql } from '@/lib/tenancy/isolation';

const MIGRATION = path.join(
  process.cwd(),
  'prisma/migrations/20260920120000_org_isolation_policies/migration.sql'
);

/** A real generated client on an adapter that never connects — the roster needs no query. */
const client = new PrismaClient({
  adapter: {
    provider: 'postgres',
    adapterName: 'never',
    connect: () => Promise.reject(new Error('never connects')),
  },
});

const CREATE_POLICY = /CREATE POLICY "([^"]+)" ON "([^"]+)"/g;

/** Every `(policy, table)` a migration text creates. */
function policiesIn(sql: string): Array<{ policy: string; table: string }> {
  return [...sql.matchAll(CREATE_POLICY)].map((m) => ({ policy: m[1], table: m[2] }));
}

/** The names the guard would report: tables owed a policy, and tables carrying a stray one. */
function coverageGaps(sql: string, roster: ReadonlyMap<string, string>) {
  const tenantTables = new Set(roster.values());
  const covered = new Map<string, number>();
  for (const { policy, table } of policiesIn(sql)) {
    if (policy !== ORG_ISOLATION_POLICY) continue;
    covered.set(table, (covered.get(table) ?? 0) + 1);
  }
  return {
    missing: [...tenantTables].filter((t) => !covered.has(t)).sort(),
    stray: [...covered.keys()].filter((t) => !tenantTables.has(t)).sort(),
    duplicated: [...covered.entries()].filter(([, n]) => n > 1).map(([t]) => t),
  };
}

describe('org_isolation policy coverage', () => {
  const sql = readFileSync(MIGRATION, 'utf8');
  const roster = tenantOwnedModels(client);

  it('finds the roster and the migration', () => {
    expect(roster.size).toBeGreaterThan(40);
    expect(policiesIn(sql).length).toBeGreaterThan(40);
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

  it('has both arms in both clauses of every policy', () => {
    // The header comment mentions CREATE POLICY too; a statement starts with the quoted name.
    const blocks = sql.split(/(?=CREATE POLICY ")/).filter((b) => b.startsWith('CREATE POLICY "'));
    expect(blocks.length).toBe(roster.size);
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
  });
});
