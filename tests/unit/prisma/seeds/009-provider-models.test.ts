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

import providerModelsSeed from '@/prisma/seeds/009-provider-models';
import type { SeedContext } from '@/prisma/runner';

interface UpsertArgs {
  where: { slug: string };
  update: Record<string, unknown>;
  create: Record<string, unknown>;
}

async function runSeed(existing: (slug: string) => { isDefault: boolean } | null = () => null) {
  const upsert = vi.fn().mockResolvedValue({});
  const ctx = {
    prisma: {
      user: { findFirst: vi.fn().mockResolvedValue({ id: 'system-owner' }) },
      aiProviderModel: {
        findUnique: vi.fn(({ where }: { where: { slug: string } }) =>
          Promise.resolve(existing(where.slug))
        ),
        upsert,
      },
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  } as unknown as SeedContext;

  await providerModelsSeed.run(ctx);

  const rows = new Map<string, UpsertArgs>();
  for (const [args] of upsert.mock.calls as Array<[UpsertArgs]>) rows.set(args.where.slug, args);
  return { rows, upsert };
}

describe('009-provider-models seed — pricing (t-774)', () => {
  it('writes published input and output prices on hosted chat rows', async () => {
    const { rows } = await runSeed();

    expect(rows.get('openai-gpt-4o-mini')?.create).toMatchObject({
      inputCostPerMillionTokens: 0.15,
      outputCostPerMillionTokens: 0.6,
    });
    expect(rows.get('anthropic-claude-opus-4')?.create).toMatchObject({
      inputCostPerMillionTokens: 15,
      outputCostPerMillionTokens: 75,
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
