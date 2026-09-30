/**
 * Tests: the migration that retires the built-in template rows (§116 t-727)
 *
 * A mocked unit test cannot run the SQL, so this reads the migration file and
 * holds it to its contract, as `tests/unit/lib/tenancy/migration.test.ts`
 * does. The SQL itself was run against Postgres in the PR's local replay.
 *
 * The contract:
 * - it is a soft delete: rows are switched off and stop being templates,
 *   and nothing is removed, so executions keep their workflow;
 * - it touches only the built-in slugs, only while they are still templates,
 *   and never a system workflow.
 *
 * @see prisma/migrations/20260930120000_retire_builtin_template_rows/migration.sql
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

import { BUILTIN_WORKFLOW_TEMPLATES } from '@/prisma/seeds/data/templates';

const MIGRATION = readFileSync(
  path.join(
    process.cwd(),
    'prisma/migrations/20260930120000_retire_builtin_template_rows/migration.sql'
  ),
  'utf8'
);

/** The SQL with comments stripped, so an assertion cannot pass on prose. */
const sql = MIGRATION.split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join('\n');

/** The slugs inside the `"slug" IN (...)` list. */
function slugList(): string[] {
  const match = /"slug" IN \(([^)]*)\)/.exec(sql);
  if (!match) throw new Error('no slug IN (...) list in the migration');
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

describe('retire_builtin_template_rows', () => {
  it('is a single UPDATE: it removes nothing', () => {
    expect(sql).not.toMatch(/\bDELETE\b/i);
    expect(sql).not.toMatch(/\bDROP\b/i);
    expect(sql).not.toMatch(/\bTRUNCATE\b/i);
    expect(sql.match(/\bUPDATE\b/gi)).toHaveLength(1);
    expect(sql).toMatch(/UPDATE "ai_workflow"/);
  });

  it('switches each row off and stops it being a template', () => {
    expect(sql).toMatch(/SET "isActive" = false,\s*"isTemplate" = false/);
  });

  it('touches only rows that are still templates, and never a system workflow', () => {
    expect(sql).toMatch(/WHERE "isTemplate" = true\s+AND "isSystem" = false\s+AND "slug" IN/);
  });

  it('names exactly the twelve built-ins that seed 004 wrote', () => {
    const slugs = slugList();
    // Every slug is a built-in: a typo would match no row and leave it live.
    const builtin = new Set(BUILTIN_WORKFLOW_TEMPLATES.map((t) => t.slug));
    for (const slug of slugs) expect(builtin.has(slug)).toBe(true);
    // All twelve, once each. A template added to the code later was never a
    // row, so the list does not grow with it.
    expect(new Set(slugs).size).toBe(12);
    expect(slugs).toHaveLength(12);
  });

  it('leaves the provider-audit system workflow alone', () => {
    expect(slugList()).not.toContain('tpl-provider-model-audit');
  });
});
