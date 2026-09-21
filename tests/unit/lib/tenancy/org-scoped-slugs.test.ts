/**
 * Namespace guard: a slug on a tenant-owned model is unique PER ORG, not per
 * install (§107 t-708).
 *
 * Two orgs can each have an agent called `support`. The schema says that
 * with `@@unique([orgId, slug])`, so this reads the schema off disk and
 * fails naming any tenant-owned model whose `slug` is still a global
 * `@unique`, or whose per-org key is missing — a new tenant-owned model with
 * a slug reaches no test through the module graph. `AiWorkflow.slug` is the
 * one exception, by decision on the §107 journal: it is the unauthenticated
 * `inbound/:channel/:slug` URL segment and stays global.
 *
 * The two partial uniques Prisma cannot model on the same tables
 * (`idx_knowledge_doc_file_hash_ready`, `idx_ai_knowledge_base_single_default`)
 * moved to per-org in the same migration; that is checked here against the
 * migration SQL, since the schema cannot say it.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

const SCHEMA_DIR = path.join(process.cwd(), 'prisma/schema');
const MIGRATIONS = path.join(process.cwd(), 'prisma/migrations');

/** `AiWorkflow.slug` is the inbound URL segment and stays global (journal decision). */
const GLOBAL_SLUG_BY_DECISION = new Set(['AiWorkflow']);

function schemaText(): string {
  return readdirSync(SCHEMA_DIR)
    .filter((f) => f.endsWith('.prisma'))
    .sort()
    .map((f) => readFileSync(path.join(SCHEMA_DIR, f), 'utf8'))
    .join('\n');
}

interface ModelShape {
  hasOrgId: boolean;
  slugGloballyUnique: boolean;
  perOrgSlugKey: boolean;
}

/** One entry per model: does it carry `orgId`, and how is its `slug` keyed? */
export function slugShapes(schema: string): Map<string, ModelShape> {
  const out = new Map<string, ModelShape>();
  for (const m of schema.matchAll(/^model (\w+) \{\n([\s\S]*?)^\}/gm)) {
    const [, name, body] = m;
    const lines = body.split('\n').map((l) => l.replace(/\/\/.*$/, '').trim());
    const slugLine = lines.find((l) => /^slug\s+String\b/.test(l));
    if (!slugLine) continue;
    out.set(name, {
      hasOrgId: lines.some((l) => /^orgId\s+String\b/.test(l)),
      slugGloballyUnique: /@unique\b/.test(slugLine),
      perOrgSlugKey: lines.some((l) => /^@@unique\(\[orgId, slug\]\)/.test(l)),
    });
  }
  return out;
}

/** The names the guard would report. */
export function namespaceGaps(shapes: ReadonlyMap<string, ModelShape>): {
  stillGlobal: string[];
  missingKey: string[];
} {
  const stillGlobal: string[] = [];
  const missingKey: string[] = [];
  for (const [name, shape] of shapes) {
    if (!shape.hasOrgId || GLOBAL_SLUG_BY_DECISION.has(name)) continue;
    if (shape.slugGloballyUnique) stillGlobal.push(name);
    if (!shape.perOrgSlugKey) missingKey.push(name);
  }
  return { stillGlobal: stillGlobal.sort(), missingKey: missingKey.sort() };
}

describe('org-scoped slugs', () => {
  const shapes = slugShapes(schemaText());

  it('finds the models', () => {
    expect([...shapes.keys()]).toEqual(
      expect.arrayContaining(['AiAgent', 'AiKnowledgeBase', 'AiKnowledgeDocument', 'AiWorkflow'])
    );
  });

  it('keys every tenant-owned slug on (orgId, slug), and none globally', () => {
    const gaps = namespaceGaps(shapes);
    expect(
      gaps.stillGlobal,
      'tenant-owned models whose slug is a global @unique — two orgs could not share the name'
    ).toEqual([]);
    expect(gaps.missingKey, 'tenant-owned models with no @@unique([orgId, slug])').toEqual([]);
  });

  it('keeps AiWorkflow.slug global — it is the unauthenticated inbound URL segment', () => {
    expect(shapes.get('AiWorkflow')).toEqual({
      hasOrgId: true,
      slugGloballyUnique: true,
      perOrgSlugKey: false,
    });
  });

  it('leaves a global model’s slug alone', () => {
    // No orgId → not a namespace question. AiCapability is one.
    expect(shapes.get('AiCapability')).toMatchObject({ hasOrgId: false, slugGloballyUnique: true });
  });

  describe('the rule, shown to fire', () => {
    it('names a tenant-owned model whose slug is still global', () => {
      const regressed = schemaText().replace(/model AiAgent \{[\s\S]*?^\}/m, (block) =>
        block
          .replace(/^ {2}slug\s+String.*$/m, '  slug String @unique')
          .replace(/^ {2}@@unique\(\[orgId, slug\]\)\n/m, '')
      );
      expect(namespaceGaps(slugShapes(regressed))).toEqual({
        stillGlobal: ['AiAgent'],
        missingKey: ['AiAgent'],
      });
    });

    it('names a new tenant-owned model with a slug and no per-org key', () => {
      const grown =
        schemaText() +
        '\nmodel AppWidget {\n  id    String @id\n  slug  String @unique\n  orgId String?\n}\n';
      expect(namespaceGaps(slugShapes(grown))).toEqual({
        stillGlobal: ['AppWidget'],
        missingKey: ['AppWidget'],
      });
    });
  });
});

describe('the partial uniques Prisma cannot model moved with the slugs', () => {
  const sql = readdirSync(MIGRATIONS, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
    .map((name) => readFileSync(path.join(MIGRATIONS, name, 'migration.sql'), 'utf8'))
    .join('\n');

  /** The LAST definition of an index by that name, in apply order. */
  function lastDefinition(indexName: string): string | undefined {
    const matches = [
      ...sql.matchAll(new RegExp(`CREATE UNIQUE INDEX "${indexName}"[\\s\\S]*?;`, 'g')),
    ];
    return matches.at(-1)?.[0];
  }

  it('the ready-document dedupe is per org', () => {
    expect(lastDefinition('idx_knowledge_doc_file_hash_ready')).toMatch(
      /\("orgId", "fileHash"\)\s*WHERE "?status"? = 'ready'/
    );
  });

  it('the one-default-knowledge-base rule is per org', () => {
    expect(lastDefinition('idx_ai_knowledge_base_single_default')).toMatch(
      /\("orgId"\)\s*WHERE "isDefault" = true/
    );
  });
});
