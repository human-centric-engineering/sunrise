/**
 * Unit tests for completeEvaluationSession — the evaluations AI-summary handler.
 *
 * Prisma, provider-manager, and cost-tracker are fully mocked. Tests cover:
 *  - happy path (valid JSON, session update, cost logged, result shape)
 *  - NotFoundError on missing or cross-user session
 *  - ConflictError when session already completed or archived
 *  - ValidationError when logs are empty
 *  - malformed JSON → retry → second failure throws a sanitized error
 *  - logs cap at MAX_LOGS_IN_PROMPT (50)
 *  - deleted agent falls back to EVALUATION_DEFAULT_PROVIDER / MODEL
 *  - cost log failure does not abort the completion (fire-and-forget)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiEvaluationSession: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    aiEvaluationLog: {
      findMany: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/orchestration/llm/provider-manager', () => ({
  getProvider: vi.fn(),
}));

vi.mock('@/lib/orchestration/llm/cost-tracker', () => ({
  logCost: vi.fn(),
  calculateCost: vi.fn(() => ({
    inputCostUsd: 0.001,
    outputCostUsd: 0.002,
    totalCostUsd: 0.003,
  })),
}));

const { prisma } = await import('@/lib/db/client');
const { getProvider } = await import('@/lib/orchestration/llm/provider-manager');
const { logCost } = await import('@/lib/orchestration/llm/cost-tracker');
const { completeEvaluationSession, rescoreEvaluationSession } =
  await import('@/lib/orchestration/evaluations/complete-session');
const { NotFoundError, ConflictError, ValidationError } = await import('@/lib/api/errors');

const findFirst = prisma.aiEvaluationSession.findFirst as unknown as ReturnType<typeof vi.fn>;
const update = prisma.aiEvaluationSession.update as unknown as ReturnType<typeof vi.fn>;
const findLogs = prisma.aiEvaluationLog.findMany as unknown as ReturnType<typeof vi.fn>;
const updateLog = prisma.aiEvaluationLog.update as unknown as ReturnType<typeof vi.fn>;
const mockedGetProvider = getProvider as unknown as ReturnType<typeof vi.fn>;
const mockedLogCost = logCost as unknown as ReturnType<typeof vi.fn>;

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sess-1',
    userId: 'user-1',
    agentId: 'agent-1',
    title: 'Title',
    description: 'Description',
    status: 'in_progress',
    summary: null,
    improvementSuggestions: null,
    startedAt: null,
    completedAt: null,
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    agent: {
      id: 'agent-1',
      name: 'Test Agent',
      slug: 'test-agent',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
    },
    ...overrides,
  };
}

function makeLog(seq: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `log-${seq}`,
    sessionId: 'sess-1',
    messageId: null,
    sequenceNumber: seq,
    eventType: 'user_input',
    content: `message ${seq}`,
    inputData: null,
    outputData: null,
    capabilitySlug: null,
    executionTimeMs: null,
    tokenUsage: null,
    metadata: null,
    createdAt: new Date(),
    ...overrides,
  };
}

function makeProvider(chatImpl: ReturnType<typeof vi.fn>) {
  return { chat: chatImpl } as unknown as Awaited<ReturnType<typeof getProvider>>;
}

const VALID_RESPONSE = {
  content: JSON.stringify({
    summary: 'Agent performed well.',
    improvementSuggestions: ['Be more concise.', 'Quote sources.'],
  }),
  usage: { inputTokens: 100, outputTokens: 50 },
  model: 'claude-sonnet-4-6',
  finishReason: 'stop' as const,
};

beforeEach(() => {
  vi.resetAllMocks();
  // logCost never throws by default (fire-and-forget).
  mockedLogCost.mockResolvedValue({ id: 'cost-1' });
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('completeEvaluationSession', () => {
  it('runs the AI analysis, updates the session, logs cost, and returns the result', async () => {
    findFirst.mockResolvedValueOnce(makeSession());
    findLogs.mockResolvedValueOnce([makeLog(1), makeLog(2, { eventType: 'ai_response' })]);

    const chat = vi.fn().mockResolvedValueOnce(VALID_RESPONSE);
    mockedGetProvider.mockResolvedValueOnce(makeProvider(chat));

    update.mockResolvedValueOnce({ id: 'sess-1' });

    const result = await completeEvaluationSession({ sessionId: 'sess-1', userId: 'user-1' });

    // Result shape
    expect(result).toMatchObject({
      sessionId: 'sess-1',
      status: 'completed',
      summary: 'Agent performed well.',
      improvementSuggestions: ['Be more concise.', 'Quote sources.'],
      tokenUsage: { input: 100, output: 50 },
    });

    // Cross-user scoping in the findFirst call
    expect(findFirst.mock.calls[0][0].where).toMatchObject({
      id: 'sess-1',
      userId: 'user-1',
    });

    // Provider/model came from the agent
    expect(mockedGetProvider).toHaveBeenCalledWith('anthropic');
    expect(chat.mock.calls[0][1]).toMatchObject({
      model: 'claude-sonnet-4-6',
      temperature: 0.2,
      maxTokens: 1500,
    });

    // Cost logged with EVALUATION operation
    expect(mockedLogCost).toHaveBeenCalledTimes(1);
    expect(mockedLogCost.mock.calls[0][0]).toMatchObject({
      agentId: 'agent-1',
      operation: 'evaluation',
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      inputTokens: 100,
      outputTokens: 50,
    });

    // Session update
    expect(update.mock.calls[0][0]).toMatchObject({
      where: { id: 'sess-1' },
      data: expect.objectContaining({
        status: 'completed',
        summary: 'Agent performed well.',
        improvementSuggestions: ['Be more concise.', 'Quote sources.'],
      }),
    });
  });

  // -------------------------------------------------------------------------
  // Error cases
  // -------------------------------------------------------------------------

  it('throws NotFoundError when the session does not exist (or is cross-user)', async () => {
    findFirst.mockResolvedValueOnce(null);
    await expect(
      completeEvaluationSession({ sessionId: 'sess-1', userId: 'user-1' })
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('throws ConflictError when the session is already completed', async () => {
    findFirst.mockResolvedValueOnce(makeSession({ status: 'completed' }));
    await expect(
      completeEvaluationSession({ sessionId: 'sess-1', userId: 'user-1' })
    ).rejects.toBeInstanceOf(ConflictError);
    expect(mockedGetProvider).not.toHaveBeenCalled();
  });

  it('throws ConflictError when the session is archived', async () => {
    findFirst.mockResolvedValueOnce(makeSession({ status: 'archived' }));
    await expect(
      completeEvaluationSession({ sessionId: 'sess-1', userId: 'user-1' })
    ).rejects.toBeInstanceOf(ConflictError);
    expect(mockedGetProvider).not.toHaveBeenCalled();
  });

  it('throws ValidationError when the session has no logs', async () => {
    findFirst.mockResolvedValueOnce(makeSession());
    findLogs.mockResolvedValueOnce([]);
    await expect(
      completeEvaluationSession({ sessionId: 'sess-1', userId: 'user-1' })
    ).rejects.toBeInstanceOf(ValidationError);
    expect(mockedGetProvider).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Malformed JSON → retry → sanitized error
  // -------------------------------------------------------------------------

  it('retries once when the model returns malformed JSON, then succeeds', async () => {
    findFirst.mockResolvedValueOnce(makeSession());
    findLogs.mockResolvedValueOnce([makeLog(1)]);

    const chat = vi
      .fn()
      .mockResolvedValueOnce({
        content: 'not json at all',
        usage: { inputTokens: 20, outputTokens: 5 },
        model: 'claude-sonnet-4-6',
        finishReason: 'stop',
      })
      .mockResolvedValueOnce(VALID_RESPONSE);
    mockedGetProvider.mockResolvedValueOnce(makeProvider(chat));
    update.mockResolvedValueOnce({ id: 'sess-1' });

    const result = await completeEvaluationSession({ sessionId: 'sess-1', userId: 'user-1' });

    expect(chat).toHaveBeenCalledTimes(2);
    expect(result.tokenUsage).toEqual({ input: 120, output: 55 });
    // Retry prompt must have a stricter instruction appended
    const retryMessages = chat.mock.calls[1][0];
    const lastMessage = retryMessages[retryMessages.length - 1];
    expect(lastMessage.role).toBe('user');
    expect(lastMessage.content).toMatch(/JSON/i);
  });

  it('throws a sanitized error when retry also returns malformed JSON (never forwards raw output)', async () => {
    findFirst.mockResolvedValueOnce(makeSession());
    findLogs.mockResolvedValueOnce([makeLog(1)]);

    const sensitiveGarbage = 'SECRET_TOKEN leaked from LLM';
    const chat = vi
      .fn()
      .mockResolvedValueOnce({
        content: 'broken',
        usage: { inputTokens: 10, outputTokens: 3 },
        model: 'claude-sonnet-4-6',
        finishReason: 'stop',
      })
      .mockResolvedValueOnce({
        content: sensitiveGarbage,
        usage: { inputTokens: 10, outputTokens: 3 },
        model: 'claude-sonnet-4-6',
        finishReason: 'stop',
      });
    mockedGetProvider.mockResolvedValueOnce(makeProvider(chat));

    await expect(
      completeEvaluationSession({ sessionId: 'sess-1', userId: 'user-1' })
    ).rejects.toThrow(/Failed to generate evaluation analysis/);
    // Ensure the thrown error message does NOT contain the raw LLM output.
    try {
      await completeEvaluationSession({ sessionId: 'sess-1', userId: 'user-1' });
    } catch (err) {
      expect((err as Error).message).not.toContain('SECRET_TOKEN');
      expect((err as Error).message).not.toContain('leaked');
    }
  });

  it('strips ```json code fences from the model response', async () => {
    findFirst.mockResolvedValueOnce(makeSession());
    findLogs.mockResolvedValueOnce([makeLog(1)]);

    const fenced = {
      content: '```json\n{"summary": "Fine.", "improvementSuggestions": ["tighten prompt"]}\n```',
      usage: { inputTokens: 10, outputTokens: 5 },
      model: 'claude-sonnet-4-6',
      finishReason: 'stop' as const,
    };
    const chat = vi.fn().mockResolvedValueOnce(fenced);
    mockedGetProvider.mockResolvedValueOnce(makeProvider(chat));
    update.mockResolvedValueOnce({ id: 'sess-1' });

    const result = await completeEvaluationSession({ sessionId: 'sess-1', userId: 'user-1' });
    expect(result.summary).toBe('Fine.');
    expect(chat).toHaveBeenCalledTimes(1); // no retry
  });

  // -------------------------------------------------------------------------
  // Bounded prompt
  // -------------------------------------------------------------------------

  it('truncates log content longer than 500 chars in the analysis prompt', async () => {
    findFirst.mockResolvedValueOnce(makeSession());
    const longContent = 'x'.repeat(600);
    findLogs.mockResolvedValueOnce([makeLog(1, { content: longContent })]);
    const chat = vi.fn().mockResolvedValueOnce(VALID_RESPONSE);
    mockedGetProvider.mockResolvedValueOnce(makeProvider(chat));
    update.mockResolvedValueOnce({ id: 'sess-1' });

    await completeEvaluationSession({ sessionId: 'sess-1', userId: 'user-1' });

    const userMessage = chat.mock.calls[0][0].find((m: { role: string }) => m.role === 'user') as {
      content: string;
    };
    // 500 chars kept + ellipsis, original 600 not present in full.
    expect(userMessage.content).toContain('x'.repeat(500) + '…');
    expect(userMessage.content).not.toContain('x'.repeat(501));
  });

  it('caps the logs fetched for analysis at 50 via `take`', async () => {
    findFirst.mockResolvedValueOnce(makeSession());
    findLogs.mockResolvedValueOnce(Array.from({ length: 50 }, (_, i) => makeLog(i + 1)));
    mockedGetProvider.mockResolvedValueOnce(
      makeProvider(vi.fn().mockResolvedValueOnce(VALID_RESPONSE))
    );
    update.mockResolvedValueOnce({ id: 'sess-1' });

    await completeEvaluationSession({ sessionId: 'sess-1', userId: 'user-1' });

    expect(findLogs.mock.calls[0][0]).toMatchObject({ take: 50 });
  });

  // -------------------------------------------------------------------------
  // Deleted agent fallback
  // -------------------------------------------------------------------------

  it('falls back to the default provider/model when the agent has been deleted', async () => {
    findFirst.mockResolvedValueOnce(makeSession({ agentId: null, agent: null }));
    findLogs.mockResolvedValueOnce([makeLog(1)]);

    const chat = vi.fn().mockResolvedValueOnce(VALID_RESPONSE);
    mockedGetProvider.mockResolvedValueOnce(makeProvider(chat));
    update.mockResolvedValueOnce({ id: 'sess-1' });

    await completeEvaluationSession({ sessionId: 'sess-1', userId: 'user-1' });

    // Default is 'anthropic' unless EVALUATION_DEFAULT_PROVIDER env is set.
    expect(mockedGetProvider).toHaveBeenCalledWith(
      process.env.EVALUATION_DEFAULT_PROVIDER ?? 'anthropic'
    );
    // Cost log must not carry an agentId when the agent is gone.
    expect(mockedLogCost.mock.calls[0][0]).not.toHaveProperty('agentId');
  });

  // -------------------------------------------------------------------------
  // Fire-and-forget cost
  // -------------------------------------------------------------------------

  it('does not abort completion if logCost rejects', async () => {
    findFirst.mockResolvedValueOnce(makeSession());
    findLogs.mockResolvedValueOnce([makeLog(1)]);
    mockedGetProvider.mockResolvedValueOnce(
      makeProvider(vi.fn().mockResolvedValueOnce(VALID_RESPONSE))
    );
    mockedLogCost.mockRejectedValueOnce(new Error('db down'));
    update.mockResolvedValueOnce({ id: 'sess-1' });

    const result = await completeEvaluationSession({ sessionId: 'sess-1', userId: 'user-1' });
    expect(result.status).toBe('completed');
    // Give the microtask queue a tick so the .catch runs.
    await new Promise((resolve) => setImmediate(resolve));
  });
});

// ---------------------------------------------------------------------------
// Per-turn metric scoring (Phase 3 of named-metrics work)
// ---------------------------------------------------------------------------

const VALID_JUDGE_RESPONSE = {
  content: JSON.stringify({
    faithfulness: { score: 0.9, reasoning: 'Marked claims supported.' },
    groundedness: { score: 0.85, reasoning: 'Mostly grounded.' },
    relevance: { score: 0.95, reasoning: 'Direct.' },
  }),
  usage: { inputTokens: 80, outputTokens: 40 },
  model: 'claude-sonnet-4-6',
  finishReason: 'stop' as const,
};

describe('per-turn metric scoring', () => {
  it('scores ai_response logs after the summary, persists per-log scores, and returns metricSummary', async () => {
    findFirst.mockResolvedValueOnce(makeSession());
    findLogs.mockResolvedValueOnce([
      makeLog(1, { eventType: 'user_input', content: 'Question?' }),
      makeLog(2, {
        eventType: 'ai_response',
        content: 'Answer with [1].',
        metadata: { citations: [{ marker: 1, chunkId: 'c1', excerpt: 'Body.' }] },
      }),
    ]);

    const summaryChat = vi.fn().mockResolvedValueOnce(VALID_RESPONSE);
    const judgeChat = vi.fn().mockResolvedValueOnce(VALID_JUDGE_RESPONSE);
    mockedGetProvider
      .mockResolvedValueOnce(makeProvider(summaryChat))
      .mockResolvedValueOnce(makeProvider(judgeChat));

    update.mockResolvedValueOnce({ id: 'sess-1' });
    updateLog.mockResolvedValue({});

    const result = await completeEvaluationSession({ sessionId: 'sess-1', userId: 'user-1' });

    // Per-log scores were persisted via aiEvaluationLog.update
    expect(updateLog).toHaveBeenCalledTimes(1);
    const logUpdate = updateLog.mock.calls[0][0];
    expect(logUpdate.where.id).toBe('log-2');
    expect(logUpdate.data).toMatchObject({
      faithfulnessScore: 0.9,
      groundednessScore: 0.85,
      relevanceScore: 0.95,
    });
    expect(logUpdate.data.judgeReasoning.faithfulness.reasoning).toBe('Marked claims supported.');

    // Aggregate written to the session metadata
    const sessionUpdateData = update.mock.calls[0][0].data;
    expect(sessionUpdateData.metricSummary).toMatchObject({
      avgFaithfulness: 0.9,
      avgGroundedness: 0.85,
      avgRelevance: 0.95,
      scoredLogCount: 1,
    });

    // Result includes metricSummary
    expect(result.metricSummary).toMatchObject({
      avgFaithfulness: 0.9,
      scoredLogCount: 1,
    });

    // Two logCost calls — summary phase + scoring phase
    expect(mockedLogCost).toHaveBeenCalledTimes(2);
    const phases = mockedLogCost.mock.calls.map((c) => c[0].metadata?.phase);
    expect(phases).toEqual(['summary', 'scoring']);
  });

  it('swallows per-log judge errors and continues scoring later logs', async () => {
    findFirst.mockResolvedValueOnce(makeSession());
    findLogs.mockResolvedValueOnce([
      makeLog(1, { eventType: 'user_input', content: 'Q1?' }),
      makeLog(2, { eventType: 'ai_response', content: 'A1.' }),
      makeLog(3, { eventType: 'user_input', content: 'Q2?' }),
      makeLog(4, { eventType: 'ai_response', content: 'A2.' }),
    ]);

    const summaryChat = vi.fn().mockResolvedValueOnce(VALID_RESPONSE);
    const judgeChat = vi
      .fn()
      .mockRejectedValueOnce(new Error('judge blew up')) // fails for log-2
      .mockResolvedValueOnce(VALID_JUDGE_RESPONSE); // succeeds for log-4
    mockedGetProvider
      .mockResolvedValueOnce(makeProvider(summaryChat))
      .mockResolvedValueOnce(makeProvider(judgeChat));

    update.mockResolvedValueOnce({ id: 'sess-1' });
    updateLog.mockResolvedValue({});

    const result = await completeEvaluationSession({ sessionId: 'sess-1', userId: 'user-1' });

    // Only the successful log was persisted
    expect(updateLog).toHaveBeenCalledTimes(1);
    expect(updateLog.mock.calls[0][0].where.id).toBe('log-4');
    expect(result.metricSummary?.scoredLogCount).toBe(1);
  });

  it('completes the session even when wholesale scoring fails (judge provider unavailable)', async () => {
    findFirst.mockResolvedValueOnce(makeSession());
    findLogs.mockResolvedValueOnce([
      makeLog(1, { eventType: 'user_input', content: 'Q' }),
      makeLog(2, { eventType: 'ai_response', content: 'A' }),
    ]);

    const summaryChat = vi.fn().mockResolvedValueOnce(VALID_RESPONSE);
    mockedGetProvider
      .mockResolvedValueOnce(makeProvider(summaryChat))
      .mockRejectedValueOnce(new Error('no judge configured'));

    update.mockResolvedValueOnce({ id: 'sess-1' });

    const result = await completeEvaluationSession({ sessionId: 'sess-1', userId: 'user-1' });

    expect(result.status).toBe('completed');
    expect(result.metricSummary).toBeNull();
    // No per-log update, no scoring cost log
    expect(updateLog).not.toHaveBeenCalled();
    expect(mockedLogCost).toHaveBeenCalledTimes(1); // summary only
  });
});

// ---------------------------------------------------------------------------
// rescoreEvaluationSession
// ---------------------------------------------------------------------------

describe('rescoreEvaluationSession', () => {
  it('throws NotFoundError on missing or cross-user session', async () => {
    findFirst.mockResolvedValueOnce(null);
    await expect(
      rescoreEvaluationSession({ sessionId: 'sess-1', userId: 'user-1' })
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('throws ConflictError on a non-completed session', async () => {
    findFirst.mockResolvedValueOnce({
      id: 'sess-1',
      status: 'in_progress',
      agentId: 'agent-1',
      metricSummary: null,
    });
    await expect(
      rescoreEvaluationSession({ sessionId: 'sess-1', userId: 'user-1' })
    ).rejects.toBeInstanceOf(ConflictError);
    expect(mockedGetProvider).not.toHaveBeenCalled();
  });

  it('throws ValidationError when the completed session has no logs', async () => {
    findFirst.mockResolvedValueOnce({
      id: 'sess-1',
      status: 'completed',
      agentId: 'agent-1',
      metricSummary: null,
    });
    findLogs.mockResolvedValueOnce([]);
    await expect(
      rescoreEvaluationSession({ sessionId: 'sess-1', userId: 'user-1' })
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('overwrites scores in place and accumulates totalScoringCostUsd from prior runs', async () => {
    findFirst.mockResolvedValueOnce({
      id: 'sess-1',
      status: 'completed',
      agentId: 'agent-1',
      metricSummary: { totalScoringCostUsd: 0.025 },
    });
    findLogs.mockResolvedValueOnce([
      makeLog(1, { eventType: 'user_input', content: 'Q' }),
      makeLog(2, { eventType: 'ai_response', content: 'A [1].', metadata: { citations: [] } }),
    ]);

    const judgeChat = vi.fn().mockResolvedValueOnce(VALID_JUDGE_RESPONSE);
    mockedGetProvider.mockResolvedValueOnce(makeProvider(judgeChat));
    updateLog.mockResolvedValue({});
    update.mockResolvedValueOnce({ id: 'sess-1' });

    const result = await rescoreEvaluationSession({
      sessionId: 'sess-1',
      userId: 'user-1',
    });

    // Per-log score persisted in place
    expect(updateLog).toHaveBeenCalledTimes(1);
    expect(updateLog.mock.calls[0][0].where.id).toBe('log-2');

    // metricSummary refreshed and cost accumulated. calculateCost mock returns 0.003 per call.
    expect(result.metricSummary.totalScoringCostUsd).toBeCloseTo(0.025 + 0.003);
    expect(result.metricSummary.scoredLogCount).toBe(1);
    expect(result.metricSummary.scoredAt).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });
});
