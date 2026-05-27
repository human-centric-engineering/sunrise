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

// Workflow-subject path delegates shape resolution to workflow-cost.ts.
// Mocking it keeps these tests fully unit-scoped.
vi.mock('@/lib/orchestration/cost-estimation/workflow-cost', () => ({
  loadWorkflowShape: vi.fn(),
}));

import { prisma } from '@/lib/db/client';
import { getModel } from '@/lib/orchestration/llm/model-registry';
import { getDefaultModelForTaskOrNull } from '@/lib/orchestration/llm/settings-resolver';
import { estimateEvaluationRunCost } from '@/lib/orchestration/cost-estimation/evaluation-cost';
import { loadWorkflowShape } from '@/lib/orchestration/cost-estimation/workflow-cost';

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

describe('estimateEvaluationRunCost — workflow subjects (Phase 3.5b)', () => {
  const mockedLoadShape = vi.mocked(loadWorkflowShape);

  it('aggregates per-step tokens by resolved model for a multi-step workflow', async () => {
    mockedLoadShape.mockResolvedValue({
      llmStepCount: 3,
      hasSupervisor: false,
      supervisorStepIds: new Set(),
      workSteps: [
        { stepId: 's1', type: 'agent_call', modelId: SUBJECT_MODEL.id, multiplier: 1 },
        { stepId: 's2', type: 'llm_call', modelId: SUBJECT_MODEL.id, multiplier: 1 },
        { stepId: 's3', type: 'llm_call', modelId: JUDGE_MODEL.id, multiplier: 1 },
      ],
      supervisorStepId: null,
      supervisorModelId: null,
    });
    mockJudgeAgents([]);
    mockDataset(4, 'wf-hash');
    mockPastRuns([]);

    const result = await estimateEvaluationRunCost({
      subjectKind: 'workflow',
      workflowId: 'wf-1',
      userId: 'caller-id',
      judgeAgentSlugs: [],
      datasetId: 'ds-1',
    });

    expect(result.basedOn).toBe('heuristic');
    expect(result.caseCount).toBe(4);

    // Two SUBJECT_MODEL steps → 2 × (3000 in, 1000 out) × 4 cases = 24k in, 8k out
    //   cost = 24000/1M * 3 + 8000/1M * 15 = 0.072 + 0.12 = 0.192
    // One JUDGE_MODEL step → 1 × (3000 in, 1000 out) × 4 cases = 12k in, 4k out
    //   cost = 12000/1M * 1 + 4000/1M * 5 = 0.012 + 0.020 = 0.032
    expect(result.midUsd).toBeCloseTo(0.192 + 0.032, 4);

    // Two subject rows (one per resolved model). No judge rows.
    expect(result.modelMix.filter((m) => m.role === 'subject')).toHaveLength(2);
    expect(result.modelMix.filter((m) => m.role === 'judge')).toHaveLength(0);
    const subjectByModel = new Map(
      result.modelMix.filter((m) => m.role === 'subject').map((m) => [m.modelId, m])
    );
    expect(subjectByModel.get(SUBJECT_MODEL.id)?.inputTokens).toBe(24_000);
    expect(subjectByModel.get(SUBJECT_MODEL.id)?.outputTokens).toBe(8_000);
    expect(subjectByModel.get(JUDGE_MODEL.id)?.inputTokens).toBe(12_000);
    expect(subjectByModel.get(JUDGE_MODEL.id)?.outputTokens).toBe(4_000);
  });

  it('respects per-step multipliers (agent_call counts as 3 LLM calls)', async () => {
    mockedLoadShape.mockResolvedValue({
      llmStepCount: 3,
      hasSupervisor: false,
      supervisorStepIds: new Set(),
      workSteps: [{ stepId: 's1', type: 'agent_call', modelId: SUBJECT_MODEL.id, multiplier: 3 }],
      supervisorStepId: null,
      supervisorModelId: null,
    });
    mockJudgeAgents([]);
    mockDataset(2, 'wf-hash');
    mockPastRuns([]);

    const result = await estimateEvaluationRunCost({
      subjectKind: 'workflow',
      workflowId: 'wf-1',
      userId: 'caller-id',
      judgeAgentSlugs: [],
      datasetId: 'ds-1',
    });

    // Tokens scale linearly with multiplier:
    //   input = 3000 * 3 * 2 cases = 18000
    //   output = 1000 * 3 * 2 cases = 6000
    const subjectEntry = result.modelMix.find((m) => m.role === 'subject');
    expect(subjectEntry?.inputTokens).toBe(18_000);
    expect(subjectEntry?.outputTokens).toBe(6_000);
  });

  it('falls back to heuristic when fewer than 3 matching workflow runs exist', async () => {
    mockedLoadShape.mockResolvedValue({
      llmStepCount: 1,
      hasSupervisor: false,
      supervisorStepIds: new Set(),
      workSteps: [{ stepId: 's1', type: 'llm_call', modelId: SUBJECT_MODEL.id, multiplier: 1 }],
      supervisorStepId: null,
      supervisorModelId: null,
    });
    mockJudgeAgents([]);
    mockDataset(5, 'wf-hash');
    mockPastRuns([
      { id: 'r1', metricConfigs: [], totalCostUsd: 0.1, casesDone: 5 },
      { id: 'r2', metricConfigs: [], totalCostUsd: 0.1, casesDone: 5 },
    ]);

    const result = await estimateEvaluationRunCost({
      subjectKind: 'workflow',
      workflowId: 'wf-1',
      userId: 'caller-id',
      judgeAgentSlugs: [],
      datasetId: 'ds-1',
    });

    expect(result.basedOn).toBe('heuristic');
    expect(result.sampleSize).toBe(2);
  });

  it('queries past runs scoped to subjectKind=workflow + workflowId', async () => {
    mockedLoadShape.mockResolvedValue({
      llmStepCount: 1,
      hasSupervisor: false,
      supervisorStepIds: new Set(),
      workSteps: [{ stepId: 's1', type: 'llm_call', modelId: SUBJECT_MODEL.id, multiplier: 1 }],
      supervisorStepId: null,
      supervisorModelId: null,
    });
    mockJudgeAgents([]);
    mockDataset(5, 'wf-hash');
    mockPastRuns([]);

    await estimateEvaluationRunCost({
      subjectKind: 'workflow',
      workflowId: 'wf-42',
      userId: 'caller-id',
      judgeAgentSlugs: [],
      datasetId: 'ds-1',
    });

    expect(mockedPrisma.aiEvaluationRun.findMany).toHaveBeenCalledOnce();
    const arg = mockedPrisma.aiEvaluationRun.findMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
    };
    expect(arg.where.subjectKind).toBe('workflow');
    expect(arg.where.workflowId).toBe('wf-42');
    expect(arg.where).not.toHaveProperty('agentId');
  });

  it('throws when subjectKind=workflow is passed without a workflowId', async () => {
    await expect(
      estimateEvaluationRunCost({
        subjectKind: 'workflow',
        userId: 'caller-id',
        judgeAgentSlugs: [],
        datasetId: 'ds-1',
      })
    ).rejects.toThrow(/workflowId is required/);
  });
});

describe('estimateEvaluationRunCost — defensive paths', () => {
  it('throws when subjectKind=agent is passed without an agentId', async () => {
    await expect(
      estimateEvaluationRunCost({
        subjectKind: 'agent',
        userId: 'caller-id',
        judgeAgentSlugs: [],
        datasetId: 'ds-1',
      })
    ).rejects.toThrow(/agentId is required/);
  });

  it('falls back to FALLBACK_MODEL_ID when no chat default is configured', async () => {
    mockedChatDefault.mockResolvedValueOnce(null);
    mockSubjectAgent(null); // no bound model → uses chat default
    mockJudgeAgents([]);
    mockDataset(2, 'hash-1');
    mockPastRuns([]);

    const result = await estimateEvaluationRunCost({
      agentId: 'agent-x',
      userId: 'caller-id',
      judgeAgentSlugs: [],
      datasetId: 'ds-1',
    });

    expect(result.basedOn).toBe('heuristic');
    // The fallback id is hard-coded in the module; we just need the
    // estimator to produce a real subject row rather than skip it entirely.
    expect(result.modelMix.find((m) => m.role === 'subject')).toBeDefined();
  });

  it('treats a missing dataset row as zero cases (no crash)', async () => {
    mockSubjectAgent(SUBJECT_MODEL.id);
    mockJudgeAgents([]);
    mockedPrisma.aiDataset.findUnique.mockResolvedValue(null);
    mockPastRuns([]);

    const result = await estimateEvaluationRunCost({
      agentId: 'agent-1',
      userId: 'caller-id',
      judgeAgentSlugs: [],
      datasetId: 'ds-missing',
    });

    expect(result.caseCount).toBe(0);
    expect(result.midUsd).toBe(0);
  });

  it('treats a subject-agent lookup failure as a chat-default fallback', async () => {
    mockedPrisma.aiAgent.findUnique.mockRejectedValueOnce(new Error('db hiccup'));
    mockJudgeAgents([]);
    mockDataset(1, 'hash-1');
    mockPastRuns([]);

    const result = await estimateEvaluationRunCost({
      agentId: 'agent-x',
      userId: 'caller-id',
      judgeAgentSlugs: [],
      datasetId: 'ds-1',
    });

    // No throw; subject still appears in the mix on the chat-default model.
    expect(result.basedOn).toBe('heuristic');
    expect(result.modelMix.some((m) => m.role === 'subject')).toBe(true);
  });

  it('treats a judge-agents lookup failure as a chat-default fallback per slug', async () => {
    mockSubjectAgent(SUBJECT_MODEL.id);
    mockedPrisma.aiAgent.findMany.mockRejectedValueOnce(new Error('db hiccup'));
    mockDataset(1, 'hash-1');
    mockPastRuns([]);

    const result = await estimateEvaluationRunCost({
      agentId: 'agent-1',
      userId: 'caller-id',
      judgeAgentSlugs: ['judge-a', 'judge-b'],
      datasetId: 'ds-1',
    });

    // Both judges still appear, attributed to the chat default.
    const judgeEntries = result.modelMix.filter((m) => m.role === 'judge');
    expect(judgeEntries).toHaveLength(2);
    expect(judgeEntries.every((j) => j.modelId === 'default-chat')).toBe(true);
  });

  it('keeps the empirical floor empty when prior-run metricConfigs are not an array (defensive)', async () => {
    mockSubjectAgent(SUBJECT_MODEL.id);
    mockJudgeAgents([{ slug: 'judge-a', model: JUDGE_MODEL.id }]);
    mockDataset(5, 'hash-stable');
    // metricConfigs intentionally malformed: object instead of array, then
    // missing slug, then judge_agent with non-object config, then with no
    // agentSlug. Each row must be silently dropped by extractJudgeSlugs.
    mockedPrisma.aiEvaluationRun.findMany.mockResolvedValueOnce([
      {
        id: 'r1',
        metricConfigs: { broken: 'not-an-array' },
        totalCostUsd: 1,
        progress: { casesDone: 5 },
      },
      {
        id: 'r2',
        metricConfigs: [{ slug: 'other' }],
        totalCostUsd: 1,
        progress: { casesDone: 5 },
      },
      {
        id: 'r3',
        metricConfigs: [{ slug: 'judge_agent', config: 'not-an-object' }],
        totalCostUsd: 1,
        progress: { casesDone: 5 },
      },
      {
        id: 'r4',
        metricConfigs: [{ slug: 'judge_agent', config: { agentSlug: '' } }],
        totalCostUsd: 1,
        progress: { casesDone: 5 },
      },
    ] as never);

    const result = await estimateEvaluationRunCost({
      agentId: 'agent-1',
      userId: 'caller-id',
      judgeAgentSlugs: ['judge-a'],
      datasetId: 'ds-1',
    });

    // None of the malformed rows should count toward the empirical floor.
    expect(result.basedOn).toBe('heuristic');
    expect(result.sampleSize).toBe(0);
  });

  it('drops past runs whose progress shape is malformed (defensive readCasesDone)', async () => {
    mockSubjectAgent(SUBJECT_MODEL.id);
    mockJudgeAgents([{ slug: 'judge-a', model: JUDGE_MODEL.id }]);
    mockDataset(5, 'hash-stable');
    const metricConfigs = [{ slug: 'judge_agent', config: { agentSlug: 'judge-a' } }];
    // Three near-matches that each fail readCasesDone for a different reason.
    mockedPrisma.aiEvaluationRun.findMany.mockResolvedValueOnce([
      { id: 'r-null', metricConfigs, totalCostUsd: 1, progress: null },
      { id: 'r-array', metricConfigs, totalCostUsd: 1, progress: [1, 2, 3] },
      {
        id: 'r-negative',
        metricConfigs,
        totalCostUsd: 1,
        progress: { casesDone: -5 },
      },
      {
        id: 'r-zero',
        metricConfigs,
        totalCostUsd: 1,
        progress: { casesDone: 0 },
      },
      {
        id: 'r-noncost',
        metricConfigs,
        totalCostUsd: null,
        progress: { casesDone: 5 },
      },
    ] as never);

    const result = await estimateEvaluationRunCost({
      agentId: 'agent-1',
      userId: 'caller-id',
      judgeAgentSlugs: ['judge-a'],
      datasetId: 'ds-1',
    });

    expect(result.basedOn).toBe('heuristic');
    expect(result.sampleSize).toBe(0);
  });
});
