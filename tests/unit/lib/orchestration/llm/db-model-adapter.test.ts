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

  it('maps local_sovereign → local', () => {
    expect(mapTierRoleToTier('local_sovereign')).toBe('local');
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

  it('handles a null costPerMillionTokens by zeroing both cost fields', () => {
    const info = dbModelToModelInfo(makeRow({ costPerMillionTokens: null }));
    expect(info.inputCostPerMillion).toBe(0);
    expect(info.outputCostPerMillion).toBe(0);
  });

  it('maps context length buckets to representative token ceilings', () => {
    expect(dbModelToModelInfo(makeRow({ contextLength: 'very_high' })).maxContext).toBe(1_000_000);
    expect(dbModelToModelInfo(makeRow({ contextLength: 'high' })).maxContext).toBe(200_000);
    expect(dbModelToModelInfo(makeRow({ contextLength: 'medium' })).maxContext).toBe(32_000);
    expect(dbModelToModelInfo(makeRow({ contextLength: 'n_a' })).maxContext).toBe(0);
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

  it('lets the DB row win on (provider, modelId) collision', () => {
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
    expect(gpt4o?.maxContext).toBe(200_000);
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
