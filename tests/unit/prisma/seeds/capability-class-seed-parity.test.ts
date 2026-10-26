/**
 * Invariant: each capability's seeded `functionDefinition` matches the one its
 * class declares.
 *
 * The seed row is what the LLM and every MCP client are shown; the class is
 * what actually validates and runs. When they disagree the model is told about
 * a tool that does not exist as described — either missing a parameter it could
 * have used, or offered one the handler will reject.
 *
 * Nothing enforced this before. #545 assumed a parity test already pinned
 * "class ↔ seed constant" and that only the DB write was unguarded; that was
 * not so, and `call_external_api` had silently drifted — the class advertises a
 * `multipart` parameter (added for endpoints like Gotenberg that need named
 * file parts) that the seed never gained, so no agent could ever use it.
 *
 * That drift matters more now than it did: since #545 the seed is re-applied to
 * existing rows on every deploy, so a stale constant is not merely never
 * propagated, it is actively re-asserted over anything an operator fixed by
 * hand.
 *
 * Deep equality on purpose. Comparing parameter *names* would have caught the
 * missing `multipart` but not the `body` description that had also drifted out
 * of step with it — and a description is not cosmetic here, it is how the model
 * decides which parameter to use.
 *
 * **The seeds are run, not read.** An earlier version found capabilities by
 * reading seed source for `functionDefinition: { name: '…' }`, and passed over
 * every seed written another way — a hoisted const, a definition taken from the
 * class — without reporting it (#646). That hid all fourteen of
 * `019-cleanup-capabilities`, every one of which had drifted from its class.
 * Every seed now runs against a recording mock client, and what it
 * actually writes is what gets checked, however the seed is written.
 *
 * ---------------------------------------------------------------------------
 * FORK NOTE — your seeds are run here too
 * ---------------------------------------------------------------------------
 * Every seed under `prisma/seeds/` is run, yours included, against a STRICT
 * mock client, and each capability it writes needs a pair. Declare yours in
 * `lib/app/capability-seed-pairs.ts` (`APP_CAPABILITY_PAIRS`, spread into
 * `PAIRS` below) — do not add rows to `PAIRS`, which is Sunrise's and a merge
 * conflict on every upgrade. What fails here, and why:
 *
 *  - A seed that throws under the mock — including by calling a client method
 *    or `$`-call the mock does not model, or by writing a capability through
 *    another model's nested write.
 *  - A seed that uses the app's own client (`@/lib/db/client`) at all, even if
 *    it catches the error.
 *  - A seed whose source writes `aiCapability` by name but was seen writing
 *    none: its writes sit behind a path the mock did not drive.
 *
 * A row a seed looks up carries the fields its `select` names (every scalar,
 * when it names none), each an empty value of the column's type: `''`, `0`,
 * `false`, `{}`, `[]`, the enum's first value, `null` when optional. A seed
 * may read them; it should not branch on them expecting real data.
 *
 * A seed this cannot run — raw SQL, the app client — goes in
 * `APP_UNCHECKED_SEEDS` (same file) with the reason it writes no capability;
 * the first two rules then skip it. One whose source writes `aiCapability` by
 * name fails if listed there.
 *
 * @see .context/database/seeding.md — the seed ownership rule
 * @see lib/app/capability-seed-pairs.ts — where a fork's pairs go
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, it, expect, vi, beforeAll } from 'vitest';

/**
 * The app's own client, for a seed that bypasses the one it is handed. Any use
 * throws, and is RECORDED first — a seed that catches its own errors (021 does,
 * per org) would otherwise swallow the throw and pass.
 */
const globalClient = vi.hoisted(() => ({
  current: '',
  uses: [] as string[],
  /** The strict mock's own refusals, recorded for the same reason. */
  refusals: [] as { file: string; error: string }[],
}));
vi.mock('@/lib/db/client', () => {
  const refuse = new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (prop === 'then') return undefined;
        globalClient.uses.push(globalClient.current);
        throw new Error(`used the global Prisma client (.${String(prop)})`);
      },
    }
  );
  return { prisma: refuse, default: refuse };
});
// 019 erases legacy seed users through eraseUser(), which writes with the app
// client. Stubbed, so the rest of that seed still runs through the strict one.
vi.mock('@/lib/privacy/erase-user', () => ({ eraseUser: vi.fn() }));

import { discoverSeedFiles, type SeedContext, type SeedUnit } from '@/prisma/runner';
import { isRecord } from '@/lib/utils';
import { maskLiterals } from '@/tests/helpers/seed-capabilities';
import {
  APP_CAPABILITY_PAIRS,
  APP_UNCHECKED_SEEDS,
  type AppCapabilityPair,
} from '@/lib/app/capability-seed-pairs';
import { CLEANUP_CAPABILITIES } from '@/prisma/seeds/019-cleanup-capabilities';

import { AddProviderModelsCapability } from '@/lib/orchestration/capabilities/built-in/add-provider-models';
import { ApplyAuditChangesCapability } from '@/lib/orchestration/capabilities/built-in/apply-audit-changes';
import { CallExternalApiCapability } from '@/lib/orchestration/capabilities/built-in/call-external-api';
import { DeactivateProviderModelsCapability } from '@/lib/orchestration/capabilities/built-in/deactivate-provider-models';
import { EstimateCostCapability } from '@/lib/orchestration/capabilities/built-in/estimate-cost';
import { GetPatternDetailCapability } from '@/lib/orchestration/capabilities/built-in/get-pattern-detail';
import { RunWorkflowCapability } from '@/lib/orchestration/capabilities/built-in/run-workflow';
import { SearchKnowledgeCapability } from '@/lib/orchestration/capabilities/built-in/search-knowledge';
import { SendMessageToChannelCapability } from '@/lib/orchestration/capabilities/built-in/send-message-to-channel';
import { UploadToStorageCapability } from '@/lib/orchestration/capabilities/built-in/upload-to-storage';

/** Which class goes with which slug. The seeds supply what was written. */
const PAIRS: readonly AppCapabilityPair[] = [
  { slug: 'search_knowledge_base', instance: new SearchKnowledgeCapability() },
  { slug: 'get_pattern_detail', instance: new GetPatternDetailCapability() },
  { slug: 'estimate_workflow_cost', instance: new EstimateCostCapability() },
  { slug: 'apply_audit_changes', instance: new ApplyAuditChangesCapability() },
  { slug: 'add_provider_models', instance: new AddProviderModelsCapability() },
  { slug: 'deactivate_provider_models', instance: new DeactivateProviderModelsCapability() },
  { slug: 'call_external_api', instance: new CallExternalApiCapability() },
  { slug: 'run_workflow', instance: new RunWorkflowCapability() },
  { slug: 'upload_to_storage', instance: new UploadToStorageCapability() },
  { slug: 'send_message_to_channel', instance: new SendMessageToChannelCapability() },
  // 019 seeds each of these from its class — slug, handler and definition —
  // so a hand-written row here could only restate the seed's own list. Which
  // slugs 019 seeds is pinned independently, by `CLEANUP_SLUGS` in its own
  // unit test: dropping an entry there fails that test, not this one.
  ...CLEANUP_CAPABILITIES.map(({ capability }) => ({
    slug: capability.slug,
    instance: capability,
  })),
  ...APP_CAPABILITY_PAIRS,
];

const SEED_DIR = join(process.cwd(), 'prisma', 'seeds');

/**
 * Seeds this test may not be able to run, each with its reason: they may use
 * the app's own client, call what the mock does not model, or throw. Whatever
 * such a seed writes past that point is invisible here, capability writes
 * included — so an entry says why it writes none. Core's, then the fork's.
 */
const UNCHECKED_SEEDS: ReadonlyMap<string, string> = new Map([
  [
    '007-knowledge-chunks.ts',
    'seeds the patterns knowledge through seedChunks(), which writes with the app client; ' +
      'it writes no capability',
  ],
  ...Object.entries(APP_UNCHECKED_SEEDS),
]);

/** What a capability `…OrThrow` lookup throws in 'absent' mode, as Prisma would. */
const NOT_FOUND = 'parity mock: no such capability';
const ID_PREFIX = 'parity-mock-id:';

/** A column as the schema declares it. */
interface Column {
  type: string;
  list: boolean;
  optional: boolean;
}

/**
 * Every model's columns and every enum's first value, read from the schema
 * files — so a looked-up row can carry the fields a seed asked for (#1070).
 * The runtime DMMF does not say which fields are lists or optional.
 */
function readSchema(): { models: Map<string, Map<string, Column>>; enums: Map<string, string> } {
  const models = new Map<string, Map<string, Column>>();
  const enums = new Map<string, string>();
  const dir = join(process.cwd(), 'prisma', 'schema');
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.prisma'))) {
    let model: Map<string, Column> | null = null;
    let enumName: string | null = null;
    for (const line of readFileSync(join(dir, file), 'utf8').split('\n')) {
      const open = /^(model|enum)\s+(\w+)\s*\{/.exec(line);
      if (open) {
        if (open[1] === 'model') models.set(open[2], (model = new Map()));
        else enumName = open[2];
        continue;
      }
      if (line.startsWith('}')) {
        model = null;
        enumName = null;
        continue;
      }
      if (/^\s*(\/\/|@@)/.test(line)) continue;
      if (enumName) {
        const value = /^\s*(\w+)/.exec(line);
        if (value && !enums.has(enumName)) enums.set(enumName, value[1]);
      } else if (model) {
        const field = /^\s*(\w+)\s+(\w+)(\[\])?(\?)?(\s|$)/.exec(line);
        if (field) {
          model.set(field[1], { type: field[2], list: !!field[3], optional: !!field[4] });
        }
      }
    }
  }
  return { models, enums };
}

const SCHEMA = readSchema();

/** An empty value of each scalar type; a type not listed here is a relation. */
const EMPTY: Readonly<Partial<Record<string, () => unknown>>> = {
  String: () => '',
  Int: () => 0,
  Float: () => 0,
  Decimal: () => 0,
  BigInt: () => BigInt(0),
  Boolean: () => false,
  DateTime: () => new Date(0),
  Json: () => ({}),
  Bytes: () => new Uint8Array(0),
};

/**
 * The row Prisma would return for `args` — the fields its `select` names, else
 * every scalar plus what its `include` names — each an empty value of its type.
 * A model the schema does not declare (a client property that is not one)
 * gets no fields.
 */
function placeholderRow(model: string, args: unknown): Record<string, unknown> {
  const columns = SCHEMA.models.get(model.charAt(0).toUpperCase() + model.slice(1));
  const row: Record<string, unknown> = {};
  if (!columns) return row;
  const select = isRecord(args) && isRecord(args.select) ? args.select : null;
  const include = isRecord(args) && isRecord(args.include) ? args.include : null;
  for (const [name, column] of columns) {
    const empty =
      EMPTY[column.type] ??
      (SCHEMA.enums.has(column.type) ? () => SCHEMA.enums.get(column.type) : null);
    const wanted = select ? select[name] : empty ? true : include?.[name];
    if (!wanted) continue;
    if (column.optional) row[name] = null;
    else if (column.list) row[name] = [];
    else if (empty) row[name] = empty();
    else row[name] = placeholderRow(column.type, wanted);
  }
  // `_count: { select: { accounts: true } }`, or `_count: true` for every list.
  const count = select?._count ?? include?._count;
  if (count) {
    const counted = isRecord(count) && isRecord(count.select) ? count.select : null;
    row._count = Object.fromEntries(
      [...columns]
        .filter(([name, column]) =>
          counted
            ? counted[name]
            : column.list && !EMPTY[column.type] && !SCHEMA.enums.has(column.type)
        )
        .map(([name]) => [name, 0])
    );
  }
  return row;
}

/** One capability write a seed performed. */
interface Captured {
  file: string;
  slug: unknown;
  functionDefinition: unknown;
}

const READS = new Set([
  'findUnique',
  'findFirst',
  'findMany',
  'findUniqueOrThrow',
  'findFirstOrThrow',
  'count',
]);
const WRITES = new Set([
  'create',
  'createMany',
  'createManyAndReturn',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'upsert',
  'delete',
  'deleteMany',
]);
/** A seed that writes `aiCapability` this way in its source must be seen writing one. */
const NAMED_CAPABILITY_WRITE =
  /\baiCapability\s*\.\s*(?:create|createMany|createManyAndReturn|update|updateMany|updateManyAndReturn|upsert)\b/;

/**
 * Records a refusal, then throws it. Recorded because a seed that catches its
 * own errors (021 does, per org) would otherwise swallow the throw and pass.
 */
function refuse(file: string, error: string): never {
  globalClient.refusals.push({ file, error });
  throw new Error(error);
}

/** Fails on a capability created or changed through another model's nested write. */
function refuseNestedCapabilityWrite(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, i) => refuseNestedCapabilityWrite(item, `${path}[${i}]`));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (
      // `capability` is the relation to `AiCapability` on its join models
      // (`AiAgentCapability`, the MCP pivot); `capabilities` on `AiAgent` is
      // the join table itself, and creating a binding there is not a capability write.
      key === 'capability' &&
      isRecord(child) &&
      ['create', 'createMany', 'connectOrCreate', 'upsert', 'update', 'updateMany'].some(
        (op) => op in child
      )
    ) {
      refuse(
        globalClient.current,
        `writes a capability through a nested write at ${path}.${key}, not captured`
      );
    }
    refuseNestedCapabilityWrite(child, `${path}.${key}`);
  }
}

/**
 * A STRICT client: only the reads and writes above, and `$transaction`, are
 * modelled — anything else throws, so a seed doing something this cannot see
 * fails rather than passing over it.
 *
 * Every `aiCapability` write is recorded, bulk ones unpacked. Capability
 * lookups answer as `capabilities` says — `'absent'` (nothing exists, so a
 * create-if-missing branch runs) or `'present'` (one row per lookup, so an
 * update-if-exists or update-each branch does). Each seed runs once each way.
 * Other models: a single read returns a row with an id (so a seed that looks
 * up its owner proceeds), a list returns none. A returned row also carries
 * the fields the call selected, as `placeholderRow()` fills them.
 */
function strictClient(
  file: string,
  captured: Captured[],
  capabilities: 'absent' | 'present'
): unknown {
  const record = (args: unknown): void => {
    if (!isRecord(args)) return;
    const where = isRecord(args.where) ? args.where : {};
    const writes: unknown[] = Array.isArray(args.data)
      ? args.data
      : [args.create, args.update, args.data];
    for (const data of writes) {
      if (!isRecord(data) || !('functionDefinition' in data)) continue;
      // An update by id names the slug only through the row it looked up.
      const byId =
        typeof where.id === 'string' && where.id.startsWith(ID_PREFIX)
          ? where.id.slice(ID_PREFIX.length) || undefined
          : undefined;
      captured.push({
        file,
        slug: data.slug ?? where.slug ?? byId,
        functionDefinition: data.functionDefinition,
      });
    }
  };
  const model = (name: string): unknown =>
    new Proxy(
      {},
      {
        get: (_target, method) => {
          if (typeof method !== 'string') return undefined;
          if (!READS.has(method) && !WRITES.has(method)) {
            refuse(file, `called ${name}.${method}, which the parity mock does not model`);
          }
          return (args: unknown) => {
            const where = isRecord(args) && isRecord(args.where) ? args.where : {};
            const rowFor = (slug: unknown) => ({
              ...placeholderRow(name, args),
              id: `${ID_PREFIX}${typeof slug === 'string' ? slug : ''}`,
              // No placeholder `''`: a write keyed on it would hide the id fallback.
              slug: typeof slug === 'string' ? slug : undefined,
            });
            const row = rowFor(where.slug);
            if (WRITES.has(method)) {
              if (name === 'aiCapability') {
                wroteCapability.add(file);
                record(args);
              } else refuseNestedCapabilityWrite(args, `${name}.${method}`);
              if (/Many$/.test(method)) return Promise.resolve({ count: 1 });
              if (/ManyAndReturn$/.test(method)) return Promise.resolve([row]);
              return Promise.resolve(row);
            }
            if (name === 'aiCapability') {
              const present = capabilities === 'present';
              if (method === 'findMany') {
                // One row per slug asked for (`slug: { in: [...] }`), else one.
                const slugs =
                  isRecord(where.slug) && Array.isArray(where.slug.in)
                    ? where.slug.in
                    : [undefined];
                return Promise.resolve(present ? slugs.map(rowFor) : []);
              }
              if (method === 'count') return Promise.resolve(present ? 1 : 0);
              if (/OrThrow$/.test(method) && !present) return Promise.reject(new Error(NOT_FOUND));
              return Promise.resolve(present ? row : null);
            }
            if (method === 'findMany') return Promise.resolve([]);
            if (method === 'count') return Promise.resolve(0);
            return Promise.resolve(row);
          };
        },
      }
    );
  const client: unknown = new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (typeof prop !== 'string' || prop === 'then') return undefined;
        if (prop === '$transaction') {
          return (arg: unknown) =>
            typeof arg === 'function'
              ? Promise.resolve(arg(client))
              : Array.isArray(arg)
                ? Promise.all(arg)
                : Promise.reject(new Error('$transaction with neither a function nor an array'));
        }
        if (prop.startsWith('$')) {
          refuse(file, `called ${prop}, which the parity mock does not model`);
        }
        return model(prop);
      },
    }
  );
  return client;
}

const isSeedUnit = (value: unknown): value is SeedUnit =>
  isRecord(value) && typeof value.run === 'function';

/** Every capability write the seeds made that carried a definition. */
const captured: Captured[] = [];
/** Seeds seen making any `aiCapability` write, with a definition or without. */
const wroteCapability = new Set<string>();
/** Seeds that threw under the mock. */
const failed: { file: string; error: string }[] = [];
/** Seeds whose source writes `aiCapability` by name — each must be seen writing one. */
const namingCapabilityWrite: string[] = [];

// 60s: this imports every seed's module graph, and the 10s hook default is not
// enough on a contended runner.
beforeAll(async () => {
  // EVERY seed runs, not those that look like capability seeds: one that
  // writes through an alias or a helper names no `aiCapability` of its own.
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  for (const file of (await discoverSeedFiles(SEED_DIR, SEED_DIR)).sort()) {
    globalClient.current = file;
    // Comments and string contents blanked, so neither a mention nor a
    // `'image/*'` in a description decides this.
    if (NAMED_CAPABILITY_WRITE.test(maskLiterals(readFileSync(join(SEED_DIR, file), 'utf8')))) {
      namingCapabilityWrite.push(file);
    }
    const mod: unknown = await import(/* @vite-ignore */ join(SEED_DIR, file)).catch(
      (err: unknown) => err
    );
    const unit = isRecord(mod) ? mod.default : undefined;
    if (!isSeedUnit(unit)) {
      failed.push({ file, error: 'does not default-export a SeedUnit' });
      continue;
    }
    // Each mode on its own: an 'absent' run that stops at a not-found must
    // not keep the 'present' run from reaching the update behind it.
    for (const capabilities of ['absent', 'present'] as const) {
      try {
        await unit.run({
          prisma: strictClient(file, captured, capabilities),
          logger,
        } as unknown as SeedContext);
      } catch (err) {
        failed.push({ file, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
}, 60_000);

describe('capabilities — seeded definition matches the class (#545, #646)', () => {
  it('runs every seed through the client it is handed', () => {
    // Floor first, in distinct capabilities — each upsert records create and
    // update, so a count of writes would be met by 019 alone.
    expect(new Set(captured.map((c) => c.slug)).size).toBeGreaterThanOrEqual(24);
    // A seed the mock could not run, or one that used the app's own client,
    // may have written capabilities this never saw. Only UNCHECKED_SEEDS may.
    // (A capability `…OrThrow` that found nothing is not a failure: the seed
    // would throw there in production too, given an empty table.)
    const checked = (file: string) => !UNCHECKED_SEEDS.has(file);
    expect(failed.filter((f) => checked(f.file) && f.error !== NOT_FOUND)).toEqual([]);
    expect([...new Set(globalClient.uses)].filter(checked)).toEqual([]);
    // The mock's refusals, including any a seed caught and carried on past.
    expect(globalClient.refusals.filter((r) => checked(r.file))).toEqual([]);
    // A seed that writes `aiCapability` by name but was seen writing none took
    // a path the mock did not drive (a loop over rows it looked up, which
    // read as empty) — nothing it writes was checked. NOT covered: the same
    // loop calling a helper whose source, not the seed's, names the write.
    // (Any write counts: one that only retires or renames a capability has no
    // definition to check, but it did run.)
    // An unchecked seed is held to this too: one that writes a capability by
    // name does not belong on that list.
    expect(namingCapabilityWrite.filter((file) => !wroteCapability.has(file))).toEqual([]);
    expect(namingCapabilityWrite.filter((file) => UNCHECKED_SEEDS.has(file))).toEqual([]);
  });

  it('pairs every capability the seeds write, and nothing they do not', () => {
    const written = new Set(captured.map((c) => c.slug));
    const paired = new Set(PAIRS.map((p) => p.slug));
    expect(paired.size).toBe(PAIRS.length);
    expect([...written].filter((slug) => typeof slug !== 'string' || !paired.has(slug))).toEqual(
      []
    );
    expect([...paired].filter((slug) => !written.has(slug))).toEqual([]);
  });

  it.each(PAIRS)('$slug', ({ slug, instance }) => {
    const writes = captured.filter((c) => c.slug === slug);
    expect(writes.length).toBeGreaterThan(0);
    for (const write of writes) {
      expect(write.functionDefinition).toEqual(instance.functionDefinition);
    }
    expect(instance.functionDefinition).toMatchObject({ name: slug });
  });
});

describe('the strict mock answers a read with the fields it asked for (#1070)', () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const run = (seed: SeedUnit['run']) =>
    seed({
      prisma: strictClient('probe.ts', [], 'present'),
      logger,
    } as unknown as SeedContext);

  it('fills a select, so a seed can call string methods on what it selected', async () => {
    let seen: Record<string, unknown> = {};
    await run(async ({ prisma }) => {
      const row = await prisma.aiCapability.findUnique({
        where: { slug: 'probe' },
        select: { name: true, description: true },
      });
      if (!row) throw new Error('no row');
      seen = { ...row, renamed: row.name.replace(/^/, 'x'), trimmed: row.description.trim() };
    });
    expect(seen).toMatchObject({ name: '', description: '', renamed: 'x', trimmed: '' });
    // Only what was selected, plus the id and slug the mock records writes by.
    expect(Object.keys(seen).sort()).toEqual(
      ['description', 'id', 'name', 'renamed', 'slug', 'trimmed'].sort()
    );
  });

  it('fills every scalar when nothing is selected, by type', async () => {
    let seen: Record<string, unknown> = {};
    await run(async ({ prisma }) => {
      seen = { ...(await prisma.aiCapability.findFirst({ where: { slug: 'probe' } })) };
    });
    expect(seen).toMatchObject({
      slug: 'probe',
      name: '',
      functionDefinition: {},
      requiresApproval: false,
      approvalTimeoutMs: null,
      quarantineUntil: null,
    });
  });

  it("answers another model's select, enum and _count", async () => {
    let seen: Record<string, unknown> = {};
    await run(async ({ prisma }) => {
      const user = await prisma.user.findUnique({
        where: { id: 'u' },
        select: {
          email: true,
          accountType: true,
          createdAt: true,
          _count: { select: { accounts: true } },
        },
      });
      if (!user) throw new Error('no row');
      seen = { ...user, accounts: user._count.accounts };
    });
    expect(seen).toMatchObject({
      email: '',
      accountType: expect.any(String),
      createdAt: new Date(0),
      accounts: 0,
    });
  });
});
