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

import type { SeedContext, SeedUnit } from '@/prisma/runner';
import { APP_CAPABILITY_PAIRS, type AppCapabilityPair } from '@/lib/app/capability-seed-pairs';

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
import { CollapseWhitespaceCapability } from '@/lib/orchestration/capabilities/built-in/document-cleanup/collapse-whitespace';
import { DedupeLinesCapability } from '@/lib/orchestration/capabilities/built-in/document-cleanup/dedupe-lines';
import { EstimateSizeCapability } from '@/lib/orchestration/capabilities/built-in/document-cleanup/estimate-size';
import { FindInDocumentCapability } from '@/lib/orchestration/capabilities/built-in/document-cleanup/find-in-document';
import { JoinWrappedLinesCapability } from '@/lib/orchestration/capabilities/built-in/document-cleanup/join-wrapped-lines';
import { NormalisePunctuationCapability } from '@/lib/orchestration/capabilities/built-in/document-cleanup/normalise-punctuation';
import { PreviewDiffCapability } from '@/lib/orchestration/capabilities/built-in/document-cleanup/preview-diff';
import { ReadDocumentCapability } from '@/lib/orchestration/capabilities/built-in/document-cleanup/read-document';
import { RewriteSectionWithLlmCapability } from '@/lib/orchestration/capabilities/built-in/document-cleanup/rewrite-section-with-llm';
import { RewriteWithLlmCapability } from '@/lib/orchestration/capabilities/built-in/document-cleanup/rewrite-with-llm';
import { StripLinesMatchingCapability } from '@/lib/orchestration/capabilities/built-in/document-cleanup/strip-lines-matching';
import { StripMatchesCapability } from '@/lib/orchestration/capabilities/built-in/document-cleanup/strip-matches';
import { StripSpeakerLabelsCapability } from '@/lib/orchestration/capabilities/built-in/document-cleanup/strip-speaker-labels';
import { StripTimestampsCapability } from '@/lib/orchestration/capabilities/built-in/document-cleanup/strip-timestamps';

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
  // 019 takes these definitions from the classes themselves, so for them the
  // comparison below holds by construction; the rows still pin which class
  // each slug is seeded from.
  { slug: 'collapse_whitespace', instance: new CollapseWhitespaceCapability() },
  { slug: 'dedupe_lines', instance: new DedupeLinesCapability() },
  { slug: 'estimate_size', instance: new EstimateSizeCapability() },
  { slug: 'find_in_document', instance: new FindInDocumentCapability() },
  { slug: 'join_wrapped_lines', instance: new JoinWrappedLinesCapability() },
  { slug: 'normalise_punctuation', instance: new NormalisePunctuationCapability() },
  { slug: 'preview_diff', instance: new PreviewDiffCapability() },
  { slug: 'read_document', instance: new ReadDocumentCapability() },
  { slug: 'rewrite_section_with_llm', instance: new RewriteSectionWithLlmCapability() },
  { slug: 'rewrite_with_llm', instance: new RewriteWithLlmCapability() },
  { slug: 'strip_lines_matching', instance: new StripLinesMatchingCapability() },
  { slug: 'strip_matches', instance: new StripMatchesCapability() },
  { slug: 'strip_speaker_labels', instance: new StripSpeakerLabelsCapability() },
  { slug: 'strip_timestamps', instance: new StripTimestampsCapability() },
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
 * with an inert value: a row with an id for single reads and writes (so a seed
 * that looks up its owner proceeds), `[]` for lists, `0` for counts, and
 * `$transaction(fn)` runs `fn` against the same client.
 */
function recordingClient(file: string, captured: Captured[]): unknown {
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
            if (name === 'aiCapability') record(method, args);
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

beforeAll(async () => {
  // A seed that never names `aiCapability` cannot write one through the
  // client it is handed, and running every seed is not safe: `007` ignores
  // that client and writes through the app's own, which here would be a real
  // database if one is configured.
  capabilitySeeds = seedFiles(SEED_DIR).filter((file) =>
    readFileSync(join(SEED_DIR, file), 'utf8').includes('aiCapability')
  );
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  for (const file of capabilitySeeds) {
    const mod: unknown = await import(/* @vite-ignore */ join(SEED_DIR, file));
    const unit = isRecord(mod) ? mod.default : undefined;
    if (!isSeedUnit(unit)) throw new Error(`${file} does not default-export a SeedUnit`);
    await unit.run({ prisma: recordingClient(file, captured), logger } as unknown as SeedContext);
  }
});

describe('capabilities — seeded definition matches the class (#545, #646)', () => {
  it('captures a write from every capability seed', () => {
    // Floor first. A derived expectation needs its own non-emptiness check:
    // an earlier version read zero names through a regex bug and passed.
    expect(captured.length).toBeGreaterThanOrEqual(24);
    // A seed that names `aiCapability` but records nothing wrote through some
    // other client, so nothing it writes would be checked.
    const silent = capabilitySeeds.filter((file) => !captured.some((c) => c.file === file));
    expect(silent).toEqual([]);
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
