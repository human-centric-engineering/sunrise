import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, it, expect, vi } from 'vitest';

import cleanupCapabilitiesSeed, {
  CLEANUP_CAPABILITIES,
} from '@/prisma/seeds/019-cleanup-capabilities';
import type { SeedContext } from '@/prisma/runner';

/**
 * Tests for the `019-cleanup-capabilities` seed.
 *
 * The contract this seed must hold — and the one #545 exists to guard
 * everywhere else in `prisma/seeds/` (see
 * `tests/unit/prisma/seeds/capability-code-owned-fields.test.ts`, which
 * checks this file's source text but never runs it): every upsert's
 * `update` branch re-applies the code-owned fields (`functionDefinition`,
 * `executionType`, `executionHandler`), not just `create`. This test runs
 * the seed and asserts the actual call shape rather than the source text.
 */

const CLEANUP_SLUGS = [
  'read_document',
  'find_in_document',
  'join_wrapped_lines',
  'strip_lines_matching',
  'strip_matches',
  'strip_timestamps',
  'strip_speaker_labels',
  'collapse_whitespace',
  'dedupe_lines',
  'normalise_punctuation',
  'preview_diff',
  'estimate_size',
  'rewrite_with_llm',
  'rewrite_section_with_llm',
];

function makeCtx() {
  const upsert = vi.fn().mockResolvedValue({});
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

  const ctx = {
    prisma: { aiCapability: { upsert } },
    logger,
  } as unknown as SeedContext;

  return { ctx, upsert, logger };
}

describe('019-cleanup-capabilities seed', () => {
  it('upserts exactly the documented capability slugs', async () => {
    const { ctx, upsert } = makeCtx();

    await cleanupCapabilitiesSeed.run(ctx);

    expect(upsert).toHaveBeenCalledTimes(CLEANUP_SLUGS.length);
    const slugs = upsert.mock.calls.map((call) => call[0].where.slug);
    expect(slugs.sort()).toEqual([...CLEANUP_SLUGS].sort());
  });

  it('re-applies functionDefinition, executionType and executionHandler on update, not just create', async () => {
    const { ctx, upsert } = makeCtx();

    await cleanupCapabilitiesSeed.run(ctx);

    for (const call of upsert.mock.calls) {
      const { update, create } = call[0];
      for (const field of ['functionDefinition', 'executionType', 'executionHandler']) {
        expect(update).toHaveProperty(field);
        expect(create).toHaveProperty(field);
        expect(update[field]).toEqual(create[field]);
      }
      // isSystem re-applies on update; operator-owned fields do not.
      expect(update.isSystem).toBe(true);
      expect(update).not.toHaveProperty('isActive');
      expect(update).not.toHaveProperty('rateLimit');
      expect(update).not.toHaveProperty('name');
    }
  });

  it("sets a deterministic capability's category, handler and JSON schema", async () => {
    const { ctx, upsert } = makeCtx();

    await cleanupCapabilitiesSeed.run(ctx);

    const call = upsert.mock.calls.find((c) => c[0].where.slug === 'strip_lines_matching');
    expect(call?.[0].create).toMatchObject({
      category: 'document_cleanup',
      executionType: 'internal',
      executionHandler: 'StripLinesMatchingCapability',
      isActive: true,
      isSystem: true,
    });
    expect(call?.[0].create.functionDefinition).toMatchObject({
      name: 'strip_lines_matching',
      parameters: { type: 'object', required: ['regex'] },
    });
  });

  it("sets an LLM-backed capability's handler and rate limit", async () => {
    const { ctx, upsert } = makeCtx();

    await cleanupCapabilitiesSeed.run(ctx);

    const call = upsert.mock.calls.find((c) => c[0].where.slug === 'rewrite_with_llm');
    expect(call?.[0].create).toMatchObject({
      executionHandler: 'RewriteWithLlmCapability',
      rateLimit: 6,
    });
  });

  it('hashes every class file a seeded definition is read from', () => {
    // The definitions live in the classes, and the runner re-seeds only when
    // the unit's hash moves. A class missing here could change its schema and
    // leave every existing row advertising the old one.
    const seedDir = join(process.cwd(), 'prisma', 'seeds');
    const hashed = (cleanupCapabilitiesSeed.hashInputs ?? []).map((rel) =>
      readFileSync(join(seedDir, rel), 'utf8')
    );
    const unhashed = CLEANUP_CAPABILITIES.map((cap) => cap.capability.constructor.name).filter(
      (handler) => !hashed.some((src) => src.includes(`export class ${handler} `))
    );
    expect(unhashed).toEqual([]);
  });

  it('declares the expected seed unit name', () => {
    expect(cleanupCapabilitiesSeed.name).toBe('019-cleanup-capabilities');
  });
});
