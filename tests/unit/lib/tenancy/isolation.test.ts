/**
 * Tests: lib/tenancy/isolation.ts — the policy text, the switch plan and the
 * switch run (§107 t-707).
 *
 * The plan is pure and is tested over every flag state in both directions;
 * the run is driven with a recording SQL runner so the order of what it
 * issues — bypass GUC first, backfill before any ALTER on enable and never on
 * disable, the flags read back and checked — is asserted, not assumed. The
 * real database run is `npm run db:tenancy:enable` against the dev DB (the
 * task's done-when), not something a unit test can vouch for.
 */
import { describe, it, expect } from 'vitest';
import {
  BYPASS_RLS_SETTING,
  CURRENT_ORG_SETTING,
  ORG_ISOLATION_POLICY,
  backfillNullOrgSql,
  orgIsolationPolicySql,
  ownerDsn,
  planRlsSwitch,
  readRlsFlags,
  runTenancySwitch,
  type RlsFlags,
  type SqlRunner,
} from '@/lib/tenancy/isolation';

describe('orgIsolationPolicySql', () => {
  it('names the policy, the table, both GUCs and the NULLIF form in both clauses', () => {
    const sql = orgIsolationPolicySql('ai_agent');
    expect(sql.startsWith(`CREATE POLICY "${ORG_ISOLATION_POLICY}" ON "ai_agent"`)).toBe(true);
    const using = sql.slice(sql.indexOf('USING'), sql.indexOf('WITH CHECK'));
    const withCheck = sql.slice(sql.indexOf('WITH CHECK'));
    for (const clause of [using, withCheck]) {
      expect(clause).toContain(`current_setting('${BYPASS_RLS_SETTING}', true) = 'on'`);
      expect(clause).toContain(
        `"orgId" = NULLIF(current_setting('${CURRENT_ORG_SETTING}', true), '')`
      );
    }
    expect(sql.endsWith(';')).toBe(true);
  });
});

describe('ownerDsn', () => {
  it('prefers MIGRATE_DATABASE_URL, falls back to DATABASE_URL, and treats blank as unset', () => {
    expect(ownerDsn({ MIGRATE_DATABASE_URL: 'pg://owner', DATABASE_URL: 'pg://app' })).toBe(
      'pg://owner'
    );
    expect(ownerDsn({ DATABASE_URL: 'pg://app' })).toBe('pg://app');
    // The templated-but-empty shape must not reach pg as '' (libpq defaults).
    expect(ownerDsn({ MIGRATE_DATABASE_URL: '', DATABASE_URL: 'pg://app' })).toBe('pg://app');
    expect(ownerDsn({ MIGRATE_DATABASE_URL: '', DATABASE_URL: '' })).toBeUndefined();
    expect(ownerDsn({})).toBeUndefined();
  });
});

describe('planRlsSwitch', () => {
  const states: RlsFlags[] = [
    { table: 'off', enabled: false, forced: false },
    { table: 'on_unforced', enabled: true, forced: false },
    { table: 'on_forced', enabled: true, forced: true },
    { table: 'forced_only', enabled: false, forced: true },
  ];

  it('enable: issues exactly the statements each table is missing', () => {
    expect(planRlsSwitch(states, 'enable')).toEqual([
      {
        table: 'off',
        statements: [
          'ALTER TABLE "off" ENABLE ROW LEVEL SECURITY',
          'ALTER TABLE "off" FORCE ROW LEVEL SECURITY',
        ],
      },
      { table: 'on_unforced', statements: ['ALTER TABLE "on_unforced" FORCE ROW LEVEL SECURITY'] },
      { table: 'on_forced', statements: [] },
      { table: 'forced_only', statements: ['ALTER TABLE "forced_only" ENABLE ROW LEVEL SECURITY'] },
    ]);
  });

  it('disable: issues DISABLE and NO FORCE independently — DISABLE alone leaves FORCE set', () => {
    expect(planRlsSwitch(states, 'disable')).toEqual([
      { table: 'off', statements: [] },
      {
        table: 'on_unforced',
        statements: ['ALTER TABLE "on_unforced" DISABLE ROW LEVEL SECURITY'],
      },
      {
        table: 'on_forced',
        statements: [
          'ALTER TABLE "on_forced" DISABLE ROW LEVEL SECURITY',
          'ALTER TABLE "on_forced" NO FORCE ROW LEVEL SECURITY',
        ],
      },
      {
        table: 'forced_only',
        statements: ['ALTER TABLE "forced_only" NO FORCE ROW LEVEL SECURITY'],
      },
    ]);
  });
});

describe('backfillNullOrgSql', () => {
  it('binds the org as a parameter and touches only NULL rows', () => {
    expect(backfillNullOrgSql('ai_agent')).toBe(
      'UPDATE "ai_agent" SET "orgId" = $1 WHERE "orgId" IS NULL'
    );
  });

  it('leaves a platform (admin-scoped) API key unbound — its NULL org is the point', () => {
    // The §106 backfill migration's own exemption; binding one would make
    // withAdminAuth refuse every platform key.
    expect(backfillNullOrgSql('ai_api_key')).toBe(
      `UPDATE "ai_api_key" SET "orgId" = $1 WHERE "orgId" IS NULL AND NOT ('admin' = ANY("scopes"))`
    );
  });
});

/** A runner that records every statement and answers pg_class from a mutable flag table. */
function fakeRunner(initial: RlsFlags[], missingPolicies: ReadonlySet<string> = new Set()) {
  const flags = new Map(initial.map((f) => [f.table, { ...f }]));
  const log: Array<{ sql: string; params?: unknown[] }> = [];
  const runner: SqlRunner = {
    async query(sql, params) {
      log.push({ sql, params });
      if (sql.includes('FROM pg_policies')) {
        const wanted = (params?.[1] as string[]) ?? [];
        return {
          rows: wanted.filter((t) => !missingPolicies.has(t)).map((t) => ({ table: t })),
          rowCount: null,
        };
      }
      if (sql.includes('FROM pg_class')) {
        const wanted = (params?.[0] as string[]) ?? [];
        return {
          rows: wanted
            .filter((t) => flags.has(t))
            .map((t) => ({
              table: t,
              enabled: flags.get(t)!.enabled,
              forced: flags.get(t)!.forced,
            })),
          rowCount: wanted.length,
        };
      }
      const alter =
        /^ALTER TABLE "([^"]+)" (ENABLE|DISABLE|FORCE|NO FORCE) ROW LEVEL SECURITY$/.exec(sql);
      if (alter) {
        const f = flags.get(alter[1])!;
        if (alter[2] === 'ENABLE') f.enabled = true;
        if (alter[2] === 'DISABLE') f.enabled = false;
        if (alter[2] === 'FORCE') f.forced = true;
        if (alter[2] === 'NO FORCE') f.forced = false;
        return { rows: [], rowCount: null };
      }
      if (sql.startsWith('UPDATE')) return { rows: [], rowCount: sql.includes('"b"') ? 3 : 0 };
      return { rows: [], rowCount: null };
    },
  };
  return { runner, log, flags };
}

describe('readRlsFlags', () => {
  it('returns the flags in the order asked', async () => {
    const { runner } = fakeRunner([
      { table: 'a', enabled: true, forced: true },
      { table: 'b', enabled: false, forced: false },
    ]);
    expect(await readRlsFlags(runner, ['b', 'a'])).toEqual([
      { table: 'b', enabled: false, forced: false },
      { table: 'a', enabled: true, forced: true },
    ]);
  });

  it('throws naming a table the database does not have — a migration that has not run', async () => {
    const { runner } = fakeRunner([{ table: 'a', enabled: false, forced: false }]);
    await expect(readRlsFlags(runner, ['a', 'ghost'])).rejects.toThrow(/ghost.*run the migrations/);
  });
});

describe('runTenancySwitch', () => {
  const dormant = (): RlsFlags[] => [
    { table: 'a', enabled: false, forced: false },
    { table: 'b', enabled: false, forced: false },
  ];

  it('enable: sets the bypass GUC, backfills every table, then flips both flags, and reads back', async () => {
    const { runner, log, flags } = fakeRunner(dormant());
    const report = await runTenancySwitch(runner, ['a', 'b'], 'enable', 'install');

    expect(log[0].sql).toBe(`SELECT set_config('${BYPASS_RLS_SETTING}', 'on', true)`);
    const updates = log.filter((l) => l.sql.startsWith('UPDATE'));
    const alters = log.filter((l) => l.sql.startsWith('ALTER'));
    expect(updates.map((u) => u.params)).toEqual([['install'], ['install']]);
    // Every backfill precedes every ALTER: a NULL row must be an org's before anything enforces.
    expect(log.indexOf(updates.at(-1)!)).toBeLessThan(log.indexOf(alters[0]));
    expect(alters.map((a) => a.sql)).toEqual([
      'ALTER TABLE "a" ENABLE ROW LEVEL SECURITY',
      'ALTER TABLE "a" FORCE ROW LEVEL SECURITY',
      'ALTER TABLE "b" ENABLE ROW LEVEL SECURITY',
      'ALTER TABLE "b" FORCE ROW LEVEL SECURITY',
    ]);
    expect(flags.get('a')).toEqual({ table: 'a', enabled: true, forced: true });
    expect(report.noop).toBe(false);
    expect(report.entries.map((e) => e.backfilled)).toEqual([0, 3]);
    expect(report.entries[0].after).toEqual({ table: 'a', enabled: true, forced: true });
  });

  it('is idempotent: a second enable issues no ALTER and reports no change', async () => {
    const { runner, log } = fakeRunner([
      { table: 'a', enabled: true, forced: true },
      { table: 'b', enabled: true, forced: true },
    ]);
    const report = await runTenancySwitch(runner, ['a', 'b'], 'enable', 'install');
    expect(log.some((l) => l.sql.startsWith('ALTER'))).toBe(false);
    expect(report.noop).toBe(true);
    expect(report.entries.every((e) => e.statements.length === 0)).toBe(true);
  });

  it('disable: never backfills, and clears both flags', async () => {
    const { runner, log, flags } = fakeRunner([
      { table: 'a', enabled: true, forced: true },
      { table: 'b', enabled: true, forced: true },
    ]);
    const report = await runTenancySwitch(runner, ['a', 'b'], 'disable', 'install');
    expect(log.some((l) => l.sql.startsWith('UPDATE'))).toBe(false);
    expect(flags.get('b')).toEqual({ table: 'b', enabled: false, forced: false });
    expect(report.entries.map((e) => e.backfilled)).toEqual([0, 0]);
  });

  it('refuses to enable a table with no org_isolation policy — that would deny every row', async () => {
    const { runner, log } = fakeRunner(dormant(), new Set(['b']));
    await expect(runTenancySwitch(runner, ['a', 'b'], 'enable', 'install')).rejects.toThrow(
      /No org_isolation policy on: b/
    );
    expect(log.some((l) => l.sql.startsWith('ALTER') || l.sql.startsWith('UPDATE'))).toBe(false);
  });

  it('does not need the policies to disable', async () => {
    const { runner, flags } = fakeRunner(
      [
        { table: 'a', enabled: true, forced: true },
        { table: 'b', enabled: true, forced: true },
      ],
      new Set(['a', 'b'])
    );
    await runTenancySwitch(runner, ['a', 'b'], 'disable', 'install');
    expect(flags.get('a')).toEqual({ table: 'a', enabled: false, forced: false });
  });

  it('throws when the flags read back do not show the requested state', async () => {
    const { runner } = fakeRunner(dormant());
    // A runner whose ALTERs are silently ineffective (a role that cannot alter, say).
    const inert: SqlRunner = {
      query: (sql, params) =>
        sql.startsWith('ALTER')
          ? Promise.resolve({ rows: [], rowCount: null })
          : runner.query(sql, params),
    };
    await expect(runTenancySwitch(inert, ['a', 'b'], 'enable', 'install')).rejects.toThrow(
      /After enable, a, b did not reach the requested state/
    );
  });
});
