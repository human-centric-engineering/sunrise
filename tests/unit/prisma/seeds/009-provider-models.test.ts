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
}

interface LookupWhere {
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

  it('seeds every Anthropic model under an id in the API’s form: hyphens, no dots', async () => {
    const anthropic = (await seeded()).filter((r) => r.providerSlug === 'anthropic');

    expect(anthropic.map((r) => r.modelId)).toEqual([
      'claude-opus-4-6',
      'claude-sonnet-4-6',
      'claude-haiku-4-5',
    ]);
    for (const row of anthropic) {
      // `claude-<family>-<major>[-<minor>][-<yyyymmdd>]`: a dotted or
      // unversioned id (`claude-haiku-4.5`, `claude-opus-4`) fails here.
      expect(row.modelId, String(row.modelId)).toMatch(/^claude-[a-z]+-\d+-\d+(-\d{8})?$/);
    }
  });

  it('never seeds a model its vendor has stopped serving', async () => {
    const slugs = (await seeded()).map((r) => r.slug);

    for (const { slug } of RETIRED_SEED_MODELS) expect(slugs).not.toContain(slug);
    // And each retired model's replacement is seeded, so a fresh install has it.
    const ids = (await seeded()).map((r) => `${String(r.providerSlug)}/${String(r.modelId)}`);
    expect(ids).toEqual(
      expect.arrayContaining([
        'anthropic/claude-opus-4-6',
        'anthropic/claude-sonnet-4-6',
        'openai/o3',
      ])
    );
  });

  it('leaves a fresh install without the retired rows, writing nothing to them', async () => {
    const { update } = await runSeed();
    expect(update).not.toHaveBeenCalled();
  });

  it('marks an existing seed-managed retired row retired, with its replacement, and turns it off', async () => {
    const oldRows: Record<string, StoredRow> = {
      'anthropic-claude-sonnet-4': {
        id: 'row-sonnet-4',
        name: 'Claude Sonnet 4',
        providerSlug: 'anthropic',
        capabilities: ['chat', 'vision', 'documents'],
        isActive: true,
        isDefault: true,
        retiresAt: null,
      },
    };
    const replacement: StoredRow = {
      id: 'row-sonnet-4-6',
      slug: 'anthropic-claude-sonnet-4-6',
      name: 'Claude Sonnet 4.6',
      providerSlug: 'anthropic',
      capabilities: ['chat', 'vision', 'documents'],
      isActive: true,
      isDefault: true,
      retiresAt: null,
    };

    const { update, logger } = await runSeed((slug) => oldRows[slug] ?? null, {
      'anthropic/claude-sonnet-4-6': replacement,
    });

    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({
      where: { slug: 'anthropic-claude-sonnet-4' },
      data: {
        retiresAt: new Date(`${SEED_RETIREMENT_DAY}T00:00:00.000Z`),
        replacementId: 'row-sonnet-4-6',
        isActive: false,
      },
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('retires it with no replacement when the replacement no longer qualifies, and says why', async () => {
    const { update, logger } = await runSeed(
      (slug) =>
        slug === 'openai-o3-mini'
          ? {
              id: 'row-o3-mini',
              name: 'o3-mini',
              providerSlug: 'openai',
              capabilities: ['reasoning'],
              isActive: true,
              isDefault: true,
              retiresAt: null,
            }
          : null,
      {
        // An admin turned o3 off.
        'openai/o3': {
          id: 'row-o3',
          slug: 'openai-o3',
          name: 'o3',
          providerSlug: 'openai',
          capabilities: ['reasoning'],
          isActive: false,
          isDefault: false,
          retiresAt: null,
        },
      }
    );

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { slug: 'openai-o3-mini' },
        data: expect.objectContaining({ replacementId: null, isActive: false }),
      })
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Retiring openai-o3-mini without a replacement: o3')
    );
  });

  it('leaves a retired row an admin has edited as they left it', async () => {
    const { update } = await runSeed((slug) =>
      slug === 'anthropic-claude-opus-4' ? { isDefault: false } : null
    );
    expect(update).not.toHaveBeenCalled();
  });

  it('skips a model whose id another row already holds, instead of failing the seed', async () => {
    // Say an admin added Haiku 4.5 under its own slug from Discover models.
    const { rows, logger } = await runSeed(() => null, {
      'anthropic/claude-haiku-4-5': {
        slug: 'anthropic-haiku-from-discovery',
        isDefault: false,
      },
    });

    expect(rows.has('anthropic-claude-haiku-4-5')).toBe(false);
    expect(rows.has('anthropic-claude-opus-4-6')).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      'Provider model anthropic-claude-haiku-4-5 not seeded: anthropic-haiku-from-discovery already has anthropic claude-haiku-4-5'
    );
  });
});
