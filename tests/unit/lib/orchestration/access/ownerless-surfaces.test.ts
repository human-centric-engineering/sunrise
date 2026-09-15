/**
 * Every source file that reads `AiWorkflowExecution`, `AiConversation` or
 * `AiMessage` goes through the access helpers, or says why it does not.
 *
 * The roster is read out of the tree, not typed: `git ls-files` under `app/`,
 * `lib/` and `components/`, minus tests. A hand-maintained list is how the three
 * gaps this check exists for went unnoticed — each was found by a reviewer
 * looking one directory sideways, and each coverage claim written about the
 * helpers before this was derived from the files its author happened to read
 * (t-692). `.context/auth/authorization.md` names the surfaces the seam does
 * not yet reach; this is what keeps that list honest.
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
 * Two halves. The first proves the checker can fail, against synthetic files —
 * a check that has never been seen red is not evidence of anything. The second
 * runs it over the real tree and expects nothing.
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
  findUndeclaredOwnerlessReads,
  validateExceptions,
  modelsRead,
  OWNERLESS_SURFACE_EXCEPTIONS,
  MIN_REASON_LENGTH,
  type OwnerlessSurfaceException,
} from '@/lib/orchestration/access/ownerless-surfaces';

// ─── Synthetic sources ────────────────────────────────────────────────────────

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
import { executionVisibilityWhere } from '@/lib/orchestration/access/execution-access';
export const GET = withAdminAuth(async (_r, session) => {
  const rows = await prisma.aiWorkflowExecution.findMany({ where: executionVisibilityWhere(session) });
  return Response.json(rows);
});
`;

const IMPORT_ONLY_ROUTE = `
import { prisma } from '@/lib/db/client';
import { executionVisibilityWhere } from '@/lib/orchestration/access/execution-access';
export async function GET() {
  return Response.json(await prisma.aiWorkflowExecution.findMany({}));
}
`;

const WRONG_HELPER_ROUTE = `
import { prisma } from '@/lib/db/client';
import { adminCanViewExecution } from '@/lib/orchestration/access/execution-access';
export async function GET(session: never) {
  if (!adminCanViewExecution(null, session)) return new Response(null, { status: 404 });
  return Response.json(await prisma.aiConversation.findMany({}));
}
`;

const RAW_SQL_ROUTE = `
import { prisma } from '@/lib/db/client';
export async function GET() {
  return Response.json(await prisma.$queryRawUnsafe(\`SELECT c.id FROM ai_conversation c JOIN ai_message m ON m."conversationId" = c.id\`));
}
`;

const COMMENT_ONLY = `
/**
 * Unlike prisma.aiConversation.findMany, this touches nothing.
 * Nor does the table name ai_message here, nor "FROM ai_conversation".
 */
// prisma.aiWorkflowExecution.count() — a mention, not a call
export const nothing = 1;
`;

const AUDIT_STRING_ONLY = `
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
export function record() {
  logAdminAction({ entityType: 'ai_conversation', action: 'x' } as never);
}
`;

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

// ─── The checker can fail ─────────────────────────────────────────────────────

describe('findUndeclaredOwnerlessReads — the direction that fails', () => {
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

  it('does not count a comment mentioning the imported name as a use', () => {
    const src = IMPORT_ONLY_ROUTE + '\n// executionVisibilityWhere would go here, one day\n';
    const { files, read } = tree({ 'app/api/x/route.ts': src });

    const violations = findUndeclaredOwnerlessReads(files, read, []);

    expect(violations.map((v) => v.message)).toEqual([expect.stringContaining('never uses it')]);
  });

  it('is not satisfied by a type-only import', () => {
    // The helpers export types (`AccessBasis`, `ExecutionOwner`), so this is an
    // easy accident as well as an easy dodge. A type reaches nothing at
    // runtime and cannot be the road a query took.
    const wholeImportType =
      "import type { ExecutionOwner } from '@/lib/orchestration/access/execution-access';\n" +
      "import { prisma } from '@/lib/db/client';\n" +
      'export async function GET(o: ExecutionOwner) { return Response.json(await prisma.aiWorkflowExecution.findMany({ where: o })); }\n';
    const inlineType =
      "import { type ExecutionOwner } from '@/lib/orchestration/access/execution-access';\n" +
      "import { prisma } from '@/lib/db/client';\n" +
      'export async function GET(o: ExecutionOwner) { return Response.json(await prisma.aiWorkflowExecution.findMany({ where: o })); }\n';

    for (const src of [wholeImportType, inlineType]) {
      const { files, read } = tree({ 'app/api/x/route.ts': src });
      const violations = findUndeclaredOwnerlessReads(files, read, []);
      expect(violations.map((v) => v.message)).toEqual([
        expect.stringContaining('without importing'),
      ]);
    }
  });

  it('is not satisfied by a commented-out import', () => {
    const src =
      "// import { executionVisibilityWhere } from '@/lib/orchestration/access/execution-access';\n" +
      "import { prisma } from '@/lib/db/client';\n" +
      "export async function GET() { const s = 'executionVisibilityWhere'; return Response.json(await prisma.aiWorkflowExecution.findMany({})); }\n";
    const { files, read } = tree({ 'app/api/x/route.ts': src });

    const violations = findUndeclaredOwnerlessReads(files, read, []);

    expect(violations.map((v) => v.message)).toEqual([
      expect.stringContaining('without importing'),
    ]);
  });

  it('does not exempt a sibling of the helpers for living in the same directory', () => {
    const { files, read } = tree({
      'lib/orchestration/access/dataset-access.ts': HELPERLESS_ROUTE,
    });

    const violations = findUndeclaredOwnerlessReads(files, read, []);

    expect(violations).toHaveLength(1);
  });

  it('is not silenced by a bare import nothing in the file uses', () => {
    // The dodge the "imports the helper" rule invites: add the import, change
    // nothing else. The name is imported and never referenced again.
    const { files, read } = tree({ 'app/api/x/route.ts': IMPORT_ONLY_ROUTE });

    const violations = findUndeclaredOwnerlessReads(files, read, []);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain('executionVisibilityWhere');
    expect(violations[0]?.message).toContain('never uses it');
  });

  it('checks per model — importing the execution helper does not cover a conversation read', () => {
    const { files, read } = tree({ 'app/api/x/route.ts': WRONG_HELPER_ROUTE });

    const violations = findUndeclaredOwnerlessReads(files, read, []);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain('aiConversation');
    expect(violations[0]?.message).toContain('conversation-access');
  });

  it('sees a table named in raw SQL, not only a Prisma accessor', () => {
    const { files, read } = tree({ 'app/api/x/route.ts': RAW_SQL_ROUTE });

    const violations = findUndeclaredOwnerlessReads(files, read, []);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain('aiConversation');
    expect(violations[0]?.message).toContain('aiMessage');
  });

  it('reports an empty roster as a fault rather than a pass', () => {
    const violations = findUndeclaredOwnerlessReads([], () => null, []);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.path).toBe('(roster)');
  });
});

// ─── What is deliberately not a read ─────────────────────────────────────────

describe('modelsRead — what counts as touching a model', () => {
  it('ignores a docblock or line comment that names one', () => {
    expect(modelsRead(COMMENT_ONLY).size).toBe(0);
  });

  it('ignores a table name that is only an audit entityType string, not SQL', () => {
    expect(modelsRead(AUDIT_STRING_ONLY).size).toBe(0);
  });

  it('does not mistake a sibling table for the model', () => {
    // `ai_conversation_share` and `ai_message_embedding` are their own tables.
    const src =
      'const q = `SELECT 1 FROM "ai_conversation_share" s JOIN ai_message_embedding e ON 1=1`;';
    expect(modelsRead(src).size).toBe(0);
  });

  it('finds an accessor on any receiver, not only `prisma`', () => {
    expect([...modelsRead('await tx.aiMessage.create({ data })')]).toEqual(['aiMessage']);
  });

  // The shapes a reviewer listed as evasions on the first draft, each now
  // caught. A checker that enumerates shapes fails one review round at a
  // time; these pin the ones that ordinary code actually produces.
  it.each([
    ['optional chaining', 'prisma?.aiConversation.findMany()', 'aiConversation'],
    ['bracket access', "prisma['aiConversation'].findMany()", 'aiConversation'],
    ['destructured client', 'const { aiMessage } = prisma; await aiMessage.count();', 'aiMessage'],
    ['schema-qualified SQL', '`SELECT 1 FROM public.ai_conversation c`', 'aiConversation'],
    ['quoted schema-qualified SQL', '`SELECT 1 FROM "public"."ai_message" m`', 'aiMessage'],
    [
      'keyword and table on different lines',
      '`SELECT 1\n  FROM\n    ai_conversation c`',
      'aiConversation',
    ],
    ['a SQL line beginning with *', '`SELECT\n  * FROM ai_conversation`', 'aiConversation'],
    [
      'Prisma.raw table name',
      "sql`SELECT 1 FROM ${Prisma.raw('ai_workflow_execution')}`",
      'aiWorkflowExecution',
    ],
    ['a computed receiver', '(tx ?? prisma).aiMessage.findMany({})', 'aiMessage'],
    ['a call-expression receiver', 'getDb().aiWorkflowExecution.count()', 'aiWorkflowExecution'],
  ])('sees %s', (_label, source, model) => {
    expect([...modelsRead(source)]).toEqual([model]);
  });

  it('strips a block comment by state, so a `*`-led SQL line inside a template is code', () => {
    const src =
      '/* prisma.aiMessage in a comment */\nconst q = `SELECT\n  * FROM ai_conversation`;';
    expect([...modelsRead(src)]).toEqual(['aiConversation']);
  });

  it('leaves a `//` inside a string alone', () => {
    const src = "const url = 'https://x.test'; await prisma.aiMessage.count();";
    expect([...modelsRead(src)]).toEqual(['aiMessage']);
  });
});

// ─── The exception list cannot rot ────────────────────────────────────────────

describe('exceptions are validated, not trusted', () => {
  it('rejects a reason under the floor', () => {
    const violations = validateExceptions([exception({ reason: 'background job' })]);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain(`${MIN_REASON_LENGTH} characters`);
  });

  it('rejects a duplicate path', () => {
    const violations = validateExceptions([exception({}), exception({})]);

    expect(violations.map((v) => v.message)).toEqual([expect.stringContaining('Listed twice')]);
  });

  it("rejects a 'known-gap' with nothing tracking it, and a 'by-design' that claims to be tracked", () => {
    const gap = validateExceptions([exception({ disposition: 'known-gap' })]);
    const tracked = validateExceptions([exception({ disposition: 'by-design', tracking: '#1' })]);

    expect(gap).toHaveLength(1);
    expect(gap[0]?.message).toContain('tracking');
    expect(tracked).toHaveLength(1);
    expect(tracked[0]?.message).toContain("it is a 'known-gap'");
  });

  it('reports an entry for a file that now goes through the helper as stale', () => {
    // The known-gap lifecycle: the fix lands, the import appears, the entry
    // must leave. Without this a closed gap lingers on the list as an open one.
    const { files, read } = tree({ 'app/api/x/route.ts': HELPERED_ROUTE });

    const violations = findUndeclaredOwnerlessReads(files, read, [
      exception({ disposition: 'known-gap', tracking: '#1' }),
    ]);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain('stale');
    expect(violations[0]?.message).toContain('close #1');
  });

  it('reports an entry for a file that no longer reads any model', () => {
    const { files, read } = tree({ 'app/api/x/route.ts': COMMENT_ONLY });

    const violations = findUndeclaredOwnerlessReads(files, read, [exception({})]);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain('no longer reads');
  });

  it('reports an entry for a file that was not scanned at all', () => {
    const { files, read } = tree({ 'app/api/other/route.ts': HELPERED_ROUTE });

    const violations = findUndeclaredOwnerlessReads(files, read, [exception({})]);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain('no such source file');
  });
});

// ─── The real tree ────────────────────────────────────────────────────────────

describe('the tree', () => {
  // `--others --exclude-standard` alongside `--cached`: a route that has just
  // been written and not yet staged is exactly the file a developer runs this
  // for, and plain `git ls-files` would not see it until `git add`.
  const files = execSync(
    "git ls-files --cached --others --exclude-standard 'app/**/*.ts' 'app/**/*.tsx' 'lib/**/*.ts' 'lib/**/*.tsx' 'components/**/*.ts' 'components/**/*.tsx'",
    { encoding: 'utf8', cwd: process.cwd() }
  )
    .split('\n')
    .filter(Boolean)
    .filter((f) => !/\.(test|spec)\.tsx?$/.test(f) && !f.endsWith('.d.ts'));

  const read = (p: string): string | null => {
    try {
      return readFileSync(p, 'utf8');
    } catch {
      return null;
    }
  };

  it('scanned a roster large enough to mean something', () => {
    // The population check the export-sources precedent insists on: an
    // assertion of absence passes for free on an empty set.
    expect(files.length).toBeGreaterThan(500);
    const touching = files.filter((f) => modelsRead(read(f) ?? '').size > 0);
    expect(touching.length).toBeGreaterThan(40);
  });

  it('every read of an ownerless-capable model goes through its helper, or says why not', () => {
    const violations = findUndeclaredOwnerlessReads(files, read, OWNERLESS_SURFACE_EXCEPTIONS);

    expect(violations.map((v) => `${v.path}\n    ${v.message}`).join('\n\n')).toBe('');
  });
});
