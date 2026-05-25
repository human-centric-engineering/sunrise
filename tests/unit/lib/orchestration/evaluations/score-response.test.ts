/**
 * Unit tests for `scoreResponse` — the manual-session per-turn scorer.
 *
 * `drainStreamChat` is mocked at the module boundary; the three seeded
 * judge agents (faithfulness, groundedness, relevance) are exercised
 * indirectly via the slugs the scorer hands to drainStreamChat. Tests
 * assert dispatch, payload shape, aggregate cost, and per-metric
 * degradation behaviour.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Citation } from '@/types/orchestration';

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/orchestration/evaluations/drain-stream-chat', () => ({
  drainStreamChat: vi.fn(),
}));

const { drainStreamChat } = await import('@/lib/orchestration/evaluations/drain-stream-chat');
const { scoreResponse, MANUAL_SESSION_JUDGE_SLUGS } =
  await import('@/lib/orchestration/evaluations/score-response');

const mockedDrain = drainStreamChat as unknown as ReturnType<typeof vi.fn>;

interface PartialDrain {
  assistantText?: string;
  costUsd?: number;
  errorCode?: string;
  errorMessage?: string;
}

function drainOk(overrides: PartialDrain = {}) {
  return {
    assistantText: overrides.assistantText ?? JSON.stringify({ score: 0.8, reasoning: 'ok' }),
    citations: [],
    toolCalls: [],
    tokenUsage: { input: 40, output: 20 },
    costUsd: overrides.costUsd ?? 0.001,
    latencyMs: 80,
  };
}

function drainErr(overrides: PartialDrain = {}) {
  return {
    assistantText: '',
    citations: [],
    toolCalls: [],
    tokenUsage: { input: 4, output: 0 },
    costUsd: overrides.costUsd ?? 0.0001,
    latencyMs: 40,
    errorCode: overrides.errorCode ?? 'PROVIDER_DOWN',
    errorMessage: overrides.errorMessage ?? 'no provider configured',
  };
}

const SAMPLE_CITATIONS: Citation[] = [
  {
    marker: 1,
    chunkId: 'c1',
    documentId: 'd1',
    documentName: 'Refund Policy',
    contentHash: null,
    documentVersion: null,
    section: '3.1',
    patternNumber: null,
    patternName: null,
    excerpt: 'You may return items within 30 days.',
    similarity: 0.91,
  },
];

const BASE_PARAMS = {
  userQuestion: 'What is the refund window?',
  aiResponse: 'You can refund within 30 days [1].',
  citations: SAMPLE_CITATIONS,
  userId: 'user-1',
};

beforeEach(() => {
  vi.resetAllMocks();
});

describe('scoreResponse — happy path', () => {
  it('dispatches one drainStreamChat per judge in parallel, returns combined MetricScores', async () => {
    mockedDrain
      .mockResolvedValueOnce(
        drainOk({
          assistantText: JSON.stringify({ score: 0.9, reasoning: 'faithful' }),
          costUsd: 0.001,
        })
      )
      .mockResolvedValueOnce(
        drainOk({
          assistantText: JSON.stringify({ score: 0.8, reasoning: 'grounded' }),
          costUsd: 0.002,
        })
      )
      .mockResolvedValueOnce(
        drainOk({
          assistantText: JSON.stringify({ score: 0.95, reasoning: 'relevant' }),
          costUsd: 0.003,
        })
      );

    const result = await scoreResponse(BASE_PARAMS);

    expect(mockedDrain).toHaveBeenCalledTimes(3);
    const slugsCalled = mockedDrain.mock.calls.map(
      (c) => (c[0] as { agentSlug: string }).agentSlug
    );
    expect(slugsCalled).toContain(MANUAL_SESSION_JUDGE_SLUGS.faithfulness);
    expect(slugsCalled).toContain(MANUAL_SESSION_JUDGE_SLUGS.groundedness);
    expect(slugsCalled).toContain(MANUAL_SESSION_JUDGE_SLUGS.relevance);

    expect(result.scores.faithfulness).toMatchObject({ score: 0.9, reasoning: 'faithful' });
    expect(result.scores.groundedness).toMatchObject({ score: 0.8, reasoning: 'grounded' });
    expect(result.scores.relevance).toMatchObject({ score: 0.95, reasoning: 'relevant' });
    // costUsd is the SUM of the three calls.
    expect(result.costUsd).toBeCloseTo(0.006);
  });

  it('passes QUESTION + ANSWER + CITED SOURCES + entityContext to every judge call', async () => {
    mockedDrain.mockResolvedValue(drainOk());

    await scoreResponse(BASE_PARAMS);

    for (const [arg] of mockedDrain.mock.calls) {
      const call = arg as {
        agentSlug: string;
        userId: string;
        message: string;
        entityContext: { source: string; judgeAgentSlug: string };
      };
      expect(call.userId).toBe('user-1');
      expect(call.message).toContain('QUESTION: What is the refund window?');
      expect(call.message).toContain('ANSWER: You can refund within 30 days [1].');
      expect(call.message).toContain('CITED SOURCES:');
      expect(call.message).toContain('Refund Policy');
      // entityContext tags every call as an evaluation_judge conversation so
      // the conversations list can filter them out by default.
      expect(call.entityContext).toEqual({
        source: 'evaluation_judge',
        judgeAgentSlug: call.agentSlug,
      });
    }
  });

  it('omits CITED SOURCES when no citations are supplied', async () => {
    mockedDrain.mockResolvedValue(drainOk());

    await scoreResponse({ ...BASE_PARAMS, citations: [] });

    for (const [arg] of mockedDrain.mock.calls) {
      const message = (arg as { message: string }).message;
      expect(message).not.toContain('CITED SOURCES');
    }
  });

  it('surfaces evaluation_steps when a judge returns them', async () => {
    mockedDrain
      .mockResolvedValueOnce(
        drainOk({
          assistantText: JSON.stringify({
            score: 0.8,
            reasoning: 'ok',
            evaluation_steps: ['extracted claim', 'looked up source', 'compared'],
          }),
        })
      )
      .mockResolvedValueOnce(drainOk())
      .mockResolvedValueOnce(drainOk());

    const result = await scoreResponse(BASE_PARAMS);

    // The faithfulness slug is dispatched first in scoreResponse's Promise.all.
    expect(result.scores.faithfulness.evaluationSteps).toEqual([
      'extracted claim',
      'looked up source',
      'compared',
    ]);
    // Other judges did not return steps → no evaluationSteps key.
    expect(result.scores.groundedness.evaluationSteps).toBeUndefined();
    expect(result.scores.relevance.evaluationSteps).toBeUndefined();
  });

  it('preserves an explicit null score returned by a judge (e.g. faithfulness with no markers)', async () => {
    mockedDrain
      .mockResolvedValueOnce(
        drainOk({
          assistantText: JSON.stringify({
            score: null,
            reasoning: 'No marked claims to evaluate.',
          }),
        })
      )
      .mockResolvedValueOnce(drainOk())
      .mockResolvedValueOnce(drainOk());

    const result = await scoreResponse(BASE_PARAMS);

    expect(result.scores.faithfulness).toEqual({
      score: null,
      reasoning: 'No marked claims to evaluate.',
    });
    expect(result.scores.groundedness.score).toBe(0.8);
    expect(result.scores.relevance.score).toBe(0.8);
  });
});

describe('scoreResponse — partial failure', () => {
  it('returns a null-score MetricScore for the failing judge and keeps the other two', async () => {
    // Faithfulness throws; the other two succeed.
    mockedDrain
      .mockRejectedValueOnce(new Error('network hiccup'))
      .mockResolvedValueOnce(
        drainOk({ assistantText: JSON.stringify({ score: 0.7, reasoning: 'grounded' }) })
      )
      .mockResolvedValueOnce(
        drainOk({ assistantText: JSON.stringify({ score: 0.85, reasoning: 'relevant' }) })
      );

    const result = await scoreResponse(BASE_PARAMS);

    expect(result.scores.faithfulness.score).toBeNull();
    expect(result.scores.faithfulness.reasoning).toMatch(/judge unavailable.*network hiccup/);
    expect(result.scores.groundedness.score).toBe(0.7);
    expect(result.scores.relevance.score).toBe(0.85);
  });

  it('returns a null-score with the errorCode in the reasoning when drainStreamChat reports an error', async () => {
    mockedDrain
      .mockResolvedValueOnce(drainErr({ errorCode: 'PROVIDER_DOWN', errorMessage: 'down' }))
      .mockResolvedValueOnce(drainOk())
      .mockResolvedValueOnce(drainOk());

    const result = await scoreResponse(BASE_PARAMS);

    expect(result.scores.faithfulness.score).toBeNull();
    expect(result.scores.faithfulness.reasoning).toMatch(/judge unavailable.*down/);
  });

  it('returns a null-score MetricScore (not a throw) when one judge returns malformed JSON', async () => {
    mockedDrain
      .mockResolvedValueOnce(drainOk({ assistantText: 'not json at all' }))
      .mockResolvedValueOnce(drainOk())
      .mockResolvedValueOnce(drainOk());

    const result = await scoreResponse(BASE_PARAMS);

    expect(result.scores.faithfulness.score).toBeNull();
    expect(result.scores.faithfulness.reasoning).toMatch(/not valid \{score, reasoning\} JSON/);
    // The other two judges still produced their happy-path scores.
    expect(result.scores.groundedness.score).toBe(0.8);
    expect(result.scores.relevance.score).toBe(0.8);
  });

  it('sums costUsd across successful and failed calls', async () => {
    mockedDrain
      .mockRejectedValueOnce(new Error('network down')) // thrown calls contribute 0 cost
      .mockResolvedValueOnce(drainOk({ costUsd: 0.004 }))
      .mockResolvedValueOnce(drainErr({ costUsd: 0.0005, errorCode: 'PROVIDER_DOWN' }));

    const result = await scoreResponse(BASE_PARAMS);

    expect(result.costUsd).toBeCloseTo(0.004 + 0.0005);
  });
});

describe('scoreResponse — parser edge cases', () => {
  it('rejects a response whose JSON parses but reasoning is not a string (score:null)', async () => {
    mockedDrain
      .mockResolvedValueOnce(
        drainOk({ assistantText: JSON.stringify({ score: 0.5, reasoning: 42 }) })
      )
      .mockResolvedValueOnce(drainOk())
      .mockResolvedValueOnce(drainOk());

    const result = await scoreResponse(BASE_PARAMS);

    expect(result.scores.faithfulness.score).toBeNull();
    expect(result.scores.faithfulness.reasoning).toMatch(/not valid \{score, reasoning\} JSON/);
  });

  it('rejects a numeric score outside the [0, 1] range', async () => {
    mockedDrain
      .mockResolvedValueOnce(
        drainOk({ assistantText: JSON.stringify({ score: 1.7, reasoning: 'too high' }) })
      )
      .mockResolvedValueOnce(drainOk())
      .mockResolvedValueOnce(drainOk());

    const result = await scoreResponse(BASE_PARAMS);

    expect(result.scores.faithfulness.score).toBeNull();
    expect(result.scores.faithfulness.reasoning).toMatch(/not valid \{score, reasoning\} JSON/);
  });

  it('rejects a non-finite score (NaN/Infinity)', async () => {
    mockedDrain
      .mockResolvedValueOnce(
        // JSON.stringify cannot encode NaN; use a string the judge might
        // emit that round-trips through JSON.parse to a non-number.
        drainOk({ assistantText: '{"score":"nope","reasoning":"bad"}' })
      )
      .mockResolvedValueOnce(drainOk())
      .mockResolvedValueOnce(drainOk());

    const result = await scoreResponse(BASE_PARAMS);

    expect(result.scores.faithfulness.score).toBeNull();
    expect(result.scores.faithfulness.reasoning).toMatch(/not valid \{score, reasoning\} JSON/);
  });

  it('rejects a non-object JSON payload (e.g. bare string)', async () => {
    mockedDrain
      .mockResolvedValueOnce(drainOk({ assistantText: '"just a string"' }))
      .mockResolvedValueOnce(drainOk())
      .mockResolvedValueOnce(drainOk());

    const result = await scoreResponse(BASE_PARAMS);

    expect(result.scores.faithfulness.score).toBeNull();
    expect(result.scores.faithfulness.reasoning).toMatch(/not valid \{score, reasoning\} JSON/);
  });

  it('truncates excerpts longer than the prompt cap', async () => {
    mockedDrain.mockResolvedValue(drainOk());

    const longCitation: Citation = {
      ...SAMPLE_CITATIONS[0],
      excerpt: 'x'.repeat(900),
    };
    await scoreResponse({ ...BASE_PARAMS, citations: [longCitation] });

    const message = (mockedDrain.mock.calls[0][0] as { message: string }).message;
    // Cap is 600 chars in the source; the trailing ellipsis is the truncation marker.
    expect(message).toContain('…');
    expect(message).not.toContain('x'.repeat(601));
  });

  it('does not truncate excerpts within the cap', async () => {
    mockedDrain.mockResolvedValue(drainOk());

    const shortCitation: Citation = {
      ...SAMPLE_CITATIONS[0],
      excerpt: 'short text',
    };
    await scoreResponse({ ...BASE_PARAMS, citations: [shortCitation] });

    const message = (mockedDrain.mock.calls[0][0] as { message: string }).message;
    expect(message).toContain('short text');
    // No ellipsis injected for an under-cap excerpt (the response JSON has none either).
    expect(message.includes('short text…')).toBe(false);
  });
});

describe('scoreResponse — total failure', () => {
  it('throws an aggregated message naming every judge when all three fail', async () => {
    mockedDrain
      .mockRejectedValueOnce(new Error('faithfulness blew up'))
      .mockRejectedValueOnce(new Error('groundedness blew up'))
      .mockRejectedValueOnce(new Error('relevance blew up'));

    // Regression test for the dead-error fix on the PR #237 review:
    // previously only the faithfulness judge's message ever surfaced.
    // All three judge slugs must appear in the thrown message.
    const err = await scoreResponse(BASE_PARAMS).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(msg).toContain('All three judges failed to produce a score');
    expect(msg).toContain('faithfulness:');
    expect(msg).toContain('groundedness:');
    expect(msg).toContain('relevance:');
  });

  it('throws even when all three calls return a stream errorCode (no thrown exception)', async () => {
    mockedDrain
      .mockResolvedValueOnce(drainErr({ errorCode: 'PROVIDER_DOWN', errorMessage: 'down 1' }))
      .mockResolvedValueOnce(drainErr({ errorCode: 'PROVIDER_DOWN', errorMessage: 'down 2' }))
      .mockResolvedValueOnce(drainErr({ errorCode: 'PROVIDER_DOWN', errorMessage: 'down 3' }));

    const err = await scoreResponse(BASE_PARAMS).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    // The per-judge errorMessages should be aggregated into one throw.
    const msg = (err as Error).message;
    expect(msg).toContain('down 1');
    expect(msg).toContain('down 2');
    expect(msg).toContain('down 3');
  });
});
