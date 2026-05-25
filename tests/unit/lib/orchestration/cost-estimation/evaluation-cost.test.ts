/**
 * Unit Tests: estimateEvaluationRunCost
 *
 * Coverage:
 * - Heuristic mode prices subject + judge calls at their bound models
 * - caseCount=0 returns midUsd=0 with a clear note
 * - Judge agents falling back to the chat default still cost
 * - Empirical mode activates at 3+ matching past runs and uses median
 *   per-case cost
 * - Fingerprint mismatch (different judge set, different content hash)
 *   keeps the run on the heuristic floor
 * - Past-runs query failure logs + falls back to heuristic
 * - pricingKnown=false surfaces when getModel has no rates
 *
 * @see lib/orchestration/cost-estimation/evaluation-cost.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiAgent: { findUnique: vi.fn(), findMany: vi.fn() },
    aiDataset: { findUnique: vi.fn() },
    aiEvaluationRun: { findMany: vi.fn() },
  },
}));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/orchestration/llm/model-registry', () => ({
  getModel: vi.fn(),
  refreshFromOpenRouter: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/orchestration/llm/model-registry-db-hydrate', () => ({
  hydrateFromDb: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/orchestration/llm/settings-resolver', () => ({
  getDefaultModelForTaskOrNull: vi.fn(),
}));

import { prisma } from '@/lib/db/client';
import { getModel } from '@/lib/orchestration/llm/model-registry';
import { getDefaultModelForTaskOrNull } from '@/lib/orchestration/llm/settings-resolver';
import { estimateEvaluationRunCost } from '@/lib/orchestration/cost-estimation/evaluation-cost';

const SUBJECT_MODEL = {
  id: 'subject-model',
  name: 'subject',
  provider: 'anthropic',
  tier: 'mid' as const,
  inputCostPerMillion: 3,
  outputCostPerMillion: 15,
  maxContext: 200_000,
  supportsTools: true,
};

const JUDGE_MODEL = {
  id: 'judge-model',
  name: 'judge',
  provider: 'anthropic',
  tier: 'budget' as const,
  inputCostPerMillion: 1,
  outputCostPerMillion: 5,
  maxContext: 200_000,
  supportsTools: true,
};

const UNPRICED_MODEL = {
  id: 'unpriced-model',
  name: 'free',
  provider: 'local',
  tier: 'local' as const,
  inputCostPerMillion: 0,
  outputCostPerMillion: 0,
  maxContext: 8_000,
  supportsTools: false,
};

const mockedPrisma = vi.mocked(prisma, true);
const mockedGetModel = vi.mocked(getModel);
const mockedChatDefault = vi.mocked(getDefaultModelForTaskOrNull);

beforeEach(() => {
  vi.clearAllMocks();
  mockedChatDefault.mockResolvedValue('default-chat');
  mockedGetModel.mockImplementation((id: string) => {
    if (id === SUBJECT_MODEL.id) return SUBJECT_MODEL;
    if (id === JUDGE_MODEL.id) return JUDGE_MODEL;
    if (id === UNPRICED_MODEL.id) return UNPRICED_MODEL;
    if (id === 'default-chat') return SUBJECT_MODEL;
    return undefined;
  });
});

function mockSubjectAgent(model: string | null): void {
  mockedPrisma.aiAgent.findUnique.mockResolvedValue({ model } as never);
}

function mockJudgeAgents(rows: Array<{ slug: string; model: string | null }>): void {
  mockedPrisma.aiAgent.findMany.mockResolvedValue(rows as never);
}

function mockDataset(caseCount: number, contentHash: string | null): void {
  mockedPrisma.aiDataset.findUnique.mockResolvedValue({ caseCount, contentHash } as never);
}

function mockPastRuns(
  rows: Array<{ id: string; metricConfigs: unknown; totalCostUsd: number; casesDone: number }>
): void {
  mockedPrisma.aiEvaluationRun.findMany.mockResolvedValue(
    rows.map((r) => ({
      id: r.id,
      metricConfigs: r.metricConfigs,
      totalCostUsd: r.totalCostUsd,
      progress: { casesDone: r.casesDone, casesTotal: r.casesDone, casesFailed: 0 },
    })) as never
  );
}

describe('estimateEvaluationRunCost — heuristic mode', () => {
  it('prices subject + every judge at its bound model when no past runs exist', async () => {
    mockSubjectAgent(SUBJECT_MODEL.id);
    mockJudgeAgents([
      { slug: 'judge-relevance', model: JUDGE_MODEL.id },
      { slug: 'judge-faithfulness', model: JUDGE_MODEL.id },
    ]);
    mockDataset(10, 'hash-1');
    mockPastRuns([]);

    const result = await estimateEvaluationRunCost({
      agentId: 'agent-1',
      userId: 'caller-id',
      judgeAgentSlugs: ['judge-relevance', 'judge-faithfulness'],
      datasetId: 'ds-1',
    });

    expect(result.basedOn).toBe('heuristic');
    expect(result.sampleSize).toBe(0);
    expect(result.caseCount).toBe(10);
    // Subject: 1500 in * 3/M + 500 out * 15/M = 0.0045 + 0.0075 = 0.012 per case; × 10 = 0.12
    // Each judge: 600 * 1/M + 150 * 5/M = 0.0006 + 0.00075 = 0.00135 per case; × 10 = 0.0135; × 2 judges = 0.027
    expect(result.midUsd).toBeCloseTo(0.12 + 0.027, 4);
    expect(result.modelMix).toHaveLength(3);
    expect(result.modelMix[0]).toMatchObject({ role: 'subject', modelId: SUBJECT_MODEL.id });
    expect(result.modelMix[1]).toMatchObject({
      role: 'judge',
      modelId: JUDGE_MODEL.id,
      judgeAgentSlug: 'judge-relevance',
    });
    expect(result.lowUsd).toBeCloseTo(result.midUsd * 0.5, 4);
    expect(result.highUsd).toBeCloseTo(result.midUsd * 2.0, 4);
    expect(result.modelMix.every((m) => m.pricingKnown)).toBe(true);
  });

  it('returns midUsd=0 with a clear note when the dataset has zero cases', async () => {
    mockSubjectAgent(SUBJECT_MODEL.id);
    mockJudgeAgents([]);
    mockDataset(0, 'hash-empty');
    mockPastRuns([]);

    const result = await estimateEvaluationRunCost({
      agentId: 'agent-1',
      userId: 'caller-id',
      judgeAgentSlugs: [],
      datasetId: 'ds-empty',
    });

    expect(result.basedOn).toBe('heuristic');
    expect(result.midUsd).toBe(0);
    expect(result.modelMix).toHaveLength(0);
    expect(result.notes).toMatch(/no cases/i);
  });

  it('falls back to the chat default when a judge agent has no bound model', async () => {
    mockSubjectAgent(SUBJECT_MODEL.id);
    mockJudgeAgents([{ slug: 'no-model-judge', model: null }]);
    mockDataset(5, 'hash-1');
    mockPastRuns([]);

    const result = await estimateEvaluationRunCost({
      agentId: 'agent-1',
      userId: 'caller-id',
      judgeAgentSlugs: ['no-model-judge'],
      datasetId: 'ds-1',
    });

    expect(result.basedOn).toBe('heuristic');
    const judgeEntry = result.modelMix.find((m) => m.role === 'judge');
    expect(judgeEntry?.modelId).toBe('default-chat');
    expect(judgeEntry?.pricingKnown).toBe(true);
  });

  it('flags pricingKnown=false when the bound model has no rates', async () => {
    mockSubjectAgent(UNPRICED_MODEL.id);
    mockJudgeAgents([]);
    mockDataset(3, 'hash-1');
    mockPastRuns([]);

    const result = await estimateEvaluationRunCost({
      agentId: 'agent-1',
      userId: 'caller-id',
      judgeAgentSlugs: [],
      datasetId: 'ds-1',
    });

    expect(result.basedOn).toBe('heuristic');
    expect(result.midUsd).toBe(0); // unpriced model contributes $0
    expect(result.modelMix[0].pricingKnown).toBe(false);
  });
});

describe('estimateEvaluationRunCost — empirical mode', () => {
  it('activates at ≥3 matching past runs (same agent + judge set + content hash)', async () => {
    mockSubjectAgent(SUBJECT_MODEL.id);
    mockJudgeAgents([{ slug: 'judge-a', model: JUDGE_MODEL.id }]);
    mockDataset(20, 'hash-stable');
    const metricConfigs = [{ slug: 'judge_agent', config: { agentSlug: 'judge-a' } }];
    mockPastRuns([
      { id: 'r1', metricConfigs, totalCostUsd: 0.2, casesDone: 20 },
      { id: 'r2', metricConfigs, totalCostUsd: 0.4, casesDone: 20 },
      { id: 'r3', metricConfigs, totalCostUsd: 0.6, casesDone: 20 },
    ]);

    const result = await estimateEvaluationRunCost({
      agentId: 'agent-1',
      userId: 'caller-id',
      judgeAgentSlugs: ['judge-a'],
      datasetId: 'ds-1',
    });

    expect(result.basedOn).toBe('empirical');
    expect(result.sampleSize).toBe(3);
    // median per-case cost = 0.40 / 20 = 0.02; × 20 = 0.40
    expect(result.midUsd).toBeCloseTo(0.4, 4);
    expect(result.lowUsd).toBeGreaterThanOrEqual(0);
    expect(result.lowUsd).toBeLessThan(result.midUsd);
    expect(result.highUsd).toBeGreaterThan(result.midUsd);
    expect(result.notes).toMatch(/Calibrated from 3 past runs/);
  });

  it('rejects past runs whose judge set fingerprint differs', async () => {
    mockSubjectAgent(SUBJECT_MODEL.id);
    mockJudgeAgents([{ slug: 'judge-a', model: JUDGE_MODEL.id }]);
    mockDataset(10, 'hash-stable');
    mockPastRuns([
      // Same agent + dataset hash, but with a DIFFERENT judge — must not count
      {
        id: 'r1',
        metricConfigs: [{ slug: 'judge_agent', config: { agentSlug: 'judge-different' } }],
        totalCostUsd: 1.0,
        casesDone: 10,
      },
      {
        id: 'r2',
        metricConfigs: [{ slug: 'judge_agent', config: { agentSlug: 'judge-different' } }],
        totalCostUsd: 1.0,
        casesDone: 10,
      },
      {
        id: 'r3',
        metricConfigs: [{ slug: 'judge_agent', config: { agentSlug: 'judge-different' } }],
        totalCostUsd: 1.0,
        casesDone: 10,
      },
    ]);

    const result = await estimateEvaluationRunCost({
      agentId: 'agent-1',
      userId: 'caller-id',
      judgeAgentSlugs: ['judge-a'],
      datasetId: 'ds-1',
    });

    expect(result.basedOn).toBe('heuristic');
    expect(result.sampleSize).toBe(0);
  });

  it('falls back to heuristic when fewer than the threshold prior runs match', async () => {
    mockSubjectAgent(SUBJECT_MODEL.id);
    mockJudgeAgents([{ slug: 'judge-a', model: JUDGE_MODEL.id }]);
    mockDataset(10, 'hash-stable');
    const metricConfigs = [{ slug: 'judge_agent', config: { agentSlug: 'judge-a' } }];
    mockPastRuns([
      { id: 'r1', metricConfigs, totalCostUsd: 0.1, casesDone: 10 },
      { id: 'r2', metricConfigs, totalCostUsd: 0.1, casesDone: 10 },
    ]);

    const result = await estimateEvaluationRunCost({
      agentId: 'agent-1',
      userId: 'caller-id',
      judgeAgentSlugs: ['judge-a'],
      datasetId: 'ds-1',
    });

    expect(result.basedOn).toBe('heuristic');
    expect(result.sampleSize).toBe(2);
    expect(result.notes).toMatch(/Only 2 prior runs/);
  });

  it('treats judge-set comparison as order-independent', async () => {
    mockSubjectAgent(SUBJECT_MODEL.id);
    mockJudgeAgents([
      { slug: 'judge-a', model: JUDGE_MODEL.id },
      { slug: 'judge-b', model: JUDGE_MODEL.id },
    ]);
    mockDataset(5, 'hash-stable');
    // Past runs had the judges in reverse order — should still match
    const metricConfigs = [
      { slug: 'judge_agent', config: { agentSlug: 'judge-b' } },
      { slug: 'judge_agent', config: { agentSlug: 'judge-a' } },
    ];
    mockPastRuns([
      { id: 'r1', metricConfigs, totalCostUsd: 0.05, casesDone: 5 },
      { id: 'r2', metricConfigs, totalCostUsd: 0.05, casesDone: 5 },
      { id: 'r3', metricConfigs, totalCostUsd: 0.05, casesDone: 5 },
    ]);

    const result = await estimateEvaluationRunCost({
      agentId: 'agent-1',
      userId: 'caller-id',
      judgeAgentSlugs: ['judge-a', 'judge-b'],
      datasetId: 'ds-1',
    });

    expect(result.basedOn).toBe('empirical');
  });
});

describe('estimateEvaluationRunCost — robustness', () => {
  it('falls back to heuristic and logs when the past-runs query throws', async () => {
    mockSubjectAgent(SUBJECT_MODEL.id);
    mockJudgeAgents([]);
    mockDataset(5, 'hash-1');
    mockedPrisma.aiEvaluationRun.findMany.mockRejectedValue(new Error('db down'));

    const result = await estimateEvaluationRunCost({
      agentId: 'agent-1',
      userId: 'caller-id',
      judgeAgentSlugs: [],
      datasetId: 'ds-1',
    });

    expect(result.basedOn).toBe('heuristic');
    expect(result.sampleSize).toBe(0);
  });

  it('returns a heuristic estimate when the dataset content hash is missing', async () => {
    mockSubjectAgent(SUBJECT_MODEL.id);
    mockJudgeAgents([]);
    mockedPrisma.aiDataset.findUnique.mockResolvedValue({
      caseCount: 5,
      contentHash: null,
    } as never);
    mockPastRuns([]);

    const result = await estimateEvaluationRunCost({
      agentId: 'agent-1',
      userId: 'caller-id',
      judgeAgentSlugs: [],
      datasetId: 'ds-1',
    });

    expect(result.basedOn).toBe('heuristic');
    expect(result.caseCount).toBe(5);
  });

  it('respects the explicit caseCount override', async () => {
    mockSubjectAgent(SUBJECT_MODEL.id);
    mockJudgeAgents([]);
    mockDataset(100, 'hash-1');
    mockPastRuns([]);

    const result = await estimateEvaluationRunCost({
      agentId: 'agent-1',
      userId: 'caller-id',
      judgeAgentSlugs: [],
      datasetId: 'ds-1',
      caseCount: 3,
    });

    expect(result.caseCount).toBe(3);
  });
});
