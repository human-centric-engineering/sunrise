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
 * Each capability seed now runs against a recording mock client, and what it
 * actually writes is what gets checked, however the seed is written.
 *
 * ---------------------------------------------------------------------------
 * FORK NOTE — your capability seeds are run here too
 * ---------------------------------------------------------------------------
 * Every seed under `prisma/seeds/` that writes an `aiCapability` is run,
 * yours included, and each capability it writes needs a pair. Declare yours in
 * `lib/app/capability-seed-pairs.ts` (`APP_CAPABILITY_PAIRS`, spread into
 * `PAIRS` below) — do not add rows to `PAIRS`, which is Sunrise's and a merge
 * conflict on every upgrade. A seed must write through the `prisma` it is
 * handed (as the runner requires anyway); one that reaches for the global
 * client writes nothing here and fails "captures a write from every
 * capability seed".
 *
 * @see .context/database/seeding.md — the seed ownership rule
 * @see lib/app/capability-seed-pairs.ts — where a fork's pairs go
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, it, expect, vi, beforeAll } from 'vitest';

// The app's own client, for a seed that bypasses the one it is handed: any use
// throws, so such a seed fails here instead of reaching a configured database.
vi.mock('@/lib/db/client', () => {
  const refuse = new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (prop === 'then') return undefined;
        throw new Error(`a capability seed used the global Prisma client (.${String(prop)})`);
      },
    }
  );
  return { prisma: refuse, default: refuse };
});

import type { SeedContext, SeedUnit } from '@/prisma/runner';
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
  // so a hand-written row here could only restate the seed's own list.
  ...CLEANUP_CAPABILITIES.map(({ capability }) => ({
    slug: capability.slug,
    instance: capability,
  })),
  ...APP_CAPABILITY_PAIRS,
];

const SEED_DIR = join(process.cwd(), 'prisma', 'seeds');
/** The runner's own pattern (`prisma/runner.ts`) — anything else is not a unit. */
const SEED_FILE = /^\d{3}-[a-z0-9-]+\.ts$/;

/** Every seed unit, recursively — the runner discovers fork seeds the same way. */
function seedFiles(dir: string, prefix = ''): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return seedFiles(join(dir, entry.name), rel);
    return SEED_FILE.test(entry.name) ? [rel] : [];
  });
}

/** One capability write a seed performed. */
interface Captured {
  file: string;
  slug: unknown;
  functionDefinition: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/**
 * A client that records `aiCapability` writes and answers everything else
 * with an inert value: no capability row exists, any other single read or
 * write returns a row with an id (so a seed that looks up its owner proceeds),
 * `[]` for lists, `0` for counts, and `$transaction(fn)` runs `fn` against the
 * same client.
 */
function recordingClient(file: string, captured: Captured[], touched: Set<string>): unknown {
  const record = (method: string, args: unknown): void => {
    if (!isRecord(args)) return;
    const where = isRecord(args.where) ? args.where : {};
    const writes: unknown[] =
      method === 'createMany' && Array.isArray(args.data)
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
          return (args: unknown) => {
            if (name === 'aiCapability') {
              touched.add(file);
              record(method, args);
              // No capability exists yet, so a seed's create-if-missing
              // branch runs and is captured rather than skipped.
              if (/^find/.test(method)) return Promise.resolve(method === 'findMany' ? [] : null);
            }
            if (method === 'findMany' || method === 'groupBy') return Promise.resolve([]);
            if (method === 'count') return Promise.resolve(0);
            return Promise.resolve({ id: 'parity-mock-id' });
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
            typeof arg === 'function' ? Promise.resolve(arg(client)) : Promise.resolve([]);
        }
        if (prop.startsWith('$')) return () => Promise.resolve([]);
        return model(prop);
      },
    }
  );
  return client;
}

const isSeedUnit = (value: unknown): value is SeedUnit =>
  isRecord(value) && typeof value.run === 'function';

/** Seeds that write capabilities, and every capability write they made. */
let capabilitySeeds: string[] = [];
const captured: Captured[] = [];
/** Seeds that called anything on `aiCapability` through the client they were handed. */
const touched = new Set<string>();

beforeAll(async () => {
  // A seed that never calls `aiCapability.…(` cannot write one through the
  // client it is handed, and running every seed is not safe: `007` ignores
  // that client and writes through the app's own (stubbed above to throw).
  capabilitySeeds = seedFiles(SEED_DIR).filter((file) =>
    /\baiCapability\s*\.\s*\w+\s*\(/.test(readFileSync(join(SEED_DIR, file), 'utf8'))
  );
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  for (const file of capabilitySeeds) {
    const mod: unknown = await import(/* @vite-ignore */ join(SEED_DIR, file));
    const unit = isRecord(mod) ? mod.default : undefined;
    if (!isSeedUnit(unit)) throw new Error(`${file} does not default-export a SeedUnit`);
    await unit.run({
      prisma: recordingClient(file, captured, touched),
      logger,
    } as unknown as SeedContext);
  }
});

describe('capabilities — seeded definition matches the class (#545, #646)', () => {
  it('captures the capability seeds through the client they are handed', () => {
    // Floor first, in distinct capabilities — each upsert records create and
    // update, so a count of writes would be met by 019 alone. An earlier
    // version read zero names through a regex bug and passed.
    expect(new Set(captured.map((c) => c.slug)).size).toBeGreaterThanOrEqual(24);
    // A seed that calls `aiCapability` in its source but touched nothing here
    // did it through some other client, so nothing it writes would be checked.
    // (One that only reads capabilities is fine — it touched the mock.)
    expect(capabilitySeeds.filter((file) => !touched.has(file))).toEqual([]);
  });

  it('pairs every capability the seeds write, and nothing they do not', () => {
    const written = new Set(captured.map((c) => c.slug));
    const paired = new Set(PAIRS.map((p) => p.slug));
    expect(new Set(PAIRS.map((p) => p.slug)).size).toBe(PAIRS.length);
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
