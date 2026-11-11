/**
 * Tests: the migration that adds the LLM privacy layer's settings (§127 t-991)
 *
 * The default-mode requirement: an install that already has a settings row
 * reads `off` after the migration, and a row created afterwards (a new
 * install) reads `detect`. A mode an operator has set is never rewritten.
 *
 * A mocked unit test cannot run the SQL, so this holds the file to that
 * contract, as `retire-builtin-template-rows.test.ts` does. The SQL was run
 * against Postgres in the PR's local replay: the existing row read `off`, a
 * row inserted afterwards read `detect`.
 *
 * @see prisma/migrations/20261111120000_privacy_settings/migration.sql
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (rel: string) => readFileSync(path.join(process.cwd(), rel), 'utf8');

/** The SQL with comments stripped, so an assertion cannot pass on prose. */
const sql = read('prisma/migrations/20261111120000_privacy_settings/migration.sql')
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join('\n');

const schema = read('prisma/schema/orchestration-providers.prisma');

describe('the privacy settings migration', () => {
  it("adds the mode with default 'off', which is what fills rows that already exist", () => {
    expect(sql).toMatch(/ADD COLUMN\s+"privacyMode" TEXT NOT NULL DEFAULT 'off'/);
  });

  it("then makes 'detect' the default, for rows created afterwards", () => {
    const add = sql.search(/ADD COLUMN\s+"privacyMode"/);
    const setDefault = sql.search(/ALTER COLUMN "privacyMode" SET DEFAULT 'detect'/);
    expect(add).toBeGreaterThanOrEqual(0);
    expect(setDefault).toBeGreaterThan(add);
  });

  it('never writes a mode into a row: no UPDATE, no INSERT', () => {
    expect(sql).not.toMatch(/\bUPDATE\b/i);
    expect(sql).not.toMatch(/\bINSERT\b/i);
  });

  it("matches the schema's final default, so a later migrate diff sees no drift", () => {
    expect(schema).toMatch(/privacyMode\s+String\s+@default\("detect"\)/);
    expect(schema).toMatch(/privacyProtectLocalProviders\s+Boolean\s+@default\(false\)/);
    expect(sql).toMatch(/"privacyProtectLocalProviders" BOOLEAN NOT NULL DEFAULT false/);
    expect(sql).toMatch(
      /"privacyIgnoredEntityTypes" JSONB NOT NULL DEFAULT '\["DATE", "LOCATION"\]'/
    );
  });
});

/** t-992: the embeddings policy. */
const embeddingsSql = read(
  'prisma/migrations/20261111200000_privacy_embeddings_policy/migration.sql'
)
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join('\n');

describe('the embeddings policy migration (t-992)', () => {
  it("adds the policy as 'allow' for every row, existing or new, and writes no other value", () => {
    expect(embeddingsSql).toMatch(
      /ADD COLUMN\s+"privacyEmbeddingsPolicy" TEXT NOT NULL DEFAULT 'allow'/
    );
    expect(embeddingsSql).not.toMatch(/\bUPDATE\b|\bINSERT\b|SET DEFAULT/i);
    expect(schema).toMatch(/privacyEmbeddingsPolicy\s+String\s+@default\("allow"\)/);
  });
});
