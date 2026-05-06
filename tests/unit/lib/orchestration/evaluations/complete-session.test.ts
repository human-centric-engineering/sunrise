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

    // Capture the rejection from the first (and only) call — the mock provides
    // exactly two responses for that call. A second invocation would hit a missing
    // mockResolvedValueOnce and throw a NotFoundError from the wrong path.
    const err = await completeEvaluationSession({ sessionId: 'sess-1', userId: 'user-1' }).catch(
      (e) => e
    );

    // Assert: error is the sanitized message, NOT the raw LLM output
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/Failed to generate evaluation analysis/);
    expect((err as Error).message).not.toContain('SECRET_TOKEN');
    expect((err as Error).message).not.toContain('leaked');
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
    // No per-log update when judge provider fails — scoring is skipped entirely
    expect(updateLog).not.toHaveBeenCalled();
    // No scoring cost logged — only the summary LLM call cost is recorded
    expect(mockedLogCost).toHaveBeenCalledTimes(1); // summary only
  });

  it('filters malformed citations out of log metadata before passing to the judge', async () => {
    findFirst.mockResolvedValueOnce(makeSession());
    findLogs.mockResolvedValueOnce([
      makeLog(1, { eventType: 'user_input', content: 'Q' }),
      makeLog(2, {
        eventType: 'ai_response',
        content: 'A [1].',
        metadata: {
          citations: [
            // Valid — should be passed through.
            {
              marker: 1,
              chunkId: 'c1',
              documentId: 'd1',
              documentName: 'Doc',
              section: 'Page 1',
              patternNumber: null,
              patternName: null,
              excerpt: 'Body.',
              similarity: 0.9,
            },
            // Missing excerpt — would throw inside truncate(undefined, …).
            {
              marker: 2,
              chunkId: 'c2',
              documentId: 'd2',
              documentName: 'Doc 2',
              section: null,
              similarity: 0.8,
            },
            // Wrong shape entirely.
            'not-an-object',
            null,
          ],
        },
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

    // Score persisted — i.e. the judge call did NOT crash from the malformed
    // entries; only the valid citation was sent.
    expect(updateLog).toHaveBeenCalledTimes(1);
    expect(result.metricSummary?.scoredLogCount).toBe(1);

    // Verify the judge prompt only contains the valid marker.
    const userMsg = (judgeChat.mock.calls[0][0] as Array<{ role: string; content: string }>).find(
      (m) => m.role === 'user'
    );
    expect(userMsg).toBeDefined();
    const markerMatches = userMsg!.content.match(/"marker":\s*\d+/g) ?? [];
    expect(markerMatches).toHaveLength(1);
    expect(userMsg!.content).toContain('"marker": 1');
  });
});

// ---------------------------------------------------------------------------
// buildAnalysisMessages — capability log formatting and null description
// ---------------------------------------------------------------------------

describe('buildAnalysisMessages contract', () => {
  it('formats capability_call logs with capabilitySlug prefix in the transcript', async () => {
    // Arrange: a session with a capability_call log so the ternary true-branch is taken.
    findFirst.mockResolvedValueOnce(makeSession());
    findLogs.mockResolvedValueOnce([
      makeLog(1, {
        eventType: 'capability_call',
        content: 'search query',
        capabilitySlug: 'web-search',
      }),
    ]);
    const chat = vi.fn().mockResolvedValueOnce(VALID_RESPONSE);
    mockedGetProvider.mockResolvedValueOnce(makeProvider(chat));
    update.mockResolvedValueOnce({ id: 'sess-1' });

    // Act
    await completeEvaluationSession({ sessionId: 'sess-1', userId: 'user-1' });

    // Assert: the capability slug and content appear in the user message
    const userMsg = chat.mock.calls[0][0].find((m: { role: string }) => m.role === 'user') as {
      content: string;
    };
    expect(userMsg.content).toContain('web-search: search query');
    // The format is "#seq [capability_call] slug: content"
    expect(userMsg.content).toMatch(/#1 \[capability_call\] web-search:/);
  });

  it('formats capability_result logs with capabilitySlug prefix in the transcript', async () => {
    // Arrange: a capability_result log — the other arm of the same ternary.
    findFirst.mockResolvedValueOnce(makeSession());
    findLogs.mockResolvedValueOnce([
      makeLog(1, {
        eventType: 'capability_result',
        content: 'result data',
        capabilitySlug: 'web-search',
      }),
    ]);
    const chat = vi.fn().mockResolvedValueOnce(VALID_RESPONSE);
    mockedGetProvider.mockResolvedValueOnce(makeProvider(chat));
    update.mockResolvedValueOnce({ id: 'sess-1' });

    await completeEvaluationSession({ sessionId: 'sess-1', userId: 'user-1' });

    const userMsg = chat.mock.calls[0][0].find((m: { role: string }) => m.role === 'user') as {
      content: string;
    };
    expect(userMsg.content).toMatch(/#1 \[capability_result\] web-search:/);
    expect(userMsg.content).toContain('web-search: result data');
  });

  it('uses "unknown" when a capability log has a null capabilitySlug', async () => {
    // Covers capabilitySlug ?? 'unknown' fallback on line 299.
    findFirst.mockResolvedValueOnce(makeSession());
    findLogs.mockResolvedValueOnce([
      makeLog(1, { eventType: 'capability_call', content: 'data', capabilitySlug: null }),
    ]);
    const chat = vi.fn().mockResolvedValueOnce(VALID_RESPONSE);
    mockedGetProvider.mockResolvedValueOnce(makeProvider(chat));
    update.mockResolvedValueOnce({ id: 'sess-1' });

    await completeEvaluationSession({ sessionId: 'sess-1', userId: 'user-1' });

    const userMsg = chat.mock.calls[0][0].find((m: { role: string }) => m.role === 'user') as {
      content: string;
    };
    expect(userMsg.content).toContain('unknown: data');
  });

  it('omits the Description line when sessionDescription is null', async () => {
    // Covers the null branch of `opts.sessionDescription ? ... : null` (line 314).
    findFirst.mockResolvedValueOnce(makeSession({ description: null }));
    findLogs.mockResolvedValueOnce([makeLog(1)]);
    const chat = vi.fn().mockResolvedValueOnce(VALID_RESPONSE);
    mockedGetProvider.mockResolvedValueOnce(makeProvider(chat));
    update.mockResolvedValueOnce({ id: 'sess-1' });

    await completeEvaluationSession({ sessionId: 'sess-1', userId: 'user-1' });

    const userMsg = chat.mock.calls[0][0].find((m: { role: string }) => m.role === 'user') as {
      content: string;
    };
    expect(userMsg.content).not.toContain('Description:');
    expect(userMsg.content).toContain('Evaluation title:');
  });

  it('retries when the LLM returns valid JSON that does not match the expected shape', async () => {
    // Covers parseAnalysis returning null for valid-JSON-wrong-shape (branch 28, line 335).
    // The first response is valid JSON but missing required fields → retry.
    findFirst.mockResolvedValueOnce(makeSession());
    findLogs.mockResolvedValueOnce([makeLog(1)]);

    const wrongShape = { unexpected: 'field' };
    const chat = vi
      .fn()
      .mockResolvedValueOnce({
        content: JSON.stringify(wrongShape),
        usage: { inputTokens: 15, outputTokens: 8 },
        model: 'claude-sonnet-4-6',
        finishReason: 'stop',
      })
      .mockResolvedValueOnce(VALID_RESPONSE);
    mockedGetProvider.mockResolvedValueOnce(makeProvider(chat));
    update.mockResolvedValueOnce({ id: 'sess-1' });

    const result = await completeEvaluationSession({ sessionId: 'sess-1', userId: 'user-1' });

    // Two chat calls — original + retry
    expect(chat).toHaveBeenCalledTimes(2);
    expect(result.summary).toBe('Agent performed well.');
  });
});

// ---------------------------------------------------------------------------
// Per-turn metric scoring — skip and null-score branches
// ---------------------------------------------------------------------------

describe('per-turn metric scoring — branch coverage', () => {
  it('skips non-ai_response non-user_input events when scoring (e.g. capability_call)', async () => {
    // Covers: log.eventType !== 'ai_response' continue (branch 31, line 392).
    // A capability_call between user_input and ai_response is silently skipped;
    // only the ai_response log is scored.
    findFirst.mockResolvedValueOnce(makeSession());
    findLogs.mockResolvedValueOnce([
      makeLog(1, { eventType: 'user_input', content: 'Q?' }),
      makeLog(2, { eventType: 'capability_call', content: 'tool data', capabilitySlug: 'search' }),
      makeLog(3, { eventType: 'ai_response', content: 'A.' }),
    ]);

    const summaryChat = vi.fn().mockResolvedValueOnce(VALID_RESPONSE);
    const judgeChat = vi.fn().mockResolvedValueOnce(VALID_JUDGE_RESPONSE);
    mockedGetProvider
      .mockResolvedValueOnce(makeProvider(summaryChat))
      .mockResolvedValueOnce(makeProvider(judgeChat));
    update.mockResolvedValueOnce({ id: 'sess-1' });
    updateLog.mockResolvedValue({});

    const result = await completeEvaluationSession({ sessionId: 'sess-1', userId: 'user-1' });

    // Only the ai_response log is scored; capability_call is skipped entirely.
    expect(updateLog).toHaveBeenCalledTimes(1);
    expect(updateLog.mock.calls[0][0].where.id).toBe('log-3');
    expect(result.metricSummary?.scoredLogCount).toBe(1);
  });

  it('skips an ai_response that has no preceding user_input in the log sequence', async () => {
    // Covers: !lastUserContent continue (branch 32, line 393).
    // An ai_response that appears before any user_input is skipped.
    findFirst.mockResolvedValueOnce(makeSession());
    findLogs.mockResolvedValueOnce([
      makeLog(1, { eventType: 'ai_response', content: 'Orphaned response.' }),
      makeLog(2, { eventType: 'user_input', content: 'Q?' }),
      makeLog(3, { eventType: 'ai_response', content: 'Proper answer.' }),
    ]);

    const summaryChat = vi.fn().mockResolvedValueOnce(VALID_RESPONSE);
    const judgeChat = vi.fn().mockResolvedValueOnce(VALID_JUDGE_RESPONSE);
    mockedGetProvider
      .mockResolvedValueOnce(makeProvider(summaryChat))
      .mockResolvedValueOnce(makeProvider(judgeChat));
    update.mockResolvedValueOnce({ id: 'sess-1' });
    updateLog.mockResolvedValue({});

    const result = await completeEvaluationSession({ sessionId: 'sess-1', userId: 'user-1' });

    // Only log-3 (with a preceding question) is scored; log-1 is skipped.
    expect(updateLog).toHaveBeenCalledTimes(1);
    expect(updateLog.mock.calls[0][0].where.id).toBe('log-3');
    expect(result.metricSummary?.scoredLogCount).toBe(1);
  });

  it('does not include null scores in the aggregate averages', async () => {
    // Covers: faithfulness.score !== null / groundedness.score !== null / relevance.score !== null
    // branches (lines 421–423). A null faithfulness score must not skew the average.
    findFirst.mockResolvedValueOnce(makeSession());
    findLogs.mockResolvedValueOnce([
      makeLog(1, { eventType: 'user_input', content: 'Q?' }),
      makeLog(2, { eventType: 'ai_response', content: 'A (no inline markers).' }),
    ]);

    const judgeResponseWithNullFaithfulness = {
      content: JSON.stringify({
        faithfulness: { score: null, reasoning: 'No inline citations to evaluate.' },
        groundedness: { score: 0.8, reasoning: 'Grounded.' },
        relevance: { score: 1.0, reasoning: 'Direct.' },
      }),
      usage: { inputTokens: 80, outputTokens: 40 },
      model: 'claude-sonnet-4-6',
      finishReason: 'stop' as const,
    };

    const summaryChat = vi.fn().mockResolvedValueOnce(VALID_RESPONSE);
    const judgeChat = vi.fn().mockResolvedValueOnce(judgeResponseWithNullFaithfulness);
    mockedGetProvider
      .mockResolvedValueOnce(makeProvider(summaryChat))
      .mockResolvedValueOnce(makeProvider(judgeChat));
    update.mockResolvedValueOnce({ id: 'sess-1' });
    updateLog.mockResolvedValue({});

    const result = await completeEvaluationSession({ sessionId: 'sess-1', userId: 'user-1' });

    // Null faithfulness score is NOT averaged — avgFaithfulness should be null.
    expect(result.metricSummary?.avgFaithfulness).toBeNull();
    // Non-null scores are averaged normally.
    expect(result.metricSummary?.avgGroundedness).toBeCloseTo(0.8);
    expect(result.metricSummary?.avgRelevance).toBeCloseTo(1.0);
    expect(result.metricSummary?.scoredLogCount).toBe(1);
  });

  it('omits agentId from the scoring cost log when agentId is null', async () => {
    // Covers: if (opts.agentId) costParams.agentId = ... false branch (line 449).
    // In rescoreEvaluationSession, the session may have a null agentId.
    findFirst.mockResolvedValueOnce({
      id: 'sess-1',
      status: 'completed',
      agentId: null,
      metricSummary: null,
    });
    findLogs.mockResolvedValueOnce([
      makeLog(1, { eventType: 'user_input', content: 'Q' }),
      makeLog(2, { eventType: 'ai_response', content: 'A.', metadata: { citations: [] } }),
    ]);

    const judgeChat = vi.fn().mockResolvedValueOnce(VALID_JUDGE_RESPONSE);
    mockedGetProvider.mockResolvedValueOnce(makeProvider(judgeChat));
    updateLog.mockResolvedValue({});
    update.mockResolvedValueOnce({ id: 'sess-1' });

    await rescoreEvaluationSession({ sessionId: 'sess-1', userId: 'user-1' });

    // Scoring cost was logged but without an agentId field.
    expect(mockedLogCost).toHaveBeenCalledTimes(1);
    expect(mockedLogCost.mock.calls[0][0]).not.toHaveProperty('agentId');
    expect(mockedLogCost.mock.calls[0][0].metadata?.phase).toBe('scoring');
  });
});

// ---------------------------------------------------------------------------
// extractLogCitations — defensive validation branches
// ---------------------------------------------------------------------------

describe('extractLogCitations — defensive validation', () => {
  it('returns empty citations when the metadata.citations field is not an array', async () => {
    // Covers: !Array.isArray(citations) return [] branch (line 481).
    // A hand-edited row where citations is an object, not an array.
    findFirst.mockResolvedValueOnce(makeSession());
    findLogs.mockResolvedValueOnce([
      makeLog(1, { eventType: 'user_input', content: 'Q?' }),
      makeLog(2, {
        eventType: 'ai_response',
        content: 'A.',
        // citations is an object, not an array — should be treated as empty.
        metadata: { citations: { marker: 1, excerpt: 'Body.' } },
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

    // Scoring completed despite the malformed citations field.
    expect(result.metricSummary?.scoredLogCount).toBe(1);
    // The judge was called with no citations (empty array in the prompt).
    const userMsg = (judgeChat.mock.calls[0][0] as Array<{ role: string; content: string }>).find(
      (m) => m.role === 'user'
    );
    expect(userMsg?.content).toContain('no cited sources');
  });
});

// ---------------------------------------------------------------------------
// rescoreEvaluationSession — additional branch coverage
// ---------------------------------------------------------------------------

describe('rescoreEvaluationSession — additional branches', () => {
  it('uses 0 as previousCost when metricSummary exists but has no totalScoringCostUsd field', async () => {
    // Covers: previous?.totalScoringCostUsd ?? 0 fallback when the field is absent (branch 20, line 229).
    findFirst.mockResolvedValueOnce({
      id: 'sess-1',
      status: 'completed',
      agentId: 'agent-1',
      // metricSummary exists but has no totalScoringCostUsd — simulates schema drift.
      metricSummary: { scoredLogCount: 2, scoredAt: '2024-01-01T00:00:00.000Z' },
    });
    findLogs.mockResolvedValueOnce([
      makeLog(1, { eventType: 'user_input', content: 'Q' }),
      makeLog(2, { eventType: 'ai_response', content: 'A.', metadata: { citations: [] } }),
    ]);

    const judgeChat = vi.fn().mockResolvedValueOnce(VALID_JUDGE_RESPONSE);
    mockedGetProvider.mockResolvedValueOnce(makeProvider(judgeChat));
    updateLog.mockResolvedValue({});
    update.mockResolvedValueOnce({ id: 'sess-1' });

    const result = await rescoreEvaluationSession({ sessionId: 'sess-1', userId: 'user-1' });

    // previousCost fell back to 0; totalScoringCostUsd reflects only the new run's cost.
    expect(result.metricSummary.totalScoringCostUsd).toBeCloseTo(0.003);
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
