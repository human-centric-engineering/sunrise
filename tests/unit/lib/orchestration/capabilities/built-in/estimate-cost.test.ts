/**
 * Tests for EstimateCostCapability.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/orchestration/llm/model-registry', () => ({
  getModelsByTier: vi.fn(),
}));

vi.mock('@/lib/orchestration/llm/cost-tracker', () => ({
  calculateCost: vi.fn(),
}));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { getModelsByTier } = await import('@/lib/orchestration/llm/model-registry');
const { calculateCost } = await import('@/lib/orchestration/llm/cost-tracker');
const { EstimateCostCapability } =
  await import('@/lib/orchestration/capabilities/built-in/estimate-cost');

const context = { userId: 'u1', agentId: 'a1' };

function mockModel(id: string) {
  return [
    {
      id,
      name: id,
      provider: 'anthropic',
      tier: 'mid',
      inputCostPerMillion: 3,
      outputCostPerMillion: 15,
      contextWindow: 200_000,
      capabilities: [],
    },
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('EstimateCostCapability', () => {
  it.each(['budget', 'mid', 'frontier'] as const)(
    'computes a cost for tier %s using the first model returned',
    async (tier) => {
      (getModelsByTier as ReturnType<typeof vi.fn>).mockReturnValue(mockModel('test-model'));
      (calculateCost as ReturnType<typeof vi.fn>).mockReturnValue({
        inputCostUsd: 0.01,
        outputCostUsd: 0.02,
        totalCostUsd: 0.03,
        isLocal: false,
      });
      const cap = new EstimateCostCapability();

      const result = await cap.execute(
        { description: 'plan a workflow', estimated_steps: 5, model_tier: tier },
        context
      );

      expect(getModelsByTier).toHaveBeenCalledWith(tier);
      // 5 steps * 1500 in / 500 out per step.
      expect(calculateCost).toHaveBeenCalledWith('test-model', 7500, 2500);
      expect(result.success).toBe(true);
      expect(result.skipFollowup).toBe(true);
      expect(result.data).toMatchObject({
        model: 'test-model',
        tier,
        totalSteps: 5,
        assumptions: { inputTokensPerStep: 1500, outputTokensPerStep: 500 },
        cost: { inputCostUsd: 0.01, outputCostUsd: 0.02, totalCostUsd: 0.03 },
      });
    }
  );

  it('returns no_model_for_tier when the registry has no models for the tier', async () => {
    (getModelsByTier as ReturnType<typeof vi.fn>).mockReturnValue([]);
    const cap = new EstimateCostCapability();

    const result = await cap.execute(
      { description: 'x', estimated_steps: 1, model_tier: 'budget' },
      context
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('no_model_for_tier');
    expect(calculateCost).not.toHaveBeenCalled();
  });
});
