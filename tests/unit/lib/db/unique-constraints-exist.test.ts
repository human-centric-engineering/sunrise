/**
 * Every constraint in UNIQUE_CONSTRAINTS exists after the migrations (t-796).
 *
 * Callers recognise a P2002 by the index name Postgres reports. If a migration
 * renames or drops that index, the match silently stops, and a collision the
 * caller handled (an inbound replay, a slug clash) becomes a 500 or the wrong
 * answer. That is the failure `meta.target` had for every caller under the
 * driver adapter. This replays the migrations' index DDL in apply order and
 * checks each named index is still there, unique, on the named columns.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { UNIQUE_CONSTRAINTS } from '@/lib/db/unique-violation';

const MIGRATIONS = path.join(process.cwd(), 'prisma/migrations');

const IDENT = String.raw`(?:"[^"]+"\.)?"([^"]+)"`; // optionally schema-qualified
const unquote = (c: string) => c.trim().replace(/^"|"$/g, '');

interface LiveIndex {
  table: string;
  columns: string[];
}

/**
 * Unique index name → its table and columns, as the migrations leave it.
 * Comments are stripped first: several migrations quote `DROP INDEX` lines
 * they deliberately did not run.
 */
function liveUniqueIndexes(sql: string): Map<string, LiveIndex> {
  const live = new Map<string, LiveIndex>();
  const statements = sql
    .replace(/--[^\n]*/g, '')
    .split(';')
    .map((st) => st.replace(/\s+/g, ' ').trim());
  const createIndex = new RegExp(
    String.raw`^CREATE UNIQUE INDEX (?:IF NOT EXISTS )?"([^"]+)" ON ${IDENT} ?\(([^)]*)\)`,
    'i'
  );
  const addConstraint = new RegExp(
    String.raw`^ALTER TABLE (?:ONLY )?${IDENT} ADD CONSTRAINT "([^"]+)" UNIQUE ?\(([^)]*)\)`,
    'i'
  );
  const dropConstraint = new RegExp(
    String.raw`^ALTER TABLE (?:ONLY )?${IDENT} DROP CONSTRAINT (?:IF EXISTS )?"([^"]+)"`,
    'i'
  );
  const renameIndex = new RegExp(
    String.raw`^ALTER INDEX (?:IF EXISTS )?${IDENT} RENAME TO "([^"]+)"`,
    'i'
  );
  for (const st of statements) {
    let m: RegExpMatchArray | null;
    if ((m = st.match(createIndex))) {
      live.set(m[1], { table: m[2], columns: m[3].split(',').map(unquote) });
    } else if ((m = st.match(addConstraint))) {
      live.set(m[2], { table: m[1], columns: m[3].split(',').map(unquote) });
    } else if ((m = st.match(dropConstraint))) {
      live.delete(m[2]);
    } else if ((m = st.match(renameIndex))) {
      const index = live.get(m[1]);
      live.delete(m[1]);
      if (index) live.set(m[2], index);
    } else if (/^DROP INDEX /i.test(st)) {
      for (const name of st.matchAll(new RegExp(IDENT, 'g'))) live.delete(name[1]);
    } else if (/^DROP TABLE /i.test(st)) {
      const dropped = new Set([...st.matchAll(new RegExp(IDENT, 'g'))].map((t) => t[1]));
      for (const [name, index] of live) if (dropped.has(index.table)) live.delete(name);
    }
  }
  return live;
}

function migrationsSql(): string {
  return readdirSync(MIGRATIONS, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
    .map((name) => readFileSync(path.join(MIGRATIONS, name, 'migration.sql'), 'utf8'))
    .join(';\n');
}

describe('liveUniqueIndexes', () => {
  it('follows creates, renames, every drop form, and ignores comments', () => {
    const live = liveUniqueIndexes(`
      CREATE UNIQUE INDEX "a_key" ON "public"."t" ("orgId", slug);
      CREATE UNIQUE INDEX "b_key" ON "t"("x");
      CREATE UNIQUE INDEX "c_key" ON "t"("y");
      ALTER TABLE "u" ADD CONSTRAINT "d_key" UNIQUE ("z");
      CREATE UNIQUE INDEX "e_key" ON "gone"("w");
      CREATE UNIQUE INDEX "f_key" ON "t"("v");
      -- DROP INDEX "f_key";
      DROP INDEX IF EXISTS "public"."b_key", "c_key";
      ALTER TABLE "u" DROP CONSTRAINT "d_key";
      DROP TABLE "gone";
      ALTER INDEX "a_key" RENAME TO "a2_key";
    `);
    expect([...live.keys()].sort()).toEqual(['a2_key', 'f_key']);
    expect(live.get('a2_key')).toEqual({ table: 't', columns: ['orgId', 'slug'] });
  });
});

describe('UNIQUE_CONSTRAINTS names indexes the migrations create', () => {
  const live = liveUniqueIndexes(migrationsSql());

  it('sees the indexes at all (the parser is not silently matching nothing)', () => {
    expect(live.get('user_email_key')).toEqual({ table: 'user', columns: ['email'] });
    // Dropped by the org-scoped slugs migration; must not survive the replay.
    expect(live.has('ai_agent_slug_key')).toBe(false);
  });

  it.each(Object.entries(UNIQUE_CONSTRAINTS))('%s', (_key, constraint) => {
    expect(live.get(constraint.index)?.columns).toEqual([...constraint.fields]);
  });
});
