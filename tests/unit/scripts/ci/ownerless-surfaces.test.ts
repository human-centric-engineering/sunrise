/**
 * Every source file that reads `AiWorkflowExecution`, `AiConversation` or
 * `AiMessage` goes through the access helpers, or says why it does not.
 *
 * The roster is read out of the tree, not typed: `git ls-files` under `app/`,
 * `lib/` and `components/`, minus tests. A hand-maintained list is how the
 * gaps this check exists for went unnoticed — each was found by a reviewer
 * looking one directory sideways, and each coverage claim written about the
 * helpers before this was derived from the files its author happened to read
 * (t-692). `.context/auth/authorization.md` names the surfaces the seam does
 * not yet reach; this is what keeps that list honest.
 *
 * **The detector is the TypeScript parser, not a regex over text.** The first
 * draft tokenized source by hand and three review rounds each found source
 * shapes it could not see. The fixtures below were written from the language
 * grammar and from those rounds *before* the detector was rewritten, and the
 * detector was built against them — so a shape that reads a row is a fixture
 * here, and a shape that only mentions a model (a comment, a string, a type)
 * is a fixture asserting nothing is found.
 *
 * **A fork failing a row here is expected, and the fix is not to widen the
 * scan.** A fork route or job that reads one of these models lands in the
 * roster the moment it exists. If it is an admin surface, import the helper. If
 * it genuinely has no caller to scope to, declare it in
 * `appOwnerlessSurfaceExceptions` in `lib/app/ci.ts` with the reason — that
 * list is spread into the core one and validated identically, so no platform
 * file needs editing. Deleting an entry from the core list to make a fork's row
 * pass loses the protection for the platform file that entry was about.
 *
 * Whole-tree: declared in `ALWAYS_RUN_TESTS` because no import chain reaches a
 * test whose subject is the repository, and the change it exists to catch — a
 * new route querying the table directly — is precisely the change `--changed`
 * would not select it for.
 */

import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
  analyzeSource,
  findUndeclaredOwnerlessReads,
  mentionsModel,
  unexplainedMentions,
} from '@/scripts/ci/ownerless-surfaces';
import {
  validateExceptions,
  OWNERLESS_SURFACE_EXCEPTIONS,
  MIN_REASON_LENGTH,
  type OwnerlessSurfaceException,
} from '@/lib/orchestration/access/ownerless-surfaces';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const HELPER = "'@/lib/orchestration/access/execution-access'";

function models(source: string, path = 'app/api/x/route.ts'): string[] {
  return [...analyzeSource(path, source).models].sort();
}

function tree(files: Record<string, string>): {
  files: string[];
  read: (p: string) => string | null;
} {
  return { files: Object.keys(files), read: (p) => files[p] ?? null };
}

function exception(over: Partial<OwnerlessSurfaceException>): OwnerlessSurfaceException {
  return {
    path: 'app/api/x/route.ts',
    disposition: 'by-design',
    reason: 'a synthetic reason long enough to clear the floor for these tests',
    ...over,
  };
}

// ─── What is a read: every shape the grammar offers ───────────────────────────

describe('analyzeSource — shapes that read a model', () => {
  it.each([
    ['property access', 'await prisma.aiConversation.findMany({})', ['aiConversation']],
    ['any receiver', 'await tx.aiMessage.create({ data })', ['aiMessage']],
    ['optional chaining', 'prisma?.aiConversation.findMany()', ['aiConversation']],
    ['computed receiver', '(tx ?? prisma).aiMessage.findMany({})', ['aiMessage']],
    ['call-expression receiver', 'getDb().aiWorkflowExecution.count()', ['aiWorkflowExecution']],
    ['bracket access', "prisma['aiConversation'].findMany()", ['aiConversation']],
    ['bracket access, double quotes', 'prisma["aiMessage"].count()', ['aiMessage']],
    [
      'destructured client',
      'const { aiMessage } = prisma; await aiMessage.count();',
      ['aiMessage'],
    ],
    [
      'destructured and renamed',
      'const { aiConversation: convs } = prisma; await convs.count();',
      ['aiConversation'],
    ],
    ['raw SQL in a string', "await db.query('SELECT 1 FROM ai_conversation')", ['aiConversation']],
    ['raw SQL in a template', 'await prisma.$queryRaw`SELECT 1 FROM ai_message m`', ['aiMessage']],
    [
      'schema-qualified SQL',
      'const q = `SELECT 1 FROM public.ai_conversation c`',
      ['aiConversation'],
    ],
    [
      'quoted schema-qualified SQL',
      'const q = `SELECT 1 FROM "public"."ai_message" m`',
      ['aiMessage'],
    ],
    [
      'keyword and table on different lines',
      'const q = `SELECT 1\n  FROM\n    ai_conversation c`',
      ['aiConversation'],
    ],
    [
      'a SQL line beginning with *',
      'const q = `SELECT\n  * FROM ai_conversation`',
      ['aiConversation'],
    ],
    [
      'a substitution between keyword and table',
      'const q = `SELECT 1 FROM ${schema}.ai_workflow_execution`',
      ['aiWorkflowExecution'],
    ],
    [
      'Prisma.raw table name',
      "const q = sql`SELECT 1 FROM ${Prisma.raw('ai_workflow_execution')}`",
      ['aiWorkflowExecution'],
    ],
    ['JOIN', 'const q = `SELECT 1 FROM x JOIN ai_message m ON 1=1`', ['aiMessage']],
    ['INSERT INTO', 'const q = `INSERT INTO ai_message (id) VALUES (1)`', ['aiMessage']],
    ['UPDATE', 'const q = `UPDATE ai_workflow_execution SET x = 1`', ['aiWorkflowExecution']],
    [
      'two models in one file',
      'await prisma.aiConversation.count(); await prisma.aiMessage.count();',
      ['aiConversation', 'aiMessage'],
    ],
    [
      'a read on a line that also has `//` in JSX text',
      'export function C() { return <p>See https://x.test {prisma.aiMessage.count()}</p>; }',
      ['aiMessage'],
    ],
    [
      'a read inside a nested tagged template',
      'const q = sql`SELECT 1 FROM ${cond ? sql`x` : Prisma.empty} JOIN ai_conversation c`',
      ['aiConversation'],
    ],
  ])('sees %s', (_label, source, expected) => {
    expect(models(source, 'app/api/x/route.tsx')).toEqual(expected);
  });
});

// ─── What is NOT a read: mentions that must find nothing ─────────────────────

describe('analyzeSource — mentions that are not reads', () => {
  it.each([
    [
      'a docblock',
      '/**\n * Unlike prisma.aiConversation.findMany, this touches nothing.\n */\nexport const n = 1;',
    ],
    [
      'a line comment',
      '// prisma.aiWorkflowExecution.count() — a mention, not a call\nexport const n = 1;',
    ],
    ['a trailing comment', 'export const n = 1; // see prisma.aiMessage'],
    [
      'a comment after a regex with a lone quote',
      'const r = /[\'"]/;\n// prisma.aiMessage.count()\nexport const n = 1;',
    ],
    [
      'a comment after a JSX apostrophe',
      "export function C() { return <p>Don't</p>; }\n// prisma.aiMessage.count()",
    ],
    [
      'an audit entityType string',
      "logAdminAction({ entityType: 'ai_conversation', action: 'x' } as never);",
    ],
    [
      'a sibling table',
      'const q = `SELECT 1 FROM "ai_conversation_share" s JOIN ai_message_embedding e ON 1=1`;',
    ],
    ['an object key', "const map = { aiMessage: 'conversation-access' };"],
    ['a type member', 'interface X { aiConversation: number }'],
    [
      'a type-only import of the helper',
      `import type { ExecutionOwner } from ${HELPER};\nexport const n = 1;`,
    ],
    ['a string that merely contains the word', "const s = 'no aiConversation here';"],
    ['a JSX attribute', 'export function C() { return <div data-x="aiMessage" />; }'],
  ])('finds nothing in %s', (_label, source) => {
    expect(models(source, 'app/api/x/route.tsx')).toEqual([]);
  });

  it('does not see a read through a relation include — the documented blind spot', () => {
    // Pinned as a fact rather than left as a sentence: the row arrives without
    // its model being named, and this detector cannot know a relation field
    // maps to one of the three tables.
    expect(models('await prisma.aiWorkflow.findMany({ include: { executions: true } })')).toEqual(
      []
    );
  });
});

// ─── What satisfies coverage: imports, by kind ────────────────────────────────

describe('analyzeSource — which imports count', () => {
  it('a named value import that is used covers its model', () => {
    const a = analyzeSource(
      'app/api/x/route.ts',
      `import { executionVisibilityWhere } from ${HELPER};\nexport const w = executionVisibilityWhere(s); await prisma.aiWorkflowExecution.findMany({ where: w });`
    );
    expect([...a.helperModules]).toEqual(['execution-access']);
    expect(a.unusedImports).toEqual([]);
  });

  it('a namespace import that is used covers its model', () => {
    const a = analyzeSource(
      'app/api/x/route.ts',
      `import * as access from ${HELPER};\nexport const w = access.executionVisibilityWhere(s); await prisma.aiWorkflowExecution.findMany({ where: w });`
    );
    expect([...a.helperModules]).toEqual(['execution-access']);
    expect(a.unusedImports).toEqual([]);
  });

  it('an aliased import is checked under its alias', () => {
    const a = analyzeSource(
      'app/api/x/route.ts',
      `import { executionVisibilityWhere as scope } from ${HELPER};\nexport const w = scope(s);`
    );
    expect(a.unusedImports).toEqual([]);
  });

  it('a whole `import type` covers nothing', () => {
    const a = analyzeSource(
      'app/api/x/route.ts',
      `import type { ExecutionOwner } from ${HELPER};\nexport function f(o: ExecutionOwner) { return prisma.aiWorkflowExecution.findMany({ where: o }); }`
    );
    expect([...a.helperModules]).toEqual([]);
  });

  it('an inline `type` specifier covers nothing, and a value one beside it does', () => {
    const typeOnly = analyzeSource(
      'app/api/x/route.ts',
      `import { type ExecutionOwner } from ${HELPER};\nexport function f(o: ExecutionOwner) { return prisma.aiWorkflowExecution.findMany({ where: o }); }`
    );
    expect([...typeOnly.helperModules]).toEqual([]);
    const mixed = analyzeSource(
      'app/api/x/route.ts',
      `import { type ExecutionOwner, executionVisibilityWhere } from ${HELPER};\nexport const w = executionVisibilityWhere(s);`
    );
    expect([...mixed.helperModules]).toEqual(['execution-access']);
  });

  it('a commented-out import is not an import', () => {
    const a = analyzeSource(
      'app/api/x/route.ts',
      `// import { executionVisibilityWhere } from ${HELPER};\nexport const s = 'executionVisibilityWhere';`
    );
    expect([...a.helperModules]).toEqual([]);
  });

  it('an import nothing uses is reported by name, and a comment mentioning it is not a use', () => {
    const a = analyzeSource(
      'app/api/x/route.ts',
      `import { executionVisibilityWhere } from ${HELPER};\n// executionVisibilityWhere would go here, one day\nexport const n = 1;`
    );
    expect(a.unusedImports).toEqual(['executionVisibilityWhere']);
  });

  it('a string containing the imported name is not a use', () => {
    const a = analyzeSource(
      'app/api/x/route.ts',
      `import { executionVisibilityWhere } from ${HELPER};\nexport const s = 'executionVisibilityWhere';`
    );
    expect(a.unusedImports).toEqual(['executionVisibilityWhere']);
  });

  it('a side-effect import and a re-export elsewhere in the file do not confuse the usage check', () => {
    // The regex draft's import-stripping matched from a trailing `import 'x'`
    // to the next `from '…'` anywhere, deleting the function body first.
    const a = analyzeSource(
      'app/api/x/route.ts',
      `import { executionVisibilityWhere } from ${HELPER};\nimport 'server-only';\nexport const w = executionVisibilityWhere(s);\nconst msg = "from 'x'";\nexport { y } from './y';`
    );
    expect(a.unusedImports).toEqual([]);
  });
});

// ─── The rule over a tree ─────────────────────────────────────────────────────

const HELPERLESS_ROUTE = `
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
export const GET = withAdminAuth(async (_r, session) => {
  const rows = await prisma.aiWorkflowExecution.findMany({ where: { userId: session.user.id } });
  return Response.json(rows);
});
`;

const HELPERED_ROUTE = `
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { executionVisibilityWhere } from ${HELPER};
export const GET = withAdminAuth(async (_r, session) => {
  const rows = await prisma.aiWorkflowExecution.findMany({ where: executionVisibilityWhere(session) });
  return Response.json(rows);
});
`;

describe('findUndeclaredOwnerlessReads', () => {
  it('names a file that reads a model without the helper and without an exception', () => {
    const { files, read } = tree({ 'app/api/x/route.ts': HELPERLESS_ROUTE });

    const violations = findUndeclaredOwnerlessReads(files, read, []);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.path).toBe('app/api/x/route.ts');
    expect(violations[0]?.message).toContain('aiWorkflowExecution');
    expect(violations[0]?.message).toContain('execution-access');
  });

  it('passes the same read once the helper is imported and used — the control', () => {
    const { files, read } = tree({ 'app/api/x/route.ts': HELPERED_ROUTE });

    expect(findUndeclaredOwnerlessReads(files, read, [])).toEqual([]);
  });

  it('passes the same read once it is declared with a reason — the other control', () => {
    const { files, read } = tree({ 'app/api/x/route.ts': HELPERLESS_ROUTE });

    expect(findUndeclaredOwnerlessReads(files, read, [exception({})])).toEqual([]);
  });

  it('checks per model — the execution helper does not cover a conversation read', () => {
    const src = `import { adminCanViewExecution } from ${HELPER};\nexport function f(s: never) { if (!adminCanViewExecution(null, s)) return; return prisma.aiConversation.findMany({}); }`;
    const { files, read } = tree({ 'app/api/x/route.ts': src });

    const violations = findUndeclaredOwnerlessReads(files, read, []);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain('aiConversation');
    expect(violations[0]?.message).toContain('conversation-access');
  });

  it('reports a bare import as unused rather than counting it as coverage', () => {
    const src = `import { executionVisibilityWhere } from ${HELPER};\nexport const GET = () => prisma.aiWorkflowExecution.findMany({});`;
    const { files, read } = tree({ 'app/api/x/route.ts': src });

    const violations = findUndeclaredOwnerlessReads(files, read, []);

    expect(violations.map((v) => v.message)).toEqual([expect.stringContaining('never uses it')]);
  });

  it('does not exempt a sibling of the helpers for living in the same directory', () => {
    const { files, read } = tree({
      'lib/orchestration/access/dataset-access.ts': HELPERLESS_ROUTE,
    });

    expect(findUndeclaredOwnerlessReads(files, read, [])).toHaveLength(1);
  });

  it('does exempt the two helpers and the roster module, by name', () => {
    const { files, read } = tree({
      'lib/orchestration/access/conversation-access.ts': HELPERLESS_ROUTE,
      'lib/orchestration/access/execution-access.ts': HELPERLESS_ROUTE,
    });

    expect(findUndeclaredOwnerlessReads(files, read, [])).toEqual([]);
  });

  it('reports an empty roster as a fault rather than a pass', () => {
    const violations = findUndeclaredOwnerlessReads([], () => null, []);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.path).toBe('(roster)');
  });

  it('reports an entry for a file that now goes through the helper as stale', () => {
    const { files, read } = tree({ 'app/api/x/route.ts': HELPERED_ROUTE });

    const violations = findUndeclaredOwnerlessReads(files, read, [
      exception({ disposition: 'known-gap', tracking: '#1' }),
    ]);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain('stale');
    expect(violations[0]?.message).toContain('close #1');
  });

  it('reports an entry for a file that no longer reads any model', () => {
    const { files, read } = tree({ 'app/api/x/route.ts': 'export const n = 1;' });

    const violations = findUndeclaredOwnerlessReads(files, read, [exception({})]);

    expect(violations.map((v) => v.message)).toEqual([expect.stringContaining('no longer reads')]);
  });

  it('reports an entry for a file that was not scanned at all', () => {
    const { files, read } = tree({ 'app/api/other/route.ts': HELPERED_ROUTE });

    const violations = findUndeclaredOwnerlessReads(files, read, [exception({})]);

    expect(violations.map((v) => v.message)).toEqual([
      expect.stringContaining('no such source file'),
    ]);
  });
});

// ─── The oracle can fail ──────────────────────────────────────────────────────

describe('unexplainedMentions', () => {
  it('reports a model name used as a value that no read shape accounted for', () => {
    // A delegate reached by a road the detector does not know: no property
    // access names the model, no destructuring off a client, no SQL. The
    // identifier is still there, in expression position, and that is enough.
    const src = 'const aiMessage = getDelegate(); export const n = aiMessage.count();';

    const found = unexplainedMentions('app/api/x/route.ts', src);

    // One line per occurrence — the declaration and the use — because each is
    // a place the reader has to look.
    expect(found).toHaveLength(2);
    for (const line of found) {
      expect(line).toContain('app/api/x/route.ts:1');
      expect(line).toContain('`aiMessage`');
    }
  });

  it('is satisfied once the read is detected by any shape — the control', () => {
    const src = 'const { aiMessage } = prisma; export const n = aiMessage.count();';

    expect(unexplainedMentions('app/api/x/route.ts', src)).toEqual([]);
  });

  it('ignores name positions: object keys, type members, import specifiers, JSX attributes', () => {
    const src = [
      "const map = { aiMessage: 'x' };",
      'interface T { aiConversation: number }',
      'type U = { aiWorkflowExecution?: string };',
      'export function C() { return <div aiMessage="x" />; }',
    ].join('\n');

    expect(unexplainedMentions('app/api/x/route.tsx', src)).toEqual([]);
  });
});

// ─── The exception list cannot rot ────────────────────────────────────────────

describe('exceptions are validated, not trusted', () => {
  it('rejects a reason under the floor', () => {
    const violations = validateExceptions([exception({ reason: 'background job' })]);

    expect(violations.map((v) => v.message)).toEqual([
      expect.stringContaining(`${MIN_REASON_LENGTH} characters`),
    ]);
  });

  it('rejects a duplicate path', () => {
    const violations = validateExceptions([exception({}), exception({})]);

    expect(violations.map((v) => v.message)).toEqual([expect.stringContaining('Listed twice')]);
  });

  it("rejects a 'known-gap' with nothing tracking it, and a 'by-design' that claims to be tracked", () => {
    const gap = validateExceptions([exception({ disposition: 'known-gap' })]);
    const tracked = validateExceptions([exception({ disposition: 'by-design', tracking: '#1' })]);

    expect(gap.map((v) => v.message)).toEqual([expect.stringContaining('tracking')]);
    expect(tracked.map((v) => v.message)).toEqual([expect.stringContaining("it is a 'known-gap'")]);
  });
});

// ─── The real tree ────────────────────────────────────────────────────────────

describe('the tree', () => {
  // `--others --exclude-standard` alongside `--cached`: a route that has just
  // been written and not yet staged is exactly the file a developer runs this
  // for, and plain `git ls-files` would not see it until `git add`.
  //
  // Bare directories, filtered by extension here — NOT `'lib/**/*.ts'`. Without
  // `:(glob)` magic git's `**` is a plain `*`, so that pathspec requires a
  // directory between `lib/` and the file and silently omits every depth-1
  // file (`lib/env.ts`, `app/layout.tsx`, 18 of them on this tree).
  const files = execSync('git ls-files --cached --others --exclude-standard app lib components', {
    encoding: 'utf8',
    cwd: process.cwd(),
  })
    .split('\n')
    .filter(Boolean)
    .filter((f) => /\.tsx?$/.test(f) && !/\.(test|spec)\.tsx?$/.test(f) && !f.endsWith('.d.ts'));

  const read = (p: string): string | null => {
    try {
      return readFileSync(p, 'utf8');
    } catch {
      return null;
    }
  };

  it('scanned a roster large enough to mean something, at every depth', () => {
    // The population check the export-sources precedent insists on: an
    // assertion of absence passes for free on an empty set. And a depth-1 file
    // by name, because a glob that skips the top of each tree still clears a
    // count threshold — that is how 18 files went unscanned on the first draft.
    expect(files.length).toBeGreaterThan(500);
    expect(files).toContain('lib/env.ts');
    expect(files).toContain('app/layout.tsx');
    const touching = files.filter((f) => {
      const src = read(f) ?? '';
      return mentionsModel(src) && analyzeSource(f, src).models.size > 0;
    });
    expect(touching.length).toBeGreaterThan(40);
  });

  it('every read of an ownerless-capable model goes through its helper, or says why not', () => {
    const violations = findUndeclaredOwnerlessReads(files, read, OWNERLESS_SURFACE_EXCEPTIONS);

    expect(violations.map((v) => `${v.path}\n    ${v.message}`).join('\n\n')).toBe('');
  });

  it('accounts for every model name that appears in code, not only the shapes it knows', () => {
    // The oracle the detector does not control. A model's camelCase name
    // appearing as an identifier in expression position — anywhere but an
    // object key, a type, an import specifier or a JSX attribute — is either a
    // read the detector counted or something it missed. It is an
    // over-approximation on purpose: a local variable that happens to be named
    // `aiMessage` and did not come from a client would land here too, and that
    // is a rename worth making rather than a rule worth adding.
    const candidates = files.filter((f) => mentionsModel(read(f) ?? ''));
    expect(candidates.length).toBeGreaterThan(40);

    const unexplained = candidates.flatMap((f) => unexplainedMentions(f, read(f) ?? ''));

    expect(unexplained.join('\n')).toBe('');
  });
});
