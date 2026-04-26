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
      // test-review:accept tobe_true — boolean field `success` on CapabilityResult; structural assertion on capability outcome
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

  it('passes correct token totals for a large step count', async () => {
    (getModelsByTier as ReturnType<typeof vi.fn>).mockReturnValue(mockModel('frontier-model'));
    (calculateCost as ReturnType<typeof vi.fn>).mockReturnValue({
      inputCostUsd: 15.0,
      outputCostUsd: 25.0,
      totalCostUsd: 40.0,
      isLocal: false,
    });
    const cap = new EstimateCostCapability();

    const result = await cap.execute(
      { description: 'big workflow', estimated_steps: 1000, model_tier: 'frontier' },
      context
    );

    // 1000 steps * 1500 input = 1,500,000; 1000 * 500 output = 500,000
    expect(calculateCost).toHaveBeenCalledWith('frontier-model', 1_500_000, 500_000);
    // test-review:accept tobe_true — boolean field `success` on CapabilityResult; structural assertion on capability outcome
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      totalSteps: 1000,
      cost: { totalCostUsd: 40.0 },
    });
  });

  it('returns $0 cost when calculateCost returns zeros (e.g. local model)', async () => {
    (getModelsByTier as ReturnType<typeof vi.fn>).mockReturnValue([
      {
        id: 'local:generic',
        name: 'Local Model',
        provider: 'local',
        tier: 'local',
        inputCostPerMillion: 0,
        outputCostPerMillion: 0,
        contextWindow: 8192,
        capabilities: [],
      },
    ]);
    (calculateCost as ReturnType<typeof vi.fn>).mockReturnValue({
      inputCostUsd: 0,
      outputCostUsd: 0,
      totalCostUsd: 0,
      isLocal: true,
    });
    const cap = new EstimateCostCapability();

    const result = await cap.execute(
      { description: 'local run', estimated_steps: 10, model_tier: 'budget' },
      context
    );

    // test-review:accept tobe_true — boolean field `success` on CapabilityResult; structural assertion on capability outcome
    expect(result.success).toBe(true);
    expect(result.data?.cost).toEqual({
      inputCostUsd: 0,
      outputCostUsd: 0,
      totalCostUsd: 0,
    });
  });

  it('returns no_model_for_tier when the registry has no models for the tier', async () => {
    (getModelsByTier as ReturnType<typeof vi.fn>).mockReturnValue([]);
    const cap = new EstimateCostCapability();

    const result = await cap.execute(
      { description: 'x', estimated_steps: 1, model_tier: 'budget' },
      context
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('no_model_for_tier');
    // test-review:accept clear_then_notcalled — clearAllMocks is in beforeEach (not mid-test); not.toHaveBeenCalled verifies no cost calculation when model missing
    expect(calculateCost).not.toHaveBeenCalled();
  });
});
