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
 *    it catches the error. Only `GLOBAL_CLIENT_SEEDS` may, each with a reason.
 *  - A seed whose source writes `aiCapability` by name but was seen writing
 *    none: its writes sit behind a path the mock did not drive.
 *
 * @see .context/database/seeding.md — the seed ownership rule
 * @see lib/app/capability-seed-pairs.ts — where a fork's pairs go
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, it, expect, vi, beforeAll } from 'vitest';

/**
 * The app's own client, for a seed that bypasses the one it is handed. Any use
 * throws, and is RECORDED first — a seed that catches its own errors (021 does,
 * per org) would otherwise swallow the throw and pass.
 */
const globalClient = vi.hoisted(() => ({ current: '', uses: [] as string[] }));
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

import { discoverSeedFiles, type SeedContext, type SeedUnit } from '@/prisma/runner';
import { isRecord } from '@/lib/utils';
import { APP_CAPABILITY_PAIRS, type AppCapabilityPair } from '@/lib/app/capability-seed-pairs';
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
 * Seeds allowed to use the app's own client, each with its reason. Everything
 * else that touches it fails — whatever a seed does through that client is
 * invisible here, capability writes included.
 */
const GLOBAL_CLIENT_SEEDS: ReadonlyMap<string, string> = new Map([
  [
    '007-knowledge-chunks.ts',
    'seeds the patterns knowledge through seedChunks(), which writes with the app client; ' +
      'it writes no capability',
  ],
]);

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
      throw new Error(`writes a capability through a nested write at ${path}.${key}, not captured`);
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
 * up its owner proceeds), a list returns none.
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
      captured.push({
        file,
        slug: data.slug ?? where.slug,
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
            throw new Error(`called ${name}.${method}, which the parity mock does not model`);
          }
          return (args: unknown) => {
            const where = isRecord(args) && isRecord(args.where) ? args.where : {};
            const row = {
              id: 'parity-mock-id',
              slug: typeof where.slug === 'string' ? where.slug : undefined,
            };
            if (WRITES.has(method)) {
              if (name === 'aiCapability') record(args);
              else refuseNestedCapabilityWrite(args, `${name}.${method}`);
              if (/Many$/.test(method)) return Promise.resolve({ count: 1 });
              if (/ManyAndReturn$/.test(method)) return Promise.resolve([row]);
              return Promise.resolve(row);
            }
            if (name === 'aiCapability' && !/OrThrow$/.test(method)) {
              const present = capabilities === 'present';
              if (method === 'findMany') return Promise.resolve(present ? [row] : []);
              if (method === 'count') return Promise.resolve(present ? 1 : 0);
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
          throw new Error(`called ${prop}, which the parity mock does not model`);
        }
        return model(prop);
      },
    }
  );
  return client;
}

const isSeedUnit = (value: unknown): value is SeedUnit =>
  isRecord(value) && typeof value.run === 'function';

/** Every capability write the seeds made. */
const captured: Captured[] = [];
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
    if (NAMED_CAPABILITY_WRITE.test(readFileSync(join(SEED_DIR, file), 'utf8'))) {
      namingCapabilityWrite.push(file);
    }
    try {
      const mod: unknown = await import(/* @vite-ignore */ join(SEED_DIR, file));
      const unit = isRecord(mod) ? mod.default : undefined;
      if (!isSeedUnit(unit)) throw new Error('does not default-export a SeedUnit');
      for (const capabilities of ['absent', 'present'] as const) {
        await unit.run({
          prisma: strictClient(file, captured, capabilities),
          logger,
        } as unknown as SeedContext);
      }
    } catch (err) {
      failed.push({ file, error: err instanceof Error ? err.message : String(err) });
    }
  }
}, 60_000);

describe('capabilities — seeded definition matches the class (#545, #646)', () => {
  it('runs every seed through the client it is handed', () => {
    // Floor first, in distinct capabilities — each upsert records create and
    // update, so a count of writes would be met by 019 alone.
    expect(new Set(captured.map((c) => c.slug)).size).toBeGreaterThanOrEqual(24);
    // A seed the mock could not run, or one that used the app's own client,
    // may have written capabilities this never saw. Only the allow-listed
    // seeds may do either, and only by way of that client.
    const allowed = (file: string, error?: string) =>
      GLOBAL_CLIENT_SEEDS.has(file) && (error === undefined || error.startsWith('used the global'));
    expect(failed.filter((f) => !allowed(f.file, f.error))).toEqual([]);
    expect([...new Set(globalClient.uses)].filter((file) => !allowed(file))).toEqual([]);
    // A seed that writes `aiCapability` by name but was seen writing none took
    // a path the mock did not drive (a loop over rows it looked up, which
    // read as empty) — nothing it writes was checked.
    const wrote = new Set(captured.map((c) => c.file));
    expect(namingCapabilityWrite.filter((file) => !wrote.has(file))).toEqual([]);
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
