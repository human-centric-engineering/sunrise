/**
 * Tests: every route and capability that changes a shared setting declares it
 * (§107 t-751).
 *
 * The roster is read out of the tree, not typed: `git ls-files` under `app/`
 * for the routes, and under `lib/` plus the non-route files of `app/` for the
 * functions that write and the capability classes. A route that changes a row
 * of a `GLOBAL_CONFIG_MODELS` model, directly or through a writer, must be
 * `withAdminAuth(…, { writesSharedSettings: true })`; a capability class that
 * does must set `writesSharedSettings = true`. At `multi` the guard and the
 * dispatcher then refuse it from a customer's org. If this fails naming your
 * route or capability, declare it. If the write is not really a change to a
 * shared setting, say why in `NON_CHANGING_WRITERS` or
 * `UNDECLARED_ROUTE_EXCEPTIONS` (`scripts/ci/shared-settings-writes.ts`),
 * where the reason is the content.
 *
 * Whole-tree: declared in `ALWAYS_RUN_TESTS` because no import chain connects
 * a new route to this file. The tree is parsed once, at module scope.
 */
import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
  analyzeCapabilities,
  analyzeRoute,
  findUndeclaredSharedSettingsWrites,
  GLOBAL_CONFIG_ACCESSORS,
  libWriters,
  NON_CHANGING_WRITERS,
  staleNonChangingWriters,
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

const isRoute = (p: string) => /\/route\.tsx?$/.test(p);
const APP = tracked('app');
const ROUTES = APP.filter(isRoute).map(read);
const SOURCES = [...tracked('lib'), ...APP.filter((p) => !isRoute(p))].map(read);
const WRITERS = libWriters(SOURCES);
const ROUTE_HANDLERS = ROUTES.flatMap((r) =>
  analyzeRoute(r, WRITERS).map((h) => ({ ...h, at: `${r.path}#${h.method}` }))
);
const CAPABILITIES = SOURCES.flatMap((f) => analyzeCapabilities(f, WRITERS));

const route = (source: string, path = 'app/api/v1/fixture/route.ts'): SourceFile => ({
  path,
  source,
});

describe('the tree', () => {
  it('has no route or capability that changes a shared setting without declaring it', () => {
    expect(findUndeclaredSharedSettingsWrites(ROUTES, SOURCES, undefined, WRITERS)).toEqual([]);
  });

  it('sees the tree it judges: routes, writers, declared handlers and capabilities are all found', () => {
    // A check that reads nothing passes everything; these are the floor.
    expect(ROUTES.length).toBeGreaterThan(100);
    for (const name of ['createFlag', 'updateFlag', 'deleteFlag', 'seedChunks']) {
      expect(WRITERS).toContain(name);
    }
    expect(ROUTE_HANDLERS.filter((h) => h.declares).length).toBeGreaterThanOrEqual(34);
    expect(CAPABILITIES.length).toBeGreaterThan(20);
    expect(CAPABILITIES.filter((c) => c.writes).map((c) => c.name.split('#')[1])).toEqual(
      expect.arrayContaining([
        'AddProviderModelsCapability',
        'ApplyAuditChangesCapability',
        'DeactivateProviderModelsCapability',
      ])
    );
  });

  it('declares nothing it does not need: every declaration is found to write', () => {
    // A declaration on code that changes nothing refuses honest work from a
    // customer's org — a read, say — for no reason.
    const needless = [
      ...ROUTE_HANDLERS.filter((h) => h.declares && !h.writes).map((h) => h.at),
      ...CAPABILITIES.filter((c) => c.declares && !c.writes).map((c) => c.name),
    ];
    expect(needless).toEqual([]);
  });

  it('holds every NON_CHANGING_WRITERS entry to its claim: it exists, and only adds', () => {
    expect(staleNonChangingWriters(SOURCES)).toEqual([]);
  });

  it('fails on a seeded violation: a real declared route with its option removed', () => {
    const path = 'app/api/v1/admin/feature-flags/route.ts';
    const real = ROUTES.find((r) => r.path === path);
    expect(real?.source).toContain('writesSharedSettings: true');
    const stripped = real!.source.replace(/,\s*\{\s*writesSharedSettings: true\s*\}/, '');
    expect(stripped).not.toContain('writesSharedSettings');

    expect(
      findUndeclaredSharedSettingsWrites([{ path, source: stripped }], [], {}, WRITERS)
    ).toEqual([{ handler: `${path}#POST`, problem: expect.stringContaining('without') }]);
  });

  it('fails on a seeded violation: a real declared capability with its flag removed', () => {
    const path = 'lib/orchestration/capabilities/built-in/add-provider-models.ts';
    const real = SOURCES.find((f) => f.path === path);
    expect(real?.source).toContain('readonly writesSharedSettings = true;');
    const stripped = real!.source.replace('readonly writesSharedSettings = true;', '');

    expect(
      findUndeclaredSharedSettingsWrites([], [{ path, source: stripped }], {}, WRITERS)
    ).toEqual([
      {
        handler: `${path}#AddProviderModelsCapability`,
        problem: expect.stringContaining('writesSharedSettings = true'),
      },
    ]);
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

  it('follows a function handed over by name, not only one called', () => {
    const [handler] = analyzeRoute(
      route(
        'async function createThing() { await prisma.aiProviderConfig.create({}); }\n' +
          'export const POST = withAdminAuth(createThing);'
      ),
      new Set()
    );
    expect(handler.writes).toBe(true);
  });

  it('follows a call through a namespace import, and no other method call', () => {
    const judged = (body: string) =>
      analyzeRoute(
        route(
          "import * as flags from '@/lib/feature-flags';\n" +
            `export const POST = withAdminAuth(async () => { ${body} });`
        ),
        new Set(['createFlag', 'update'])
      )[0].writes;
    expect(judged('await flags.createFlag({});')).toBe(true);
    // A writer that happened to be called `update` must not turn every
    // Prisma `.update(` in the tree into a shared-settings write.
    expect(judged('await prisma.aiAgent.update({});')).toBe(false);
  });

  it('follows a writer in a non-route module, as the test hands it app/ helpers', () => {
    const writers = libWriters([
      {
        path: 'app/api/v1/admin/thing/helpers.ts',
        source: 'export async function save() { await prisma.knowledgeTag.update({}); }',
      },
    ]);
    expect(writers).toEqual(new Set(['save']));
  });

  describe('NON_CHANGING_WRITERS', () => {
    const PATH = 'lib/orchestration/mcp/config.ts';
    const singleton = (update: string) =>
      `export async function getMcpServerConfig() { return prisma.mcpServerConfig.upsert({ where, create, update: ${update} }); }\n` +
      'export async function readsConfig() { return getMcpServerConfig(); }';

    it('excuses an entry that only creates what is missing, and what reaches a write through it', () => {
      expect(libWriters([{ path: PATH, source: singleton('{}') }])).toEqual(new Set());
      expect(
        staleNonChangingWriters([{ path: PATH, source: singleton('{}') }], {
          [`${PATH}#getMcpServerConfig`]: 'why',
        })
      ).toEqual([]);
    });

    it('stops excusing it the moment it changes an existing row', () => {
      const changed = singleton('{ isEnabled: true }');
      expect(libWriters([{ path: PATH, source: changed }])).toEqual(
        new Set(['getMcpServerConfig', 'readsConfig'])
      );
      expect(
        staleNonChangingWriters([{ path: PATH, source: changed }], {
          [`${PATH}#getMcpServerConfig`]: 'why',
        })
      ).toEqual([expect.stringContaining('changes or deletes an existing row')]);
    });

    it('excuses only the function at that path, not another of the same name', () => {
      const elsewhere = { path: 'lib/fork/config.ts', source: singleton('{}') };
      expect(libWriters([elsewhere])).toEqual(new Set(['getMcpServerConfig', 'readsConfig']));
    });

    it('reports an entry whose function is gone or writes nothing', () => {
      expect(
        staleNonChangingWriters([{ path: PATH, source: 'export function other() {}' }], {
          [`${PATH}#getMcpServerConfig`]: 'why',
          [`${PATH}#other`]: 'why',
        })
      ).toEqual([
        expect.stringContaining('no such function'),
        expect.stringContaining('writes no shared setting'),
      ]);
    });
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
    // `withAuth` admits non-admins; the option means nothing there, and the
    // message says so.
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

describe('capability classes', () => {
  const capability = (body: string, declare = '') => ({
    path: 'lib/fork/capabilities/thing.ts',
    source:
      `export class ThingCapability extends BaseCapability<A, B> {\n${declare}\n` +
      `  async execute() { ${body} }\n}\n` +
      'export class Unrelated { async run() { await prisma.featureFlag.delete({}); } }',
  });

  it('asks a capability that writes to declare, and only one that extends BaseCapability', () => {
    expect(
      analyzeCapabilities(capability('await prisma.aiCapability.update({});'), new Set())
    ).toEqual([
      { name: 'lib/fork/capabilities/thing.ts#ThingCapability', writes: true, declares: false },
    ]);
  });

  it('follows a writer it calls, and sees the flag set to true', () => {
    expect(
      analyzeCapabilities(
        capability('await createFlag();', '  readonly writesSharedSettings = true;'),
        new Set(['createFlag'])
      )
    ).toEqual([
      { name: 'lib/fork/capabilities/thing.ts#ThingCapability', writes: true, declares: true },
    ]);
  });

  it('reports the undeclared one through the whole check', () => {
    expect(
      findUndeclaredSharedSettingsWrites(
        [],
        [capability('await prisma.knowledgeTag.create({});')],
        {}
      )
    ).toEqual([
      {
        handler: 'lib/fork/capabilities/thing.ts#ThingCapability',
        problem: expect.stringContaining('capability'),
      },
    ]);
  });
});
