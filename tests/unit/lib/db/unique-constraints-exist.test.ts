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

/** Unique index name → its column list, as the migrations leave it. */
function liveUniqueIndexes(): Map<string, string[]> {
  const live = new Map<string, string[]>();
  const sql = readdirSync(MIGRATIONS, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
    .map((name) => readFileSync(path.join(MIGRATIONS, name, 'migration.sql'), 'utf8'))
    .join('\n');
  const statement =
    /CREATE\s+UNIQUE\s+INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?"([^"]+)"\s+ON\s+"[^"]+"\s*\(([^)]*)\)|DROP\s+INDEX\s+(?:IF\s+EXISTS\s+)?(?:"[^"]+"\.)?"([^"]+)"|ALTER\s+INDEX\s+(?:IF\s+EXISTS\s+)?(?:"[^"]+"\.)?"([^"]+)"\s+RENAME\s+TO\s+"([^"]+)"/gi;
  for (const m of sql.matchAll(statement)) {
    if (m[1]) {
      live.set(
        m[1],
        m[2].split(',').map((c) => c.trim().replace(/^"|"$/g, ''))
      );
    } else if (m[3]) {
      live.delete(m[3]);
    } else if (m[4] && m[5]) {
      const cols = live.get(m[4]);
      live.delete(m[4]);
      if (cols) live.set(m[5], cols);
    }
  }
  return live;
}

describe('UNIQUE_CONSTRAINTS names indexes the migrations create', () => {
  const live = liveUniqueIndexes();

  it('sees the indexes at all (the parser is not silently matching nothing)', () => {
    expect(live.get('user_email_key')).toEqual(['email']);
    // Dropped by the org-scoped slugs migration; must not survive the replay.
    expect(live.has('ai_agent_slug_key')).toBe(false);
  });

  it.each(Object.entries(UNIQUE_CONSTRAINTS))('%s', (_key, constraint) => {
    expect(live.get(constraint.index)).toEqual([...constraint.fields]);
  });
});
