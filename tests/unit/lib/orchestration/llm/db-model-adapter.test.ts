/**
 * Unit tests: db-model-adapter
 *
 * Covers the bridge between persisted `AiProviderModel` rows and the
 * `ModelInfo` shape consumed by the registry and the agent form.
 *
 * @see lib/orchestration/llm/db-model-adapter.ts
 */

import { describe, it, expect } from 'vitest';

import type { AiProviderModel } from '@/types/prisma';
import type { ModelInfo } from '@/lib/orchestration/llm/types';
import {
  dbModelToModelInfo,
  mapTierRoleToTier,
  mergeDbModelsWithRegistry,
} from '@/lib/orchestration/llm/db-model-adapter';
import {
  __resetForTests as resetRegistry,
  getModel,
  registerModels,
} from '@/lib/orchestration/llm/model-registry';

function makeRow(overrides: Partial<AiProviderModel> = {}): AiProviderModel {
  return {
    id: 'm1',
    slug: 'openai-gpt-5',
    providerSlug: 'openai',
    modelId: 'gpt-5',
    name: 'GPT-5',
    description: '',
    capabilities: ['chat'],
    tierRole: 'thinking',
    deploymentProfiles: ['hosted'],
    reasoningDepth: 'very_high',
    latency: 'medium',
    costEfficiency: 'medium',
    contextLength: 'very_high',
    toolUse: 'strong',
    bestRole: 'Planner',
    dimensions: null,
    schemaCompatible: null,
    costPerMillionTokens: 10,
    hasFreeTier: null,
    local: false,
    quality: null,
    strengths: null,
    setup: null,
    isDefault: false,
    isActive: true,
    metadata: null,
    createdBy: 'admin',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as AiProviderModel;
}

describe('mapTierRoleToTier', () => {
  it('maps thinking → frontier', () => {
    expect(mapTierRoleToTier('thinking')).toBe('frontier');
  });

  it('maps sovereign deployment profile → local (overrides tier)', () => {
    // Deployment locus takes precedence over capability tier — a
    // thinking-tier sovereign-deployable model collapses to `local`
    // so existing registry filters keep working.
    expect(mapTierRoleToTier('thinking', ['sovereign'])).toBe('local');
    expect(mapTierRoleToTier('worker', ['sovereign'])).toBe('local');
  });

  it('hosted-only tier roles preserve their capability mapping', () => {
    expect(mapTierRoleToTier('worker', ['hosted'])).toBe('mid');
    expect(mapTierRoleToTier('thinking', ['hosted'])).toBe('frontier');
  });

  it('maps infrastructure → budget', () => {
    expect(mapTierRoleToTier('infrastructure')).toBe('budget');
  });

  it('maps worker / control_plane / embedding → mid', () => {
    expect(mapTierRoleToTier('worker')).toBe('mid');
    expect(mapTierRoleToTier('control_plane')).toBe('mid');
    expect(mapTierRoleToTier('embedding')).toBe('mid');
  });

  it('defaults unknown tier role to mid', () => {
    expect(mapTierRoleToTier('mystery-tier')).toBe('mid');
  });
});

describe('dbModelToModelInfo', () => {
  it('translates a thinking row into a frontier ModelInfo with both costs filled', () => {
    const info = dbModelToModelInfo(makeRow());

    expect(info).toEqual({
      id: 'gpt-5',
      name: 'GPT-5',
      provider: 'openai',
      tier: 'frontier',
      inputCostPerMillion: 10,
      outputCostPerMillion: 10,
      maxContext: 1_000_000,
      supportsTools: true,
      available: true,
      capabilities: ['chat'],
    });
  });

  it('treats toolUse none as supportsTools: false', () => {
    const info = dbModelToModelInfo(makeRow({ toolUse: 'none' }));
    expect(info.supportsTools).toBe(false);
  });

  it('handles a null costPerMillionTokens by zeroing both cost fields and marking it unpriced', () => {
    const info = dbModelToModelInfo(makeRow({ costPerMillionTokens: null }));
    expect(info.inputCostPerMillion).toBe(0);
    expect(info.outputCostPerMillion).toBe(0);
    // Zero here means "nobody priced it", not "free" (#813).
    expect(info.pricingUnknown).toBe(true);
  });

  it('treats an explicit zero cost as a free model, not an unpriced one', () => {
    const info = dbModelToModelInfo(makeRow({ costPerMillionTokens: 0 }));
    expect(info.inputCostPerMillion).toBe(0);
    expect(info).not.toHaveProperty('pricingUnknown');
  });

  it('maps context length buckets to representative token ceilings', () => {
    expect(dbModelToModelInfo(makeRow({ contextLength: 'very_high' })).maxContext).toBe(1_000_000);
    expect(dbModelToModelInfo(makeRow({ contextLength: 'high' })).maxContext).toBe(200_000);
    expect(dbModelToModelInfo(makeRow({ contextLength: 'medium' })).maxContext).toBe(32_000);
    expect(dbModelToModelInfo(makeRow({ contextLength: 'n_a' })).maxContext).toBe(0);
  });

  it('forwards a known paramProfile value onto the ModelInfo so the provider class can branch on it', () => {
    const info = dbModelToModelInfo(makeRow({ paramProfile: 'openai-reasoning' }));
    expect(info.paramProfile).toBe('openai-reasoning');
  });

  it('omits paramProfile entirely when the row column is null (lets runtime fallback apply)', () => {
    const info = dbModelToModelInfo(makeRow({ paramProfile: null }));
    expect(info.paramProfile).toBeUndefined();
  });

  it('drops an unknown paramProfile value rather than narrowing it to a wrong enum member', () => {
    // Column is plain TEXT in Postgres — an operator could write
    // garbage via raw SQL. The adapter must treat unknown values as
    // absent, not as a phantom enum member.
    const info = dbModelToModelInfo(
      makeRow({ paramProfile: 'banana' as unknown as AiProviderModel['paramProfile'] })
    );
    expect(info.paramProfile).toBeUndefined();
  });
});

describe('mergeDbModelsWithRegistry', () => {
  const registry: ModelInfo[] = [
    {
      id: 'claude-opus-4-6',
      name: 'Claude Opus 4.6',
      provider: 'anthropic',
      tier: 'frontier',
      inputCostPerMillion: 15,
      outputCostPerMillion: 75,
      maxContext: 200_000,
      supportsTools: true,
    },
    {
      id: 'gpt-4o',
      name: 'GPT-4o (registry)',
      provider: 'openai',
      tier: 'frontier',
      inputCostPerMillion: 5,
      outputCostPerMillion: 15,
      maxContext: 128_000,
      supportsTools: true,
    },
  ];

  it('appends DB-only models that the registry never heard of', () => {
    const merged = mergeDbModelsWithRegistry(registry, [makeRow()]);
    expect(merged.map((m) => m.id).sort()).toEqual(['claude-opus-4-6', 'gpt-4o', 'gpt-5']);
  });

  it('lets the DB row win on descriptive fields on a (provider, modelId) collision', () => {
    const override = makeRow({
      modelId: 'gpt-4o',
      slug: 'openai-gpt-4o',
      name: 'GPT-4o (DB override)',
      tierRole: 'worker',
      contextLength: 'high',
      costPerMillionTokens: 3,
    });
    const merged = mergeDbModelsWithRegistry(registry, [override]);

    expect(merged).toHaveLength(2);
    const gpt4o = merged.find((m) => m.id === 'gpt-4o');
    expect(gpt4o?.name).toBe('GPT-4o (DB override)');
    expect(gpt4o?.tier).toBe('mid');
    // Price and window stay the registry's, as at runtime (#813): the row's
    // blended 3 and its `high` bucket (200k) are not what billing uses.
    expect(gpt4o).toMatchObject({
      inputCostPerMillion: 5,
      outputCostPerMillion: 15,
      maxContext: 128_000,
    });
  });

  it("shows the row's figures where the registry has none, and only then flags it unpriced", () => {
    const free: ModelInfo = {
      id: 'free-model',
      name: 'Free',
      provider: 'openai',
      tier: 'budget',
      inputCostPerMillion: 0,
      outputCostPerMillion: 0,
      maxContext: 0,
      supportsTools: true,
    };
    const priced = mergeDbModelsWithRegistry(
      [free],
      [makeRow({ modelId: 'free-model', costPerMillionTokens: 2, contextLength: 'medium' })]
    )[0];
    expect(priced).toMatchObject({
      inputCostPerMillion: 2,
      outputCostPerMillion: 2,
      maxContext: 32_000,
    });

    // A null-cost row over a registry entry at 0/0 is a free model, as at
    // runtime — not an unpriced one.
    const stillFree = mergeDbModelsWithRegistry(
      [free],
      [makeRow({ modelId: 'free-model', costPerMillionTokens: null })]
    )[0];
    expect(stillFree.inputCostPerMillion).toBe(0);
    expect(stillFree).not.toHaveProperty('pricingUnknown');
  });

  it("shows the row's current figures for a model whose registry copy came from the matrix", () => {
    // A hydrate registered this model from its row at 9; the operator has
    // since edited the row to 4. The registry copy is the matrix's own, so
    // the list must show the row's current value, as the next hydrate will.
    resetRegistry();
    registerModels([
      dbModelToModelInfo(makeRow({ modelId: 'acme-owned', costPerMillionTokens: 9 })),
    ]);
    const hydrated = getModel('acme-owned');
    expect(hydrated?.inputCostPerMillion).toBe(9);

    const listed = mergeDbModelsWithRegistry(
      [hydrated!],
      [makeRow({ modelId: 'acme-owned', costPerMillionTokens: 4 })]
    )[0];
    expect(listed.inputCostPerMillion).toBe(4);
    resetRegistry();
  });

  it('returns the registry untouched when no DB rows are passed', () => {
    const merged = mergeDbModelsWithRegistry(registry, []);
    expect(merged).toEqual(registry);
  });

  it('returns DB-only rows when the registry is empty', () => {
    const merged = mergeDbModelsWithRegistry([], [makeRow()]);
    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe('gpt-5');
  });
});
