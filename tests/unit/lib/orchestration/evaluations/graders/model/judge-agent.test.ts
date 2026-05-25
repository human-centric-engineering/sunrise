/**
 * Unit tests for the `judge_agent` model grader.
 *
 * Mocks `drainStreamChat` at the module boundary — the grader's whole job
 * is to assemble the structured user message, hand it to drainStreamChat,
 * and translate the drain result into a `GraderResult`. Tests assert on
 * both directions: the payload going IN and the shape coming OUT.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/orchestration/evaluations/drain-stream-chat', () => ({
  drainStreamChat: vi.fn(),
}));

const { drainStreamChat } = await import('@/lib/orchestration/evaluations/drain-stream-chat');
const { judgeAgentGrader } =
  await import('@/lib/orchestration/evaluations/graders/model/judge-agent');

const mockedDrain = drainStreamChat as unknown as ReturnType<typeof vi.fn>;

interface PartialDrainResult {
  assistantText?: string;
  tokenUsage?: { input: number; output: number };
  costUsd?: number;
  errorCode?: string;
  errorMessage?: string;
}

function drainOk(overrides: PartialDrainResult = {}) {
  return {
    assistantText: overrides.assistantText ?? '{"score":0.9,"reasoning":"ok"}',
    citations: [],
    toolCalls: [],
    tokenUsage: overrides.tokenUsage ?? { input: 10, output: 5 },
    costUsd: overrides.costUsd ?? 0.0012,
    latencyMs: 100,
  };
}

function drainErr(overrides: PartialDrainResult = {}) {
  return {
    assistantText: overrides.assistantText ?? '',
    citations: [],
    toolCalls: [],
    tokenUsage: overrides.tokenUsage ?? { input: 4, output: 0 },
    costUsd: overrides.costUsd ?? 0.0001,
    latencyMs: 50,
    errorCode: overrides.errorCode ?? 'PROVIDER_DOWN',
    errorMessage: overrides.errorMessage,
  };
}

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    userInput: 'What is the refund window?',
    modelOutput: 'Refunds are available within 30 days.',
    config: { agentSlug: 'eval-judge-relevance' } as z.infer<typeof judgeAgentGrader.configSchema>,
    judge: { userId: 'user-1' },
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('judge_agent grader — skip path', () => {
  it('returns null when no judge user context is passed', async () => {
    const result = await judgeAgentGrader.grade({
      ...baseInput({ judge: undefined }),
    });
    expect(result.score).toBeNull();
    expect(result.reasoning).toMatch(/no judge user context/i);
    expect(mockedDrain).not.toHaveBeenCalled();
  });
});

describe('judge_agent grader — drainStreamChat dispatch', () => {
  it('builds the structured user message with QUESTION + ANSWER only when nothing else is set', async () => {
    mockedDrain.mockResolvedValueOnce(drainOk());

    await judgeAgentGrader.grade({ ...baseInput() });

    expect(mockedDrain).toHaveBeenCalledTimes(1);
    const call = mockedDrain.mock.calls[0][0] as {
      agentSlug: string;
      userId: string;
      message: string;
      entityContext: Record<string, unknown>;
    };
    expect(call.agentSlug).toBe('eval-judge-relevance');
    expect(call.userId).toBe('user-1');
    expect(call.message).toContain('QUESTION: What is the refund window?');
    expect(call.message).toContain('ANSWER: Refunds are available within 30 days.');
    expect(call.message).not.toContain('EXPECTED ANSWER');
    expect(call.message).not.toContain('CITED SOURCES');
    expect(call.message).not.toContain('TOOL CALLS');
    expect(call.message).not.toContain('SUBJECT BRAND VOICE');
  });

  it('includes EXPECTED ANSWER / CITED SOURCES / TOOL CALLS / SUBJECT BRAND VOICE when provided', async () => {
    mockedDrain.mockResolvedValueOnce(drainOk());

    await judgeAgentGrader.grade({
      ...baseInput({
        expectedOutput: '30-day refund window.',
        citations: [{ marker: 1, documentName: 'Policy.pdf', excerpt: 'You may return…' }],
        toolCalls: [{ slug: 'lookup_policy', args: { id: 'pol-1' } }],
        config: {
          agentSlug: 'eval-judge-brand-voice',
          subjectBrandVoice: 'Warm and concise.',
        },
      }),
    });

    const message = (mockedDrain.mock.calls[0][0] as { message: string }).message;
    expect(message).toContain('EXPECTED ANSWER: 30-day refund window.');
    expect(message).toContain('CITED SOURCES:');
    expect(message).toContain('Policy.pdf');
    expect(message).toContain('TOOL CALLS:');
    expect(message).toContain('lookup_policy');
    expect(message).toContain('SUBJECT BRAND VOICE: Warm and concise.');
  });

  it('passes entityContext.source=evaluation_judge with the judge agent slug', async () => {
    mockedDrain.mockResolvedValueOnce(drainOk());

    await judgeAgentGrader.grade({
      ...baseInput({ config: { agentSlug: 'eval-judge-faithfulness' } }),
    });

    const call = mockedDrain.mock.calls[0][0] as {
      entityContext: { source: string; judgeAgentSlug: string };
    };
    expect(call.entityContext).toEqual({
      source: 'evaluation_judge',
      judgeAgentSlug: 'eval-judge-faithfulness',
    });
  });

  it('omits costLogMetadata when judge.evaluationRunId is absent (back-compat)', async () => {
    mockedDrain.mockResolvedValueOnce(drainOk());

    await judgeAgentGrader.grade({ ...baseInput() });

    const call = mockedDrain.mock.calls[0][0] as Record<string, unknown>;
    expect(call).not.toHaveProperty('costLogMetadata');
  });

  it('tags costLogMetadata with role=judge + the run id + judge slug when run id is set', async () => {
    mockedDrain.mockResolvedValueOnce(drainOk());

    await judgeAgentGrader.grade({
      ...baseInput({
        config: { agentSlug: 'eval-judge-relevance' },
        judge: { userId: 'user-1', evaluationRunId: 'run-77' },
      }),
    });

    const call = mockedDrain.mock.calls[0][0] as {
      costLogMetadata: Record<string, unknown>;
    };
    expect(call.costLogMetadata).toEqual({
      evaluationRunId: 'run-77',
      role: 'judge',
      judgeAgentSlug: 'eval-judge-relevance',
    });
  });
});

describe('judge_agent grader — response parsing', () => {
  it('produces score + reasoning + evaluationSteps for a valid JSON response', async () => {
    mockedDrain.mockResolvedValueOnce(
      drainOk({
        assistantText: JSON.stringify({
          score: 0.75,
          reasoning: 'Marked claims are supported by sources.',
          evaluation_steps: ['Step 1', 'Step 2', 'Step 3'],
        }),
        tokenUsage: { input: 120, output: 60 },
        costUsd: 0.0042,
      })
    );

    const result = await judgeAgentGrader.grade({ ...baseInput() });

    expect(result.score).toBe(0.75);
    expect(result.reasoning).toBe('Marked claims are supported by sources.');
    expect(result.evaluationSteps).toEqual(['Step 1', 'Step 2', 'Step 3']);
    expect(result.tokenUsage).toEqual({ input: 120, output: 60 });
    expect(result.costUsd).toBe(0.0042);
  });

  it('keeps score=null when the judge explicitly returns null (e.g. missing markers)', async () => {
    mockedDrain.mockResolvedValueOnce(
      drainOk({
        assistantText: JSON.stringify({
          score: null,
          reasoning: 'No marked claims to evaluate.',
        }),
      })
    );

    const result = await judgeAgentGrader.grade({ ...baseInput() });

    expect(result.score).toBeNull();
    expect(result.reasoning).toBe('No marked claims to evaluate.');
    expect(result.evaluationSteps).toBeUndefined();
  });

  it('returns score:null with a descriptive reasoning when the judge response is malformed JSON', async () => {
    mockedDrain.mockResolvedValueOnce(drainOk({ assistantText: 'not valid json {{' }));

    const result = await judgeAgentGrader.grade({ ...baseInput() });

    expect(result.score).toBeNull();
    expect(result.reasoning).toMatch(/not valid \{score, reasoning\} JSON/i);
  });
});

describe('judge_agent grader — drainStreamChat error', () => {
  it('returns score:null + an error-style reasoning when drainStreamChat reports errorCode', async () => {
    mockedDrain.mockResolvedValueOnce(
      drainErr({
        errorCode: 'PROVIDER_DOWN',
        errorMessage: 'Anthropic returned 503',
        costUsd: 0.0001,
        tokenUsage: { input: 4, output: 0 },
      })
    );

    const result = await judgeAgentGrader.grade({ ...baseInput() });

    expect(result.score).toBeNull();
    expect(result.reasoning).toMatch(/judge_agent error: PROVIDER_DOWN/);
    expect(result.reasoning).toMatch(/Anthropic returned 503/);
    expect(result.costUsd).toBe(0.0001);
    expect(result.tokenUsage).toEqual({ input: 4, output: 0 });
  });

  it('omits the dash-suffix when errorCode is set but errorMessage is missing', async () => {
    mockedDrain.mockResolvedValueOnce(
      drainErr({ errorCode: 'RATE_LIMITED', errorMessage: undefined })
    );

    const result = await judgeAgentGrader.grade({ ...baseInput() });

    expect(result.score).toBeNull();
    expect(result.reasoning).toBe('judge_agent error: RATE_LIMITED');
  });
});

describe('judge_agent grader — registry metadata', () => {
  it('exposes the slug, family, and defaults expected by the run-creation UI', () => {
    expect(judgeAgentGrader.slug).toBe('judge_agent');
    expect(judgeAgentGrader.family).toBe('model');
    expect(judgeAgentGrader.referenceRequired).toBe(false);
    expect(judgeAgentGrader.defaultConfig).toEqual({ agentSlug: '' });
    expect(typeof judgeAgentGrader.description).toBe('string');
  });
});
