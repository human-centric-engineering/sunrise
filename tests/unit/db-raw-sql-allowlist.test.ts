/**
 * Whole-tree guard: every raw-SQL call site is a conscious decision.
 *
 * Raw SQL (`.$queryRaw*` / `.$executeRaw*`) is the class of query no
 * app-layer `where` clause can reach — under the multi-tenancy capability
 * (`.context/architecture/multi-tenancy-design.md`) these are exactly the
 * sites where Postgres RLS is doing the load-bearing isolation work, and a
 * new one that nobody notices is the research doc's risk #4: policy coverage
 * silently incomplete. The prose inventories drifted within months (6 files
 * recorded in 2026-05, 8 found in 2026-08, 15 by v0.11.2) — so this test is
 * the living record, enforced the way `export-sources.test.ts` enforces the
 * privacy manifest.
 *
 * The allowlist is exact in BOTH directions: an unlisted file (or a count
 * increase in a listed one) fails until the site is deliberately admitted
 * here, and a stale entry (file gone, count dropped) fails until it is
 * removed — a list that only grows stops being a record of anything.
 * **Do not bump a count to make the test pass without reading the new call**:
 * admitting a site means asserting that, once RLS ships, its query is either
 * covered by policies on every table it touches or deliberately system-scoped.
 *
 * Scope is `lib/**` and `app/**` — request-path code plus the modules it
 * calls. `scripts/**` is deliberately excluded: scripts run out of the
 * request path under an operator's own (typically privileged) role, where
 * RLS coverage is not the control protecting anything; listing them here
 * would dilute the signal the request-path list carries. `prisma/migrations`
 * is SQL by nature and likewise out of scope.
 *
 * Matcher notes: the leading `.` requires an actual member call
 * (`prisma.$queryRaw`, `tx.$executeRawUnsafe`), so prose mentions of
 * `$queryRaw` in docblocks and comments do not count. `*.test.ts(x)` files are
 * excluded — a mocked `$queryRaw` in a test is not a database query — and that
 * is the ONLY exclusion, because every name this scan skips is a place a real
 * call can hide. A fork using a different test convention under `lib/` or
 * `app/` will see a violation naming the file, and should widen the filter in
 * `listSourceFiles` rather than add the file to `ALLOWLIST`.
 *
 * Registered in ALWAYS_RUN_TESTS (`scripts/ci/scoped-tests.ts`): adding a raw
 * call in some far-off module is exactly the change whose import graph never
 * reaches this file.
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Matches an actual raw-SQL member call, not a prose mention.
 *
 * Both halves are load-bearing, and the leading `.` alone is NOT enough — the
 * earlier version of this matcher counted any text containing `.$queryRaw`,
 * so a docblock writing `` `.$queryRaw` `` failed this always-run guard with a
 * phantom violation fixable only by rewording prose or admitting a query that
 * does not exist.
 *
 * - A receiver before the dot (`prisma`, `tx`, `(await tx)`) — prose quotes the
 *   member as `` `.$queryRaw` ``, with no identifier in front of it.
 * - A call-ish suffix after it: `(` for a method call, a backtick for the
 *   tagged-template form, `<` for an explicit type argument.
 */
const RAW_SQL_CALL = /[\w$)\]]\.\$(queryRaw|executeRaw)(Unsafe|Typed)?\s*[(`<]/g;

/**
 * Every admitted raw-SQL file, with its exact call-site count and the reason
 * it is allowed to exist. Sorted by path; keep it that way.
 */
const ALLOWLIST: ReadonlyArray<{ file: string; calls: number; why: string }> = [
  {
    file: 'app/api/v1/admin/orchestration/agents/[id]/capabilities/usage/route.ts',
    calls: 1,
    why: 'capability-usage aggregation across executions',
  },
  {
    file: 'app/api/v1/admin/orchestration/conversations/search/route.ts',
    calls: 1,
    why: 'tsvector full-text conversation search',
  },
  {
    file: 'app/api/v1/admin/orchestration/evaluations/datasets/[id]/cases/[position]/route.ts',
    calls: 1,
    why: 'positional case reorder in one statement',
  },
  {
    file: 'app/api/v1/admin/orchestration/knowledge/documents/route.ts',
    calls: 2,
    why: 'chunk/embedding counts joined per document',
  },
  {
    file: 'app/api/v1/admin/orchestration/knowledge/embedding-status/route.ts',
    calls: 1,
    why: 'embedding-coverage rollup',
  },
  {
    file: 'app/api/v1/admin/orchestration/knowledge/embeddings/route.ts',
    calls: 2,
    why: 'pgvector similarity preview + count',
  },
  {
    file: 'app/api/v1/admin/orchestration/knowledge/graph/route.ts',
    calls: 2,
    why: 'knowledge-graph adjacency aggregation',
  },
  {
    file: 'app/api/v1/chat/stream/route.ts',
    calls: 1,
    why: 'conversation-context vector lookup on the hot path',
  },
  {
    file: 'lib/db/drift-probes.ts',
    calls: 6,
    why: 'catalog queries (pg_indexes/pg_constraint/pg_class/pg_policies/information_schema) — reads system catalogs, never tenant rows',
  },
  {
    file: 'lib/db/utils.ts',
    calls: 2,
    why: 'SELECT 1 health checks — no tenant data (the playbook’s exempt row)',
  },
  {
    file: 'lib/orchestration/chat/message-embedder.ts',
    calls: 2,
    why: 'message-embedding vector INSERT/UPDATE (Prisma cannot write vector columns)',
  },
  {
    file: 'lib/orchestration/knowledge/document-manager.ts',
    calls: 1,
    why: 'chunk-management vector write',
  },
  {
    file: 'lib/orchestration/knowledge/search.ts',
    calls: 2,
    why: 'pgvector similarity + hybrid BM25 search',
  },
  {
    file: 'lib/orchestration/knowledge/seeder.ts',
    calls: 3,
    why: 'embedding backfill batches',
  },
  {
    file: 'lib/orchestration/llm/cost-reports.ts',
    calls: 2,
    why: 'cost aggregation windows',
  },
];

function countRawSqlCalls(source: string): number {
  return [...source.matchAll(RAW_SQL_CALL)].length;
}

/** Recursively list production .ts/.tsx files under `dir` (repo-relative paths). */
function listSourceFiles(repoRoot: string, dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(path.join(repoRoot, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      out.push(...listSourceFiles(repoRoot, rel));
    } else if (
      /\.tsx?$/.test(entry.name) &&
      // ONLY `*.test.ts(x)`, deliberately. An earlier version also skipped
      // `.spec.`, `__tests__/` and `__mocks__/` "for forks that use those
      // conventions" — measured afterwards, no such file exists anywhere:
      // not in Sunrise, not in any of the five forks, all of which inherit the
      // top-level `tests/` layout. It was a hole cut for nobody.
      //
      // And a hole is what it is. This guard exists to catch a raw-SQL site
      // "that nobody notices"; every name it declines to read is a place one
      // can hide. The asymmetry settles it: a fork that DOES colocate tests
      // gets a loud, self-explaining failure here and can widen this line in
      // seconds, whereas a silently skipped file is exactly the outcome the
      // guard exists to prevent. Prefer the false alarm.
      !/\.test\.tsx?$/.test(entry.name) &&
      !entry.name.endsWith('.d.ts')
    ) {
      out.push(rel);
    }
  }
  return out;
}

/** Scan lib/** and app/** production TypeScript for raw-SQL member calls. */
function scanTree(repoRoot: string): Map<string, number> {
  const files = [...listSourceFiles(repoRoot, 'lib'), ...listSourceFiles(repoRoot, 'app')];
  const found = new Map<string, number>();
  for (const file of files.sort()) {
    const n = countRawSqlCalls(readFileSync(path.join(repoRoot, file), 'utf8'));
    if (n > 0) found.set(file, n);
  }
  return found;
}

const REPO_ROOT = path.resolve(__dirname, '../..');

describe('raw-SQL allowlist guard', () => {
  // The guard is only evidence if it can demonstrably fail: prove the matcher
  // counts real call shapes and ignores prose before trusting any clean scan.
  it('self-test: the matcher counts member calls and ignores prose mentions', () => {
    const fixture = [
      'const rows = await prisma.$queryRaw<Row[]>`SELECT 1`;',
      'await tx.$executeRawUnsafe(sql);',
      'return client.$queryRawUnsafe(q, ...params);',
      'await prisma.$queryRawTyped(getUsers());', // TypedSQL preview — still a raw query
      '// a comment mentioning $queryRaw and `$executeRawUnsafe` in prose',
      ' * docblock prose: prefer $queryRaw over string interpolation',
      // The shapes the leading-dot-only matcher wrongly counted. Prose quotes
      // the member WITH its dot, which is exactly what scripts/ci did.
      ' * docblock prose quoting the member as `.$queryRaw` and `.$executeRaw`',
      ' * reason string: files using `.$queryRaw*`/`.$executeRaw*` must be listed',
    ].join('\n');
    expect(countRawSqlCalls(fixture)).toBe(4);
    expect(countRawSqlCalls('// nothing raw here')).toBe(0);
  });

  it('every raw-SQL call site in lib/ and app/ is allowlisted, at its exact count', () => {
    const found = scanTree(REPO_ROOT);
    const allowed = new Map(ALLOWLIST.map((e) => [e.file, e.calls]));

    const violations: string[] = [];
    for (const [file, calls] of found) {
      const expected = allowed.get(file);
      if (expected === undefined) {
        violations.push(`${file}: ${calls} raw-SQL call(s), not in the allowlist`);
      } else if (calls > expected) {
        violations.push(`${file}: ${calls} raw-SQL call(s), allowlist admits ${expected}`);
      }
    }

    expect
      .soft(
        violations,
        'New raw SQL found. A raw query is one no app-layer filter reaches — under ' +
          'TENANCY_MODE=multi it is covered ONLY by RLS policies. Prefer the Prisma client; if ' +
          'raw SQL is genuinely required, add the file (or bump its count) in ' +
          'tests/unit/db-raw-sql-allowlist.test.ts WITH a `why`, after checking every table the ' +
          'query touches will carry org_isolation policies or is deliberately system-scoped. ' +
          'See .context/architecture/multi-tenancy-design.md (assurance).'
      )
      .toEqual([]);
  });

  it('the allowlist carries no stale entries (file removed or count dropped)', () => {
    const found = scanTree(REPO_ROOT);

    const stale: string[] = [];
    for (const entry of ALLOWLIST) {
      const actual = found.get(entry.file) ?? 0;
      if (actual === 0) {
        stale.push(`${entry.file}: allowlisted but has no raw-SQL calls any more — remove it`);
      } else if (actual < entry.calls) {
        stale.push(
          `${entry.file}: allowlist admits ${entry.calls} but only ${actual} remain — lower it`
        );
      }
    }

    expect
      .soft(
        stale,
        'The allowlist over-admits. A list that only grows stops being a record: trim it so the ' +
          'next addition is judged against reality.'
      )
      .toEqual([]);
  });

  it('the allowlist is sorted by path (keeps diffs reviewable)', () => {
    const paths = ALLOWLIST.map((e) => e.file);
    expect(paths).toEqual([...paths].sort());
  });
});
