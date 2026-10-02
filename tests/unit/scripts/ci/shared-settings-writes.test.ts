/**
 * Tests: every route that changes a shared setting declares it (§107 t-751).
 *
 * The roster is read out of the tree, not typed: `git ls-files` under `app/`
 * for the routes and under `lib/` for the functions that write. A route that
 * changes a row of a `GLOBAL_CONFIG_MODELS` model, directly or through a
 * writer, must be `withAdminAuth(…, { writesSharedSettings: true })`, so that
 * at `multi` the guard refuses it from a customer's org. If this fails naming
 * your route, add the option. If the write is not really a change to a shared
 * setting, say why in `NON_CHANGING_WRITERS` or `UNDECLARED_ROUTE_EXCEPTIONS`
 * (`scripts/ci/shared-settings-writes.ts`), where the reason is the content.
 *
 * Whole-tree: declared in `ALWAYS_RUN_TESTS` because no import chain connects
 * a new route to this file.
 */
import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
  analyzeRoute,
  findUndeclaredSharedSettingsWrites,
  GLOBAL_CONFIG_ACCESSORS,
  libWriters,
  NON_CHANGING_WRITERS,
  UNDECLARED_ROUTE_EXCEPTIONS,
  type SourceFile,
} from '@/scripts/ci/shared-settings-writes';

function tracked(dir: string): string[] {
  return execSync(`git ls-files --cached --others --exclude-standard -- ${dir}`, {
    encoding: 'utf8',
  })
    .split('\n')
    .filter((p) => /\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p) && !p.endsWith('.d.ts'));
}

const read = (path: string): SourceFile => ({ path, source: readFileSync(path, 'utf8') });

const LIB = tracked('lib').map(read);
const ROUTES = tracked('app')
  .filter((p) => /\/route\.tsx?$/.test(p))
  .map(read);

const route = (source: string, path = 'app/api/v1/fixture/route.ts'): SourceFile => ({
  path,
  source,
});

describe('the tree', () => {
  it('has no route that changes a shared setting without declaring it', () => {
    expect(findUndeclaredSharedSettingsWrites(ROUTES, LIB)).toEqual([]);
  });

  it('sees the tree it judges: routes, writers and declared handlers are all found', () => {
    // A check that reads nothing passes everything; these are the floor.
    expect(ROUTES.length).toBeGreaterThan(100);
    const writers = libWriters(LIB);
    for (const name of ['createFlag', 'updateFlag', 'deleteFlag', 'seedChunks']) {
      expect(writers).toContain(name);
    }
    const declared = ROUTES.flatMap((r) =>
      analyzeRoute(r, writers)
        .filter((h) => h.declares)
        .map((h) => `${r.path}#${h.method}`)
    );
    expect(declared.length).toBeGreaterThanOrEqual(33);
  });

  it('declares nothing it does not need: every declared handler is found to write', () => {
    // A declaration on a handler that changes nothing refuses honest work from
    // a customer's org — a read, say — for no reason.
    const writers = libWriters(LIB);
    const needless = ROUTES.flatMap((r) =>
      analyzeRoute(r, writers)
        .filter((h) => h.declares && !h.writes)
        .map((h) => `${r.path}#${h.method}`)
    );
    expect(needless).toEqual([]);
  });

  it('fails on a seeded violation: a real declared route with its option removed', () => {
    const path = 'app/api/v1/admin/feature-flags/route.ts';
    const real = ROUTES.find((r) => r.path === path);
    expect(real?.source).toContain('writesSharedSettings: true');
    const stripped = real!.source.replace(/,\s*\{\s*writesSharedSettings: true\s*\}/, '');
    expect(stripped).not.toContain('writesSharedSettings');

    const others = ROUTES.filter((r) => r.path !== path);
    expect(
      findUndeclaredSharedSettingsWrites([...others, { path, source: stripped }], LIB)
    ).toEqual([{ handler: `${path}#POST`, problem: expect.stringContaining('without') }]);
  });

  it('gives every exception a reason worth reading', () => {
    for (const reason of [
      ...Object.values(NON_CHANGING_WRITERS),
      ...Object.values(UNDECLARED_ROUTE_EXCEPTIONS),
    ]) {
      expect(reason.length).toBeGreaterThan(40);
    }
  });
});

describe('what counts as a write', () => {
  const writesIn = (body: string): boolean =>
    analyzeRoute(
      route(`export const POST = withAdminAuth(async () => {\n${body}\n});`),
      new Set()
    )[0].writes;

  it('derives the model accessors from GLOBAL_CONFIG_MODELS', () => {
    expect(GLOBAL_CONFIG_ACCESSORS).toContain('aiProviderModel');
    expect(GLOBAL_CONFIG_ACCESSORS).toContain('featureFlag');
    expect(GLOBAL_CONFIG_ACCESSORS).not.toContain('aiAgent');
  });

  it.each([
    ['a plain call', 'await prisma.featureFlag.create({ data });'],
    ['a transaction client', 'await tx.aiCapability.update({ where, data });'],
    ['bracket access', "await db['knowledgeTag'].upsert({ where, create, update });"],
    ['a parenthesised receiver', 'await (tx ?? prisma).aiProviderModel.deleteMany({});'],
    ['optional chaining', 'await tx?.mcpExposedTool?.delete({ where });'],
    [
      'an array transaction',
      'await prisma.$transaction([prisma.aiAgentProfile.createMany({ data })]);',
    ],
    ['raw SQL', 'await prisma.$executeRaw`UPDATE "ai_capability" SET "isActive" = false`;'],
    [
      'raw SQL, schema-qualified',
      "await prisma.$executeRawUnsafe('DELETE FROM public.feature_flag');",
    ],
  ])('sees %s', (_label, body) => {
    expect(writesIn(body)).toBe(true);
  });

  it.each([
    ['a read', 'await prisma.featureFlag.findMany({});'],
    ['a count', 'await prisma.aiCapability.count({});'],
    ['a write to a tenant model', 'await prisma.aiAgent.update({ where, data });'],
    ['raw SQL that reads', 'await prisma.$queryRaw`SELECT * FROM ai_capability`;'],
  ])('does not count %s', (_label, body) => {
    expect(writesIn(body)).toBe(false);
  });

  it('follows a writer under lib/, through another writer', () => {
    const lib: SourceFile[] = [
      {
        path: 'lib/a.ts',
        source: 'export async function inner() { await prisma.featureFlag.delete({}); }',
      },
      { path: 'lib/b.ts', source: 'export const outer = async () => { await inner(); };' },
    ];
    const writers = libWriters(lib);
    expect(writers).toEqual(new Set(['inner', 'outer']));
    const [handler] = analyzeRoute(
      route('export const DELETE = withAdminAuth(async () => { await outer(); });'),
      writers
    );
    expect(handler.writes).toBe(true);
  });

  it('follows a helper in the route file itself', () => {
    const [handler] = analyzeRoute(
      route(
        'async function save() { await prisma.aiProviderConfig.update({}); }\n' +
          'export const PATCH = withAdminAuth(async () => { await save(); });'
      ),
      new Set()
    );
    expect(handler.writes).toBe(true);
  });

  it('does not count a writer that only creates what is missing, nor what reaches a write through it', () => {
    const lib: SourceFile[] = [
      {
        path: 'lib/mcp.ts',
        source:
          'export async function getMcpServerConfig() { return prisma.mcpServerConfig.upsert({}); }\n' +
          'export async function readsConfig() { return getMcpServerConfig(); }',
      },
    ];
    expect(libWriters(lib)).toEqual(new Set());
  });

  it('judges each handler on its own: a GET beside a declared PATCH needs nothing', () => {
    const handlers = analyzeRoute(
      route(
        'export const GET = withAdminAuth(async () => prisma.featureFlag.findMany({}));\n' +
          'export const PATCH = withAdminAuth(async () => prisma.featureFlag.update({}), { writesSharedSettings: true });'
      ),
      new Set()
    );
    expect(handlers).toEqual([
      { method: 'GET', writes: false, declares: false },
      { method: 'PATCH', writes: true, declares: true },
    ]);
  });
});

describe('what satisfies it', () => {
  const write = 'async () => prisma.featureFlag.create({})';

  it('only withAdminAuth with the option set to true', () => {
    const judged = (source: string) =>
      findUndeclaredSharedSettingsWrites([route(source)], [], {}).map((v) => v.handler);
    const at = ['app/api/v1/fixture/route.ts#POST'];

    expect(
      judged(`export const POST = withAdminAuth(${write}, { writesSharedSettings: true });`)
    ).toEqual([]);
    expect(judged(`export const POST = withAdminAuth(${write});`)).toEqual(at);
    expect(judged(`export const POST = withAdminAuth(${write}, { resource });`)).toEqual(at);
    // `withAuth` admits non-admins; the option means nothing there.
    expect(
      judged(`export const POST = withAuth(${write}, { writesSharedSettings: true });`)
    ).toEqual(at);
    // An unguarded handler is a violation too.
    expect(judged(`export async function POST() { await prisma.featureFlag.create({}); }`)).toEqual(
      at
    );
  });

  it('honours an exception, and reports one that no longer matches anything', () => {
    const key = 'app/api/v1/fixture/route.ts#POST';
    const undeclared = route(`export const POST = withAdminAuth(${write});`);
    const declared = route(
      `export const POST = withAdminAuth(${write}, { writesSharedSettings: true });`
    );

    expect(findUndeclaredSharedSettingsWrites([undeclared], [], { [key]: 'why' })).toEqual([]);
    expect(findUndeclaredSharedSettingsWrites([declared], [], { [key]: 'why' })).toEqual([
      { handler: key, problem: expect.stringContaining('remove it') },
    ]);
  });
});
