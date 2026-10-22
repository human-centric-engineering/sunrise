/**
 * Whole-tree guard: raw SQL that reads an enforced personal table is a
 * reasoned decision (§115 t-801).
 *
 * The owner layer (`lib/db/owner-extension.ts`) checks Prisma model reads. A
 * raw query reaches it as `model === undefined`, with no `where` it can
 * analyse, so a `$queryRaw` over `ai_user_memory` would read every member's
 * memories for a narrowed caller and nothing would refuse it. RLS does not
 * help here: the policies draw the wall between orgs, not inside one.
 *
 * So every file in `lib/**` or `app/**` that issues raw SQL (a raw member call
 * or a `Prisma.sql` / `Prisma.raw` fragment) and names an enforced model's
 * table must have a row below saying why it is safe: it is keyed on the
 * subject, it is an aggregate that returns no row, or it runs where no person
 * is narrowed. Exact in both directions, like `db-raw-sql-allowlist.test.ts`:
 * an unlisted file fails, and so does a row whose file no longer reads the
 * table. The tables are derived from the classification's `enforced` set, so
 * enforcing a new model (t-802, t-803) brings its raw readers in here
 * automatically.
 *
 * **Never add a row to make this pass without reading the query.** A row is
 * the claim that the query cannot return another member's rows to a narrowed
 * caller.
 *
 * Registered in ALWAYS_RUN_TESTS (`scripts/ci/scoped-tests.ts`): a raw read in
 * a far-off module never reaches this file through the import graph.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { OWNER_CLASSIFICATION, enforcedModels } from '@/lib/db/owner-classification';

/** A raw member call (as the allowlist matches it) or a raw fragment builder. */
const RAW_SQL = /[\w$)\]]\.\$(queryRaw|executeRaw)(Unsafe|Typed)?\s*[(`<]|\bPrisma\.(sql|raw)\b/;

/**
 * Every file that reads an enforced table in raw SQL, the table, and why it
 * cannot hand a narrowed caller another member's rows. Sorted by file.
 */
const MANIFEST: ReadonlyArray<{ file: string; table: string; why: string }> = [
  {
    file: 'lib/orchestration/chat/conversation-semantic-search.ts',
    table: 'ai_conversation',
    why: "Predicated on the three arms of conversationVisibilityWhere, keyed on the caller's id: own, ownerless only when the policy admits it, and live shares. Pinned against the fragment in conversation-access.test.ts.",
  },
  {
    file: 'lib/orchestration/chat/conversation-semantic-search.ts',
    table: 'ai_message',
    why: 'Joined to ai_conversation and returned only through the same visibility predicate on the conversation, so a message comes back only when its conversation may.',
  },
  {
    file: 'lib/orchestration/chat/message-embedder.ts',
    table: 'ai_message',
    why: 'The backfill runs from the maintenance tick, where no person is narrowed, and returns nothing to a caller; the insert reads only the orgId of the message it is embedding.',
  },
  {
    file: 'lib/orchestration/engine/run-row-lock.ts',
    table: 'ai_workflow_execution',
    why: "Takes one run's row lock by id before an action reads it (§122 t-901). Returns nothing; the read that follows goes through Prisma, so the owner layer still checks the row, and every caller has already been admitted to the run (approve/reject/retry routes, the scheduler, the review route).",
  },
  {
    file: 'lib/privacy/delivery-payloads.ts',
    table: 'ai_conversation',
    why: 'Keyed on the data subject (c."userId" = the subject) to find deliveries naming their conversations; it returns delivery rows, never a conversation, and runs for the subject\'s own export or under the export\'s declared crossing.',
  },
  {
    file: 'lib/privacy/delivery-payloads.ts',
    table: 'ai_workflow_execution',
    why: 'Keyed on the data subject (e."userId" = the subject) to find deliveries naming their runs; it returns delivery rows, never an execution, and runs for the subject\'s own export or under the export\'s declared crossing.',
  },
  {
    file: 'lib/privacy/run-recipients.ts',
    table: 'ai_workflow_execution',
    why: "Erasure (t-804): reads other people's runs whose text names the subject, only to redact the subject from them inside the erasure transaction, which runs as the audited system scope. Nothing it reads is returned to a caller; the result is a count.",
  },
];

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const SCHEMA_DIR = path.join(REPO_ROOT, 'prisma', 'schema');

/** The `@@map` table of each enforced model, read from the schema files. */
function enforcedTables(): string[] {
  const text = readdirSync(SCHEMA_DIR)
    .filter((f) => f.endsWith('.prisma'))
    .map((f) => readFileSync(path.join(SCHEMA_DIR, f), 'utf8'))
    .join('\n');
  // Core's enforced models only. A fork's, added through its seam, are its
  // own raw-SQL concern: this manifest is core's, and a fork cannot extend it.
  return enforcedModels()
    .filter((model) => Object.hasOwn(OWNER_CLASSIFICATION, model))
    .map((model) => {
      const block = new RegExp(`^model\\s+${model}\\s*\\{([\\s\\S]*?)^\\}`, 'm').exec(text)?.[1];
      if (!block) throw new Error(`enforced model ${model} is not in prisma/schema`);
      return /@@map\("([^"]+)"\)/.exec(block)?.[1] ?? model;
    });
}

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(path.join(REPO_ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...listSourceFiles(rel));
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(rel);
  }
  return out;
}

/** Does `source` issue raw SQL and name `table` as an identifier? */
function readsTableRaw(source: string, table: string): boolean {
  return RAW_SQL.test(source) && new RegExp(`\\b${table}\\b`).test(source);
}

function scan(tables: readonly string[]): Array<{ file: string; table: string }> {
  const found: Array<{ file: string; table: string }> = [];
  for (const file of [...listSourceFiles('lib'), ...listSourceFiles('app')].sort()) {
    const source = readFileSync(path.join(REPO_ROOT, file), 'utf8');
    for (const table of tables) if (readsTableRaw(source, table)) found.push({ file, table });
  }
  return found;
}

describe('raw SQL over enforced personal tables', () => {
  const tables = enforcedTables();

  it('self-test: finds a raw read of the table, and not a Prisma read or prose', () => {
    expect(tables).toContain('ai_user_memory');
    expect(
      readsTableRaw('await prisma.$queryRaw`SELECT * FROM "ai_user_memory"`', 'ai_user_memory')
    ).toBe(true);
    expect(
      readsTableRaw('const q = Prisma.sql`SELECT count(*) FROM ai_user_memory`;', 'ai_user_memory')
    ).toBe(true);
    expect(readsTableRaw('await prisma.aiUserMemory.findMany()', 'ai_user_memory')).toBe(false);
    expect(
      readsTableRaw('await prisma.$queryRaw`SELECT 1`; // ai_user_memory_extra', 'ai_user_memory')
    ).toBe(false);
  });

  it('every raw read of an enforced table is in the manifest, with a reason', () => {
    const listed = new Set(MANIFEST.map((m) => `${m.file} ${m.table}`));
    const unlisted = scan(tables).filter((f) => !listed.has(`${f.file} ${f.table}`));
    expect(
      unlisted,
      'Raw SQL reads a table the owner layer enforces, and no where reaches it. Check it cannot ' +
        "return another member's rows to a narrowed caller, then add a row with a `why` to " +
        'MANIFEST in tests/unit/lib/db/owner-raw-sql-manifest.test.ts.'
    ).toEqual([]);
    for (const row of MANIFEST) expect(row.why.trim().length, row.file).toBeGreaterThan(20);
  });

  it('the manifest carries no stale rows', () => {
    const found = new Set(scan(tables).map((f) => `${f.file} ${f.table}`));
    expect(MANIFEST.filter((m) => !found.has(`${m.file} ${m.table}`))).toEqual([]);
    expect(MANIFEST.map((m) => m.file)).toEqual([...MANIFEST.map((m) => m.file)].sort());
  });
});
