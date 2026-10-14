/**
 * Unit tests: chat cost for a Model Matrix row with split prices (t-774)
 *
 * Runs the real adapter, registry and `calculateCost` together, so a
 * regression anywhere on the path from an `AiProviderModel` row to a
 * recorded turn cost fails here. `cost-tracker.test.ts` mocks the
 * registry and cannot see this path.
 *
 * @see lib/orchestration/llm/db-model-adapter.ts
 * @see lib/orchestration/llm/cost-tracker.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { AiProviderModel } from '@/types/prisma';

vi.mock('@/lib/db/client', () => ({ prisma: {} }));
vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { calculateCost } from '@/lib/orchestration/llm/cost-tracker';
import { dbModelToModelInfo } from '@/lib/orchestration/llm/db-model-adapter';
import {
  __resetForTests as resetRegistry,
  registerModels,
} from '@/lib/orchestration/llm/model-registry';

function makeRow(overrides: Partial<AiProviderModel>): AiProviderModel {
  return {
    id: 'row-1',
    slug: 'anthropic-claude-sonnet-snapshot',
    providerSlug: 'anthropic',
    modelId: 'claude-sonnet-4-6-20260901',
    name: 'Claude Sonnet (dated snapshot)',
    description: '',
    capabilities: ['chat'],
    tierRole: 'worker',
    deploymentProfiles: ['hosted'],
    paramProfile: null,
    reasoningDepth: 'high',
    latency: 'medium',
    costEfficiency: 'high',
    contextLength: 'high',
    toolUse: 'strong',
    bestRole: 'Chat',
    dimensions: null,
    schemaCompatible: null,
    costPerMillionTokens: 9,
    inputCostPerMillionTokens: 3,
    outputCostPerMillionTokens: 15,
    hasFreeTier: null,
    local: false,
    quality: null,
    strengths: null,
    setup: null,
    isDefault: false,
    isActive: true,
    metadata: null,
    createdBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('calculateCost for a matrix-only model with split prices', () => {
  beforeEach(() => {
    resetRegistry();
  });

  it('charges input and output at their own rates, not the blended rate', () => {
    // An input-heavy turn: 1M prompt tokens, 100K reply tokens.
    registerModels([dbModelToModelInfo(makeRow({}))]);

    const cost = calculateCost('claude-sonnet-4-6-20260901', 1_000_000, 100_000);

    expect(cost.inputCostUsd).toBeCloseTo(3);
    expect(cost.outputCostUsd).toBeCloseTo(1.5);
    expect(cost.totalCostUsd).toBeCloseTo(4.5);
    // The blended rate would have recorded 9 + 0.9 = 9.9.
    expect(cost.unpriced).toBeUndefined();
  });

  it('still uses the blended rate for a row that has no split prices', () => {
    registerModels([
      dbModelToModelInfo(
        makeRow({ inputCostPerMillionTokens: null, outputCostPerMillionTokens: null })
      ),
    ]);

    const cost = calculateCost('claude-sonnet-4-6-20260901', 1_000_000, 100_000);

    expect(cost.inputCostUsd).toBeCloseTo(9);
    expect(cost.outputCostUsd).toBeCloseTo(0.9);
  });

  it('records a row with no price at all as unpriced, at $0', () => {
    registerModels([
      dbModelToModelInfo(
        makeRow({
          costPerMillionTokens: null,
          inputCostPerMillionTokens: null,
          outputCostPerMillionTokens: null,
        })
      ),
    ]);

    const cost = calculateCost('claude-sonnet-4-6-20260901', 1_000_000, 100_000);

    expect(cost.totalCostUsd).toBe(0);
    expect(cost.unpriced).toBe(true);
  });

  it('keeps the built-in price for a known model over a split matrix row (t-769)', () => {
    // gpt-4o-mini is in the static fallback at $0.15 in / $0.60 out.
    registerModels([
      dbModelToModelInfo(
        makeRow({
          providerSlug: 'openai',
          modelId: 'gpt-4o-mini',
          inputCostPerMillionTokens: 1,
          outputCostPerMillionTokens: 1,
        })
      ),
    ]);

    const cost = calculateCost('gpt-4o-mini', 1_000_000, 1_000_000);

    expect(cost.inputCostUsd).toBeCloseTo(0.15);
    expect(cost.outputCostUsd).toBeCloseTo(0.6);
  });

  it("follows an operator's edit of the split prices on the next hydrate", () => {
    registerModels([dbModelToModelInfo(makeRow({}))]);
    registerModels([
      dbModelToModelInfo(makeRow({ inputCostPerMillionTokens: 2, outputCostPerMillionTokens: 10 })),
    ]);

    const cost = calculateCost('claude-sonnet-4-6-20260901', 1_000_000, 1_000_000);

    expect(cost.inputCostUsd).toBeCloseTo(2);
    expect(cost.outputCostUsd).toBeCloseTo(10);
  });
});
