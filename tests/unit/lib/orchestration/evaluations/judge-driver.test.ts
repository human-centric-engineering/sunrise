/**
 * Tests: driving a judge agent and shaping its verdict.
 *
 * `driveJudgeAgent` never throws on a chat-layer failure or a bad reply; it
 * folds both into `score: null` with an `errorCode`. These pin that shape and
 * the provider's retriable verdict riding along with it (§77 t-747), which
 * the `judge_call` step reads to decide a retry. `drainStreamChat` is mocked
 * at the module boundary.
 *
 * @see lib/orchestration/evaluations/judge-driver.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/orchestration/evaluations/drain-stream-chat', () => ({
  drainStreamChat: vi.fn(),
}));
vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { driveJudgeAgent } from '@/lib/orchestration/evaluations/judge-driver';
import { drainStreamChat } from '@/lib/orchestration/evaluations/drain-stream-chat';

const INPUT = { agentSlug: 'eval-judge-correctness', userId: 'user_1', question: 'Q', answer: 'A' };

function drained(overrides: Record<string, unknown> = {}) {
  return {
    assistantText: '',
    citations: [],
    toolCalls: [],
    tokenUsage: { input: 10, output: 5 },
    costUsd: 0.001,
    latencyMs: 1,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('driveJudgeAgent', () => {
  it('returns the judge’s score and reasoning', async () => {
    vi.mocked(drainStreamChat).mockResolvedValue(
      drained({ assistantText: '{"score": 0.9, "reasoning": "good"}' })
    );

    const result = await driveJudgeAgent(INPUT);

    expect(result).toMatchObject({ score: 0.9, reasoning: 'good' });
    expect(result).not.toHaveProperty('errorCode');
  });

  it('keeps a deliberate null score as null, with no errorCode: the criterion did not apply', async () => {
    vi.mocked(drainStreamChat).mockResolvedValue(
      drained({ assistantText: '{"score": null, "reasoning": "no citations on the response"}' })
    );

    const result = await driveJudgeAgent(INPUT);

    expect(result).toMatchObject({ score: null, reasoning: 'no citations on the response' });
    expect(result).not.toHaveProperty('errorCode');
  });

  it('folds a reply that is not {score, reasoning} JSON into malformed_judge_response', async () => {
    vi.mocked(drainStreamChat).mockResolvedValue(drained({ assistantText: 'I think it is fine' }));

    const result = await driveJudgeAgent(INPUT);

    expect(result).toMatchObject({ score: null, errorCode: 'malformed_judge_response' });
    expect(result).not.toHaveProperty('retriable');
  });

  it.each([false, true])(
    'folds a chat-layer failure into its errorCode, with the provider’s verdict (%s)',
    async (verdict) => {
      vi.mocked(drainStreamChat).mockResolvedValue(
        drained({ errorCode: 'http_401', errorMessage: 'invalid key', errorRetriable: verdict })
      );

      const result = await driveJudgeAgent(INPUT);

      expect(result).toMatchObject({
        score: null,
        errorCode: 'http_401',
        retriable: verdict,
        reasoning: 'judge call error: http_401 — invalid key',
      });
    }
  );

  it('leaves the verdict out when the failure had none', async () => {
    vi.mocked(drainStreamChat).mockResolvedValue(drained({ errorCode: 'agent_not_found' }));

    const result = await driveJudgeAgent(INPUT);

    expect(result).toMatchObject({ errorCode: 'agent_not_found' });
    expect(result).not.toHaveProperty('retriable');
  });
});
