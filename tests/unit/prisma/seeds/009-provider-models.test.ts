/**
 * Tests for the `009-provider-models` seed's pricing (t-774).
 *
 * Runs the seed unit against a mock context and reads what it upserts, so
 * the assertions are about the rows a database would receive:
 *  - a hosted chat row carries its published input and output prices;
 *  - its blended `costPerMillionTokens` stays the mean of the two, the
 *    fallback a row without the split uses;
 *  - embedding rows carry only the single rate;
 *  - re-seeding writes the split to a seed-managed row, and never touches a
 *    row an admin has edited.
 */

import { describe, it, expect, vi } from 'vitest';

import providerModelsSeed, {
  NOT_SERVED_SLUG_SUFFIX,
  RETIRED_SEED_MODELS,
  SEED_RETIREMENT_DAY,
} from '@/prisma/seeds/009-provider-models';
import type { SeedContext } from '@/prisma/runner';
import { KNOWN_PROVIDERS } from '@/lib/orchestration/llm/known-providers';

interface UpsertArgs {
  where: { slug: string };
  update: Record<string, unknown>;
  create: Record<string, unknown>;
}

/** A catalogue row as the seed reads one back. */
interface StoredRow {
  id?: string;
  slug?: string;
  name?: string;
  providerSlug?: string;
  modelId?: string;
  capabilities?: string[];
  isActive?: boolean;
  isDefault: boolean;
  retiresAt?: Date | null;
  replacementId?: string | null;
}

interface LookupWhere {
  id?: string;
  slug?: string;
  providerSlug_modelId?: { providerSlug: string; modelId: string };
}

/**
 * Run the seed over a mock database. `existing` answers the per-slug reads;
 * `byModelId` the reads by provider and model id (the unique-id guard and
 * the retirement's replacement lookup), keyed `provider/modelId`.
 */
async function runSeed(
  existing: (slug: string) => StoredRow | null = () => null,
  byModelId: Record<string, StoredRow> = {}
) {
  const upsert = vi.fn().mockResolvedValue({});
  const update = vi.fn().mockResolvedValue({});
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const ctx = {
    prisma: {
      user: { findFirst: vi.fn().mockResolvedValue({ id: 'system-owner' }) },
      aiProviderModel: {
        findUnique: vi.fn(({ where }: { where: LookupWhere }) => {
          if (where.id) {
            return Promise.resolve(
              Object.values(byModelId).find((row) => row.id === where.id) ?? null
            );
          }
          if (where.providerSlug_modelId) {
            const { providerSlug, modelId } = where.providerSlug_modelId;
            return Promise.resolve(byModelId[`${providerSlug}/${modelId}`] ?? null);
          }
          return Promise.resolve(where.slug ? existing(where.slug) : null);
        }),
        findFirst: vi.fn(
          ({
            where,
          }: {
            where: { providerSlug: string; modelId: string; slug: { not: string } };
          }) => {
            const row = byModelId[`${where.providerSlug}/${where.modelId}`];
            return Promise.resolve(row && row.slug !== where.slug.not ? row : null);
          }
        ),
        upsert,
        update,
      },
    },
    logger,
  } as unknown as SeedContext;

  await providerModelsSeed.run(ctx);

  const rows = new Map<string, UpsertArgs>();
  for (const [args] of upsert.mock.calls as Array<[UpsertArgs]>) rows.set(args.where.slug, args);
  return { rows, upsert, update, logger };
}

describe('009-provider-models seed — pricing (t-774)', () => {
  it('writes published input and output prices on hosted chat rows', async () => {
    const { rows } = await runSeed();

    expect(rows.get('openai-gpt-4o-mini')?.create).toMatchObject({
      inputCostPerMillionTokens: 0.15,
      outputCostPerMillionTokens: 0.6,
    });
    expect(rows.get('anthropic-claude-opus-4-6')?.create).toMatchObject({
      inputCostPerMillionTokens: 5,
      outputCostPerMillionTokens: 25,
    });
  });

  it('keeps every split row’s blended rate equal to the mean of its two prices', async () => {
    const { rows } = await runSeed();
    const split = [...rows.values()].filter((r) => r.create.inputCostPerMillionTokens !== null);

    // The seed's hosted chat rows; a regression that drops the split from
    // the upsert data would leave this empty.
    expect(split.length).toBeGreaterThanOrEqual(20);
    for (const row of split) {
      const input = row.create.inputCostPerMillionTokens as number;
      const output = row.create.outputCostPerMillionTokens as number;
      expect(row.create.costPerMillionTokens, row.where.slug).toBeCloseTo((input + output) / 2);
    }
  });

  it('never writes half a price', async () => {
    const { rows } = await runSeed();

    for (const row of rows.values()) {
      const hasInput = row.create.inputCostPerMillionTokens !== null;
      const hasOutput = row.create.outputCostPerMillionTokens !== null;
      expect(hasInput, row.where.slug).toBe(hasOutput);
    }
  });

  it('leaves embedding rows on their single rate', async () => {
    const { rows } = await runSeed();
    const embedding = [...rows.values()].filter((r) =>
      (r.create.capabilities as string[]).includes('embedding')
    );

    expect(embedding.length).toBeGreaterThan(0);
    for (const row of embedding) {
      expect(row.create.inputCostPerMillionTokens, row.where.slug).toBeNull();
      expect(row.create.outputCostPerMillionTokens, row.where.slug).toBeNull();
    }
  });

  it('writes the split prices to a seed-managed row on re-seed', async () => {
    const { rows } = await runSeed(() => ({ isDefault: true }));

    expect(rows.get('openai-gpt-4o-mini')?.update).toMatchObject({
      inputCostPerMillionTokens: 0.15,
      outputCostPerMillionTokens: 0.6,
      isDefault: true,
    });
  });

  it('does not touch a row an admin has edited', async () => {
    const { rows } = await runSeed((slug) =>
      slug === 'openai-gpt-4o-mini' ? { isDefault: false } : null
    );

    expect(rows.has('openai-gpt-4o-mini')).toBe(false);
    expect(rows.has('openai-gpt-4o')).toBe(true);
  });
});

describe('009-provider-models seed — local embedding rows (t-1011)', () => {
  it('files the Ollama embedding models under the slug an Ollama provider is given', async () => {
    // A picked embedding model is used only through an active provider whose
    // slug is the row's `providerSlug`. The provider form and the setup wizard
    // create Ollama as `ollama-local`; rows under any other slug could be
    // picked, and every embedding then failed.
    const ollama = KNOWN_PROVIDERS.find((p) => p.defaultBaseUrl === 'http://localhost:11434/v1');
    expect(ollama?.slug).toBe('ollama-local');
    const { rows } = await runSeed();
    for (const slug of ['ollama-nomic-embed-text', 'ollama-mxbai-embed-large']) {
      expect(rows.get(slug)?.create.providerSlug).toBe(ollama?.slug);
      expect(rows.get(slug)?.update.providerSlug).toBe(ollama?.slug);
    }
  });
});

describe('009-provider-models seed — model ids the vendors serve (t-1041)', () => {
  const seeded = async () => [...(await runSeed()).rows.values()].map((r) => r.create);
  const DAY = new Date(`${SEED_RETIREMENT_DAY}T00:00:00.000Z`);

  /** A seed-managed row as an install already has it. */
  function stored(over: Partial<StoredRow> & { id: string; providerSlug: string }): StoredRow {
    return {
      name: over.id,
      capabilities: ['chat', 'vision', 'documents'],
      isActive: true,
      isDefault: true,
      retiresAt: null,
      replacementId: null,
      ...over,
    };
  }

  /** The retirement writes, as `{ id → data }`; the move-aside renames are by slug. */
  function retirements(update: ReturnType<typeof vi.fn>) {
    return Object.fromEntries(
      (update.mock.calls as Array<[{ where: { id?: string }; data: Record<string, unknown> }]>)
        .filter(([args]) => args.where.id)
        .map(([args]) => [args.where.id, args.data])
    );
  }

  it('seeds every Anthropic model under an id in the API’s form: hyphens, no dots', async () => {
    const anthropic = (await seeded()).filter((r) => r.providerSlug === 'anthropic');

    expect(anthropic.map((r) => r.modelId)).toEqual([
      'claude-opus-4-6',
      'claude-sonnet-4-6',
      'claude-haiku-4-5',
    ]);
    for (const row of anthropic) {
      // `claude-<family>-<major>-<minor>[-<yyyymmdd>]`: a dotted or
      // unversioned id (`claude-haiku-4.5`, `claude-opus-4`) fails here.
      expect(row.modelId, String(row.modelId)).toMatch(/^claude-[a-z]+-\d+-\d+(-\d{8})?$/);
    }
  });

  it('never seeds a model its vendor does not serve, and seeds each one’s replacement', async () => {
    const ids = (await seeded()).map((r) => `${String(r.providerSlug)}/${String(r.modelId)}`);

    for (const { providerSlug, modelId, replacementModelId } of RETIRED_SEED_MODELS) {
      expect(ids).not.toContain(`${providerSlug}/${modelId}`);
      expect(ids).toContain(`${providerSlug}/${replacementModelId}`);
    }
  });

  it('writes nothing to a fresh install beyond its own rows', async () => {
    const { update } = await runSeed();
    expect(update).not.toHaveBeenCalled();
  });

  it('retires an existing seed-managed row with its replacement, turned off', async () => {
    const replacement = stored({
      id: 'row-sonnet-4-6',
      slug: 'anthropic-claude-sonnet-4-6',
      providerSlug: 'anthropic',
    });
    const { update, logger } = await runSeed(() => null, {
      'anthropic/claude-sonnet-4': stored({
        id: 'row-sonnet-4',
        slug: 'anthropic-claude-sonnet-4',
        providerSlug: 'anthropic',
      }),
      'anthropic/claude-sonnet-4-6': replacement,
    });

    expect(retirements(update)).toEqual({
      'row-sonnet-4': { retiresAt: DAY, replacementId: 'row-sonnet-4-6', isActive: false },
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('moves the dotted Haiku row aside, so the corrected row can take its slug, and retires it', async () => {
    // Pins still name `claude-haiku-4.5`: renaming the row's id in place would
    // leave them matching no row, unseen by the model page and the move.
    const dotted = stored({
      id: 'row-haiku-dotted',
      slug: 'anthropic-claude-haiku-4-5',
      providerSlug: 'anthropic',
    });
    const corrected = stored({
      id: 'row-haiku',
      slug: 'anthropic-claude-haiku-4-5',
      providerSlug: 'anthropic',
    });

    const { update, upsert, rows } = await runSeed(() => null, {
      'anthropic/claude-haiku-4.5': dotted,
      'anthropic/claude-haiku-4-5': corrected,
    });

    expect(update).toHaveBeenNthCalledWith(1, {
      where: { slug: 'anthropic-claude-haiku-4-5' },
      data: { slug: `anthropic-claude-haiku-4-5${NOT_SERVED_SLUG_SUFFIX}` },
    });
    // Moved aside before the corrected row is written under the slug.
    const haikuUpsert = (upsert.mock.calls as Array<[UpsertArgs]>).findIndex(
      ([args]) => args.where.slug === 'anthropic-claude-haiku-4-5'
    );
    expect(update.mock.invocationCallOrder[0]).toBeLessThan(
      upsert.mock.invocationCallOrder[haikuUpsert]
    );
    expect(rows.get('anthropic-claude-haiku-4-5')?.create.modelId).toBe('claude-haiku-4-5');
    expect(retirements(update)['row-haiku-dotted']).toEqual({
      retiresAt: DAY,
      replacementId: 'row-haiku',
      isActive: false,
    });
  });

  it('keeps a retirement day and successor already recorded, while the successor qualifies', async () => {
    // The provider audit recorded the vendor's own day and an admin's row.
    const vendorDay = new Date('2026-06-15T00:00:00.000Z');
    const { update } = await runSeed(() => null, {
      'anthropic/claude-opus-4': stored({
        id: 'row-opus-4',
        slug: 'anthropic-claude-opus-4',
        providerSlug: 'anthropic',
        retiresAt: vendorDay,
        replacementId: 'row-opus-4-5',
      }),
      'anthropic/claude-opus-4-5': stored({
        id: 'row-opus-4-5',
        slug: 'anthropic-claude-opus-4-5',
        providerSlug: 'anthropic',
        isDefault: false,
      }),
    });

    expect(retirements(update)['row-opus-4']).toEqual({
      retiresAt: vendorDay,
      replacementId: 'row-opus-4-5',
      isActive: false,
    });
  });

  it('brings a recorded day later than the seed’s forward: a model that fails now is retired, not retiring', async () => {
    const { update } = await runSeed(() => null, {
      'anthropic/claude-sonnet-4': stored({
        id: 'row-sonnet-4',
        slug: 'anthropic-claude-sonnet-4',
        providerSlug: 'anthropic',
        retiresAt: new Date('2027-03-01T00:00:00.000Z'),
      }),
      'anthropic/claude-sonnet-4-6': stored({
        id: 'row-sonnet-4-6',
        slug: 'anthropic-claude-sonnet-4-6',
        providerSlug: 'anthropic',
      }),
    });

    expect(retirements(update)['row-sonnet-4']).toMatchObject({ retiresAt: DAY, isActive: false });
  });

  it('moves the row aside under its own id when the plain not-served slug is taken', async () => {
    const plain = `anthropic-claude-haiku-4-5${NOT_SERVED_SLUG_SUFFIX}`;
    const { update } = await runSeed(
      (slug) => (slug === plain ? { id: 'someone-else', isDefault: false } : null),
      {
        'anthropic/claude-haiku-4.5': stored({
          id: 'row-haiku-dotted',
          slug: 'anthropic-claude-haiku-4-5',
          providerSlug: 'anthropic',
        }),
      }
    );

    expect(update).toHaveBeenNthCalledWith(1, {
      where: { slug: 'anthropic-claude-haiku-4-5' },
      data: { slug: `${plain}-row-haiku-dotted` },
    });
  });

  it('writes nothing when a row is already retired as it would be', async () => {
    const { update } = await runSeed(() => null, {
      'openai/o3-mini': stored({
        id: 'row-o3-mini',
        slug: 'openai-o3-mini',
        providerSlug: 'openai',
        capabilities: ['reasoning'],
        isActive: false,
        retiresAt: DAY,
        replacementId: 'row-o3',
      }),
      'openai/o3': stored({
        id: 'row-o3',
        slug: 'openai-o3',
        providerSlug: 'openai',
        capabilities: ['reasoning'],
      }),
    });

    expect(retirements(update)).toEqual({});
  });

  it('retires a row with no replacement when the replacement no longer qualifies, and says why', async () => {
    const { update, logger } = await runSeed(() => null, {
      'openai/o3-mini': stored({
        id: 'row-o3-mini',
        slug: 'openai-o3-mini',
        providerSlug: 'openai',
        capabilities: ['reasoning'],
      }),
      // An admin turned o3 off.
      'openai/o3': stored({
        id: 'row-o3',
        slug: 'openai-o3',
        providerSlug: 'openai',
        capabilities: ['reasoning'],
        isActive: false,
        isDefault: false,
      }),
    });

    expect(retirements(update)['row-o3-mini']).toEqual({
      retiresAt: DAY,
      replacementId: null,
      isActive: false,
    });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Retiring openai-o3-mini without a replacement: o3')
    );
  });

  it('leaves a row an admin has edited as they left it, and says it is not served', async () => {
    const { update, logger } = await runSeed(() => null, {
      'anthropic/claude-opus-4': stored({
        id: 'row-opus-4',
        slug: 'anthropic-claude-opus-4',
        providerSlug: 'anthropic',
        isDefault: false,
      }),
    });
    expect(update).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'Provider model anthropic-claude-opus-4 (anthropic claude-opus-4) is not served by its vendor, but an admin has edited it'
      )
    );
  });

  it('skips a model whose id another row holds, says why, and retires the dotted row onto that row', async () => {
    // An admin added Haiku 4.5 from Discover models, under its own slug.
    const { rows, update, logger } = await runSeed(() => null, {
      'anthropic/claude-haiku-4-5': stored({
        id: 'row-haiku-admin',
        slug: 'anthropic-haiku-from-discovery',
        providerSlug: 'anthropic',
        isDefault: false,
      }),
      'anthropic/claude-haiku-4.5': stored({
        id: 'row-haiku-dotted',
        slug: 'anthropic-claude-haiku-4-5',
        providerSlug: 'anthropic',
      }),
    });

    expect(rows.has('anthropic-claude-haiku-4-5')).toBe(false);
    expect(rows.has('anthropic-claude-opus-4-6')).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      'Provider model anthropic-claude-haiku-4-5 not seeded: anthropic-haiku-from-discovery already has anthropic claude-haiku-4-5'
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('1 skipped (another row has the model id)')
    );
    // The never-served row does not stay on: it is retired onto the admin's row.
    expect(retirements(update)['row-haiku-dotted']).toEqual({
      retiresAt: DAY,
      replacementId: 'row-haiku-admin',
      isActive: false,
    });
  });
});
