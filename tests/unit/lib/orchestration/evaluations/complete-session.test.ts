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

// The orphan-agent fallback and the judge-scoring fallback both now call
// `resolveAgentProviderAndModel` when EVALUATION_DEFAULT_* / EVALUATION_JUDGE_*
// env vars aren't set. Mock it to return a deterministic anthropic binding
// (matching what the test fixtures expect from the old hard-coded fallback).
vi.mock('@/lib/orchestration/llm/agent-resolver', () => ({
  resolveAgentProviderAndModel: vi.fn(async () => ({
    providerSlug: 'anthropic',
    model: 'claude-sonnet-4-6',
    fallbacks: [],
  })),
}));

vi.mock('@/lib/orchestration/llm/cost-tracker', () => ({
  logCost: vi.fn(),
  calculateCost: vi.fn(() => ({
    inputCostUsd: 0.001,
    outputCostUsd: 0.002,
    totalCostUsd: 0.003,
  })),
}));

// Phase 1.5 refactor: scoring goes through `scoreResponse`, which now
// drives three seeded judge agents via streamChat. Unit tests don't
// exercise streamChat — we mock scoreResponse at the module boundary
// and assert complete-session's control flow on top of it.
vi.mock('@/lib/orchestration/evaluations/score-response', () => ({
  scoreResponse: vi.fn(),
}));

const { prisma } = await import('@/lib/db/client');
const { getProvider } = await import('@/lib/orchestration/llm/provider-manager');
const { logCost } = await import('@/lib/orchestration/llm/cost-tracker');
const { scoreResponse } = await import('@/lib/orchestration/evaluations/score-response');
const { completeEvaluationSession, rescoreEvaluationSession } =
  await import('@/lib/orchestration/evaluations/complete-session');
const { NotFoundError, ConflictError, ValidationError } = await import('@/lib/api/errors');

const findFirst = prisma.aiEvaluationSession.findFirst as unknown as ReturnType<typeof vi.fn>;
const update = prisma.aiEvaluationSession.update as unknown as ReturnType<typeof vi.fn>;
const findLogs = prisma.aiEvaluationLog.findMany as unknown as ReturnType<typeof vi.fn>;
const updateLog = prisma.aiEvaluationLog.update as unknown as ReturnType<typeof vi.fn>;
const mockedGetProvider = getProvider as unknown as ReturnType<typeof vi.fn>;
const mockedLogCost = logCost as unknown as ReturnType<typeof vi.fn>;
const mockedScoreResponse = scoreResponse as unknown as ReturnType<typeof vi.fn>;

/** Canned scoreResponse result for happy-path scoring tests. */
function scoreResult(
  overrides: Partial<{
    faithfulness: number | null;
    groundedness: number | null;
    relevance: number | null;
    costUsd: number;
  }> = {}
): {
  scores: {
    faithfulness: { score: number | null; reasoning: string };
    groundedness: { score: number | null; reasoning: string };
    relevance: { score: number | null; reasoning: string };
  };
  costUsd: number;
} {
  // `in` checks rather than `??` so explicit `null` overrides aren't
  // replaced with the default 0.9 / 0.85 / 1.
  return {
    scores: {
      faithfulness: {
        score: 'faithfulness' in overrides ? (overrides.faithfulness ?? null) : 0.9,
        reasoning: 'ok',
      },
      groundedness: {
        score: 'groundedness' in overrides ? (overrides.groundedness ?? null) : 0.85,
        reasoning: 'ok',
      },
      relevance: {
        score: 'relevance' in overrides ? (overrides.relevance ?? null) : 1,
        reasoning: 'ok',
      },
    },
    costUsd: overrides.costUsd ?? 0.003,
  };
}

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
  // Default scoreResponse to a happy-path score so summary-only tests
  // don't have to set this up. Individual scoring tests override.
  mockedScoreResponse.mockResolvedValue(scoreResult());
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
// Reviewer annotations → analysis prompt (Phase 0)
// ---------------------------------------------------------------------------
//
// The runner UI lets a reviewer annotate each AI response with a category,
// a 1-5 rating, and free-text notes; these are serialized into
// session.metadata (see annotation-serializer.ts). The summariser must now
// surface those annotations to the LLM so the AI's analysis reflects human
// judgement, not just the raw transcript.

describe('buildAnalysisMessages — reviewer annotations', () => {
  it('injects an annotation line under the matching ai_response and updates the system prompt', async () => {
    // Annotation indices match the runner's filtered chat list (user + AI
    // turns, capability events skipped). With logs [user_input, ai_response]
    // the assistant turn sits at index 1 in the runner — so ann_0_idx=1.
    findFirst.mockResolvedValueOnce(
      makeSession({
        metadata: {
          ann_count: 1,
          ann_0_idx: 1,
          ann_0_cat: 'issue',
          ann_0_rat: 2,
          ann_0_notes: 'missed the refund window',
        },
      })
    );
    findLogs.mockResolvedValueOnce([
      makeLog(1, { eventType: 'user_input', content: 'Can I get a refund?' }),
      makeLog(2, { eventType: 'ai_response', content: 'Refunds are available.' }),
    ]);
    const chat = vi.fn().mockResolvedValueOnce(VALID_RESPONSE);
    mockedGetProvider.mockResolvedValueOnce(makeProvider(chat));
    update.mockResolvedValueOnce({ id: 'sess-1' });

    await completeEvaluationSession({ sessionId: 'sess-1', userId: 'user-1' });

    const userMsg = chat.mock.calls[0][0].find((m: { role: string }) => m.role === 'user') as {
      content: string;
    };
    const systemMsg = chat.mock.calls[0][0].find((m: { role: string }) => m.role === 'system') as {
      content: string;
    };
    expect(userMsg.content).toContain('↳ reviewer:');
    expect(userMsg.content).toContain('category=issue');
    expect(userMsg.content).toContain('rating=2/5');
    expect(userMsg.content).toContain('notes="missed the refund window"');
    expect(systemMsg.content).toContain('reviewer');
  });

  it('skips default annotations (rating=3, no category, no notes) so the prompt stays clean', async () => {
    findFirst.mockResolvedValueOnce(
      makeSession({
        metadata: {
          ann_count: 1,
          ann_0_idx: 1,
          ann_0_cat: null,
          ann_0_rat: 3,
          ann_0_notes: null,
        },
      })
    );
    findLogs.mockResolvedValueOnce([
      makeLog(1, { eventType: 'user_input', content: 'Hi' }),
      makeLog(2, { eventType: 'ai_response', content: 'Hello' }),
    ]);
    const chat = vi.fn().mockResolvedValueOnce(VALID_RESPONSE);
    mockedGetProvider.mockResolvedValueOnce(makeProvider(chat));
    update.mockResolvedValueOnce({ id: 'sess-1' });

    await completeEvaluationSession({ sessionId: 'sess-1', userId: 'user-1' });

    const userMsg = chat.mock.calls[0][0].find((m: { role: string }) => m.role === 'user') as {
      content: string;
    };
    const systemMsg = chat.mock.calls[0][0].find((m: { role: string }) => m.role === 'system') as {
      content: string;
    };
    expect(userMsg.content).not.toContain('↳ reviewer:');
    expect(systemMsg.content).not.toContain('reviewer');
  });

  it('treats null session metadata as no annotations (back-compat)', async () => {
    findFirst.mockResolvedValueOnce(makeSession({ metadata: null }));
    findLogs.mockResolvedValueOnce([
      makeLog(1, { eventType: 'user_input', content: 'Hi' }),
      makeLog(2, { eventType: 'ai_response', content: 'Hello' }),
    ]);
    const chat = vi.fn().mockResolvedValueOnce(VALID_RESPONSE);
    mockedGetProvider.mockResolvedValueOnce(makeProvider(chat));
    update.mockResolvedValueOnce({ id: 'sess-1' });

    await completeEvaluationSession({ sessionId: 'sess-1', userId: 'user-1' });

    const userMsg = chat.mock.calls[0][0].find((m: { role: string }) => m.role === 'user') as {
      content: string;
    };
    expect(userMsg.content).not.toContain('↳ reviewer:');
  });

  it('counts only chat turns when matching annotation indices (capability events excluded)', async () => {
    // The runner skips capability_* events when building its messages array,
    // so an annotation against the *second* AI turn must still find its
    // ai_response even with a capability_call sitting between them.
    // logs:  user_input → ai_response → capability_call → user_input → ai_response
    // chat:  user(0) → assistant(1) →                      user(2) → assistant(3)
    findFirst.mockResolvedValueOnce(
      makeSession({
        metadata: {
          ann_count: 1,
          ann_0_idx: 3,
          ann_0_cat: 'expected',
          ann_0_rat: 5,
          ann_0_notes: null,
        },
      })
    );
    findLogs.mockResolvedValueOnce([
      makeLog(1, { eventType: 'user_input', content: 'First question' }),
      makeLog(2, { eventType: 'ai_response', content: 'First answer' }),
      makeLog(3, {
        eventType: 'capability_call',
        content: 'search',
        capabilitySlug: 'web-search',
      }),
      makeLog(4, { eventType: 'user_input', content: 'Second question' }),
      makeLog(5, { eventType: 'ai_response', content: 'Second answer' }),
    ]);
    const chat = vi.fn().mockResolvedValueOnce(VALID_RESPONSE);
    mockedGetProvider.mockResolvedValueOnce(makeProvider(chat));
    update.mockResolvedValueOnce({ id: 'sess-1' });

    await completeEvaluationSession({ sessionId: 'sess-1', userId: 'user-1' });

    const userMsg = chat.mock.calls[0][0].find((m: { role: string }) => m.role === 'user') as {
      content: string;
    };
    // The annotation should sit under the *second* ai_response (#5), not the first.
    const lines = userMsg.content.split('\n');
    const secondAiLineIdx = lines.findIndex((l) => l.startsWith('#5 [ai_response]'));
    expect(secondAiLineIdx).toBeGreaterThan(-1);
    expect(lines[secondAiLineIdx + 1]).toContain('↳ reviewer:');
    expect(lines[secondAiLineIdx + 1]).toContain('category=expected');
    expect(lines[secondAiLineIdx + 1]).toContain('rating=5/5');
    // And the first ai_response line must NOT be followed by a reviewer line.
    const firstAiLineIdx = lines.findIndex((l) => l.startsWith('#2 [ai_response]'));
    expect(lines[firstAiLineIdx + 1]).not.toContain('↳ reviewer:');
  });

  it('truncates long notes to keep the prompt compact', async () => {
    const longNotes = 'x'.repeat(500);
    findFirst.mockResolvedValueOnce(
      makeSession({
        metadata: {
          ann_count: 1,
          ann_0_idx: 1,
          ann_0_cat: 'observation',
          ann_0_rat: 4,
          ann_0_notes: longNotes,
        },
      })
    );
    findLogs.mockResolvedValueOnce([
      makeLog(1, { eventType: 'user_input', content: 'Hi' }),
      makeLog(2, { eventType: 'ai_response', content: 'Hello' }),
    ]);
    const chat = vi.fn().mockResolvedValueOnce(VALID_RESPONSE);
    mockedGetProvider.mockResolvedValueOnce(makeProvider(chat));
    update.mockResolvedValueOnce({ id: 'sess-1' });

    await completeEvaluationSession({ sessionId: 'sess-1', userId: 'user-1' });

    const userMsg = chat.mock.calls[0][0].find((m: { role: string }) => m.role === 'user') as {
      content: string;
    };
    // Truncated to 280 chars + ellipsis.
    expect(userMsg.content).toContain('notes="');
    expect(userMsg.content).toMatch(/notes="x{280}…"/);
    expect(userMsg.content).not.toContain('x'.repeat(500));
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

// ---------------------------------------------------------------------------
// Per-turn metric scoring — agent-as-judges path (Phase 1.5 refactor)
// ---------------------------------------------------------------------------
//
// The previous tests in this section asserted on the bundled-judge-call
// internals (provider mocks, single-call JSON shape, separate
// EVALUATION cost log). After the refactor scoring goes through
// `scoreResponse`, which drives three seeded judge agents via
// streamChat — incompatible with the old direct-provider mock. The
// tests below cover the post-refactor surface; the verification
// script at `scripts/verify-eval-run.ts` covers the full e2e path.

describe('per-turn metric scoring (agents-as-judges)', () => {
  it('calls scoreResponse once per ai_response, persists scores, aggregates averages', async () => {
    findFirst.mockResolvedValueOnce(makeSession());
    findLogs.mockResolvedValueOnce([
      makeLog(1, { eventType: 'user_input', content: 'Q1?' }),
      makeLog(2, {
        eventType: 'ai_response',
        content: 'A1 [1].',
        metadata: {
          citations: [
            {
              marker: 1,
              chunkId: 'c1',
              documentId: 'd1',
              documentName: 'D',
              section: null,
              excerpt: 'Body.',
              similarity: 0.9,
            },
          ],
        },
      }),
      makeLog(3, { eventType: 'user_input', content: 'Q2?' }),
      makeLog(4, { eventType: 'ai_response', content: 'A2.' }),
    ]);
    const summaryChat = vi.fn().mockResolvedValueOnce(VALID_RESPONSE);
    mockedGetProvider.mockResolvedValueOnce(makeProvider(summaryChat));
    update.mockResolvedValueOnce({ id: 'sess-1' });
    updateLog.mockResolvedValue({});
    mockedScoreResponse
      .mockResolvedValueOnce(scoreResult({ faithfulness: 0.9, groundedness: 0.8, relevance: 1 }))
      .mockResolvedValueOnce(scoreResult({ faithfulness: 0.7, groundedness: 0.6, relevance: 0.5 }));

    const result = await completeEvaluationSession({ sessionId: 'sess-1', userId: 'user-1' });

    expect(mockedScoreResponse).toHaveBeenCalledTimes(2);
    // scoreResponse receives the user content + the AI response + citations + userId
    expect(mockedScoreResponse.mock.calls[0][0]).toMatchObject({
      userQuestion: 'Q1?',
      aiResponse: 'A1 [1].',
      userId: 'user-1',
    });
    expect(updateLog).toHaveBeenCalledTimes(2);
    expect(result.metricSummary?.scoredLogCount).toBe(2);
    // Averages reflect both rows
    expect(result.metricSummary?.avgFaithfulness).toBeCloseTo(0.8);
    expect(result.metricSummary?.avgGroundedness).toBeCloseTo(0.7);
    expect(result.metricSummary?.avgRelevance).toBeCloseTo(0.75);
  });

  it('swallows per-log scoreResponse errors and continues with later logs', async () => {
    findFirst.mockResolvedValueOnce(makeSession());
    findLogs.mockResolvedValueOnce([
      makeLog(1, { eventType: 'user_input', content: 'Q1' }),
      makeLog(2, { eventType: 'ai_response', content: 'A1' }),
      makeLog(3, { eventType: 'user_input', content: 'Q2' }),
      makeLog(4, { eventType: 'ai_response', content: 'A2' }),
    ]);
    const summaryChat = vi.fn().mockResolvedValueOnce(VALID_RESPONSE);
    mockedGetProvider.mockResolvedValueOnce(makeProvider(summaryChat));
    update.mockResolvedValueOnce({ id: 'sess-1' });
    updateLog.mockResolvedValue({});
    mockedScoreResponse
      .mockRejectedValueOnce(new Error('judge blew up'))
      .mockResolvedValueOnce(scoreResult());

    const result = await completeEvaluationSession({ sessionId: 'sess-1', userId: 'user-1' });

    expect(updateLog).toHaveBeenCalledTimes(1); // only log-4 persisted
    expect(updateLog.mock.calls[0][0].where.id).toBe('log-4');
    expect(result.metricSummary?.scoredLogCount).toBe(1);
  });

  it('skips non-ai_response events (e.g. capability_call) when iterating logs', async () => {
    findFirst.mockResolvedValueOnce(makeSession());
    findLogs.mockResolvedValueOnce([
      makeLog(1, { eventType: 'user_input', content: 'Q' }),
      makeLog(2, { eventType: 'capability_call', content: 'tool', capabilitySlug: 'search' }),
      makeLog(3, { eventType: 'ai_response', content: 'A' }),
    ]);
    const summaryChat = vi.fn().mockResolvedValueOnce(VALID_RESPONSE);
    mockedGetProvider.mockResolvedValueOnce(makeProvider(summaryChat));
    update.mockResolvedValueOnce({ id: 'sess-1' });
    updateLog.mockResolvedValue({});

    await completeEvaluationSession({ sessionId: 'sess-1', userId: 'user-1' });

    expect(mockedScoreResponse).toHaveBeenCalledTimes(1);
  });

  it('skips an ai_response with no preceding user_input', async () => {
    findFirst.mockResolvedValueOnce(makeSession());
    findLogs.mockResolvedValueOnce([
      makeLog(1, { eventType: 'ai_response', content: 'Orphaned.' }),
      makeLog(2, { eventType: 'user_input', content: 'Q' }),
      makeLog(3, { eventType: 'ai_response', content: 'Proper' }),
    ]);
    const summaryChat = vi.fn().mockResolvedValueOnce(VALID_RESPONSE);
    mockedGetProvider.mockResolvedValueOnce(makeProvider(summaryChat));
    update.mockResolvedValueOnce({ id: 'sess-1' });
    updateLog.mockResolvedValue({});

    await completeEvaluationSession({ sessionId: 'sess-1', userId: 'user-1' });

    expect(mockedScoreResponse).toHaveBeenCalledTimes(1);
    expect(mockedScoreResponse.mock.calls[0][0].userQuestion).toBe('Q');
  });

  it('excludes null per-metric scores from the aggregate averages', async () => {
    findFirst.mockResolvedValueOnce(makeSession());
    findLogs.mockResolvedValueOnce([
      makeLog(1, { eventType: 'user_input', content: 'Q' }),
      makeLog(2, { eventType: 'ai_response', content: 'A (no markers)' }),
    ]);
    const summaryChat = vi.fn().mockResolvedValueOnce(VALID_RESPONSE);
    mockedGetProvider.mockResolvedValueOnce(makeProvider(summaryChat));
    update.mockResolvedValueOnce({ id: 'sess-1' });
    updateLog.mockResolvedValue({});
    mockedScoreResponse.mockResolvedValueOnce(
      scoreResult({
        faithfulness: null,
        groundedness: 0.7,
        relevance: 1,
      })
    );

    const result = await completeEvaluationSession({ sessionId: 'sess-1', userId: 'user-1' });

    expect(result.metricSummary?.avgFaithfulness).toBeNull();
    expect(result.metricSummary?.avgGroundedness).toBeCloseTo(0.7);
    expect(result.metricSummary?.avgRelevance).toBeCloseTo(1);
  });
});

describe('extractLogCitations — defensive validation', () => {
  it('passes empty citations to scoreResponse when metadata.citations is malformed', async () => {
    findFirst.mockResolvedValueOnce(makeSession());
    findLogs.mockResolvedValueOnce([
      makeLog(1, { eventType: 'user_input', content: 'Q' }),
      makeLog(2, {
        eventType: 'ai_response',
        content: 'A',
        metadata: { citations: { marker: 1, excerpt: 'Body.' } }, // not an array
      }),
    ]);
    const summaryChat = vi.fn().mockResolvedValueOnce(VALID_RESPONSE);
    mockedGetProvider.mockResolvedValueOnce(makeProvider(summaryChat));
    update.mockResolvedValueOnce({ id: 'sess-1' });
    updateLog.mockResolvedValue({});

    await completeEvaluationSession({ sessionId: 'sess-1', userId: 'user-1' });

    expect(mockedScoreResponse).toHaveBeenCalledTimes(1);
    expect(mockedScoreResponse.mock.calls[0][0].citations).toEqual([]);
  });
});

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
