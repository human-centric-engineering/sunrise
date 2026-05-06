/**
 * Unit tests for scoreResponse — the LLM-as-judge metric scorer.
 *
 * Covers:
 *  - happy path: judge returns valid scores for all three metrics
 *  - faithfulness can be null (no inline markers in the answer)
 *  - score outside [0,1] is rejected → retry → success
 *  - missing reasoning string is rejected → retry → success
 *  - judge model context: citations array passed to the prompt is
 *    truncated (excerpt length) and capped (count)
 *  - terminal failure: malformed both attempts → throws sanitized error
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/orchestration/llm/cost-tracker', () => ({
  calculateCost: vi.fn(() => ({
    inputCostUsd: 0.001,
    outputCostUsd: 0.002,
    totalCostUsd: 0.003,
  })),
}));

const { scoreResponse } = await import('@/lib/orchestration/evaluations/score-response');

function makeJudge(
  scripts: Array<{ content: string; usage?: { inputTokens: number; outputTokens: number } }>
) {
  let turn = 0;
  return {
    chat: vi.fn(async () => {
      const s = scripts[turn] ?? scripts[scripts.length - 1];
      turn++;
      return {
        content: s.content,
        usage: s.usage ?? { inputTokens: 50, outputTokens: 30 },
      };
    }),
  } as unknown as Parameters<typeof scoreResponse>[0]['judgeProvider'];
}

const baseCitation = {
  marker: 1,
  chunkId: 'c1',
  documentId: 'd1',
  documentName: 'Doc',
  section: 'Page 1',
  patternNumber: null,
  patternName: null,
  excerpt: 'Body of citation 1.',
  similarity: 0.9,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('scoreResponse', () => {
  it('returns all three scores when the judge responds with valid JSON', async () => {
    const judgeProvider = makeJudge([
      {
        content: JSON.stringify({
          faithfulness: { score: 0.95, reasoning: 'All marked claims supported.' },
          groundedness: { score: 0.85, reasoning: 'Most claims traceable.' },
          relevance: { score: 0.9, reasoning: 'Direct answer.' },
        }),
        usage: { inputTokens: 200, outputTokens: 60 },
      },
    ]);
    const result = await scoreResponse({
      userQuestion: 'What is X?',
      aiResponse: 'X is Y [1].',
      citations: [baseCitation],
      judgeProvider,
      judgeModel: 'claude-sonnet-4-6',
    });
    expect(result.scores.faithfulness).toEqual({
      score: 0.95,
      reasoning: 'All marked claims supported.',
    });
    expect(result.scores.groundedness.score).toBe(0.85);
    expect(result.scores.relevance.score).toBe(0.9);
    expect(result.tokenUsage).toEqual({ input: 200, output: 60 });
  });

  it('accepts null faithfulness score when there are no inline markers', async () => {
    const judgeProvider = makeJudge([
      {
        content: JSON.stringify({
          faithfulness: { score: null, reasoning: 'no inline citations to evaluate' },
          groundedness: { score: 0.7, reasoning: 'OK.' },
          relevance: { score: 1, reasoning: 'Direct.' },
        }),
      },
    ]);
    const result = await scoreResponse({
      userQuestion: 'Hi',
      aiResponse: 'Hello back.',
      citations: [],
      judgeProvider,
      judgeModel: 'claude-sonnet-4-6',
    });
    expect(result.scores.faithfulness.score).toBeNull();
    expect(result.scores.groundedness.score).toBe(0.7);
  });

  it('rejects out-of-range scores → retries → succeeds on second attempt', async () => {
    const judgeProvider = makeJudge([
      {
        content: JSON.stringify({
          faithfulness: { score: 1.5, reasoning: 'too high' }, // invalid
          groundedness: { score: 0.5, reasoning: 'meh' },
          relevance: { score: 0.7, reasoning: 'partial' },
        }),
      },
      {
        content: JSON.stringify({
          faithfulness: { score: 0.9, reasoning: 'fixed.' },
          groundedness: { score: 0.5, reasoning: 'meh' },
          relevance: { score: 0.7, reasoning: 'partial' },
        }),
      },
    ]);
    const result = await scoreResponse({
      userQuestion: 'Q',
      aiResponse: 'A',
      citations: [baseCitation],
      judgeProvider,
      judgeModel: 'claude-sonnet-4-6',
    });
    expect((judgeProvider.chat as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
    expect(result.scores.faithfulness.score).toBe(0.9);
  });

  it('rejects missing reasoning → retries → succeeds', async () => {
    const judgeProvider = makeJudge([
      {
        content: JSON.stringify({
          faithfulness: { score: 0.9 }, // missing reasoning
          groundedness: { score: 0.7, reasoning: 'OK' },
          relevance: { score: 0.8, reasoning: 'OK' },
        }),
      },
      {
        content: JSON.stringify({
          faithfulness: { score: 0.9, reasoning: 'now with reasoning' },
          groundedness: { score: 0.7, reasoning: 'OK' },
          relevance: { score: 0.8, reasoning: 'OK' },
        }),
      },
    ]);
    const result = await scoreResponse({
      userQuestion: 'Q',
      aiResponse: 'A',
      citations: [],
      judgeProvider,
      judgeModel: 'claude-sonnet-4-6',
    });
    expect(result.scores.faithfulness.reasoning).toBe('now with reasoning');
  });

  it('throws a sanitized error when both attempts fail', async () => {
    const judgeProvider = makeJudge([
      { content: 'definitely not json' },
      { content: 'also not json' },
    ]);
    await expect(
      scoreResponse({
        userQuestion: 'Q',
        aiResponse: 'A',
        citations: [],
        judgeProvider,
        judgeModel: 'claude-sonnet-4-6',
      })
    ).rejects.toThrow('Judge response was not valid JSON after retry');
  });

  // Finding 8: parseMetricEntry defensive validation arms (L156, L167, L174, L176)
  // A judge response with non-object entry, non-string reasoning, null score without
  // allowNullScore, or rawScore outside [0,1] should all be treated as invalid —
  // the first attempt is rejected and retried; the second attempt succeeds.
  it('rejects a response where groundedness entry is non-object (null) → retries → succeeds', async () => {
    // Arrange — first response has groundedness=null (non-object, fails L156 branch);
    // second response is fully valid.
    const judgeProvider = makeJudge([
      {
        content: JSON.stringify({
          faithfulness: { score: 0.8, reasoning: 'OK' },
          groundedness: null, // triggers parseMetricEntry L156 → null → parseMetricScores returns null
          relevance: { score: 0.9, reasoning: 'OK' },
        }),
      },
      {
        content: JSON.stringify({
          faithfulness: { score: 0.8, reasoning: 'OK' },
          groundedness: { score: 0.7, reasoning: 'Fixed.' },
          relevance: { score: 0.9, reasoning: 'OK' },
        }),
      },
    ]);

    // Act
    const result = await scoreResponse({
      userQuestion: 'Q',
      aiResponse: 'A',
      citations: [],
      judgeProvider,
      judgeModel: 'claude-sonnet-4-6',
    });

    // Assert — first attempt was rejected (retried), second succeeded
    expect((judgeProvider.chat as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
    expect(result.scores.groundedness.score).toBe(0.7);
  });

  it('rejects a response where reasoning is missing (non-string) → retries → succeeds', async () => {
    // Arrange — first response has relevance.reasoning missing (non-string, fails L167 branch)
    const judgeProvider = makeJudge([
      {
        content: JSON.stringify({
          faithfulness: { score: 0.8, reasoning: 'OK' },
          groundedness: { score: 0.7, reasoning: 'OK' },
          relevance: { score: 0.9 }, // missing reasoning — triggers L167 → null
        }),
      },
      {
        content: JSON.stringify({
          faithfulness: { score: 0.8, reasoning: 'OK' },
          groundedness: { score: 0.7, reasoning: 'OK' },
          relevance: { score: 0.9, reasoning: 'Now present.' },
        }),
      },
    ]);

    // Act
    const result = await scoreResponse({
      userQuestion: 'Q',
      aiResponse: 'A',
      citations: [],
      judgeProvider,
      judgeModel: 'claude-sonnet-4-6',
    });

    // Assert — first attempt was rejected (retried), second succeeded
    expect((judgeProvider.chat as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
    expect(result.scores.relevance.reasoning).toBe('Now present.');
  });

  it('rejects a response where groundedness score is out of [0,1] range → retries → succeeds', async () => {
    // Arrange — first response has groundedness.score=1.5 (out of range, fails L176 branch)
    const judgeProvider = makeJudge([
      {
        content: JSON.stringify({
          faithfulness: { score: 0.8, reasoning: 'OK' },
          groundedness: { score: 1.5, reasoning: 'Too high' }, // out-of-range triggers L176 → null
          relevance: { score: 0.9, reasoning: 'OK' },
        }),
      },
      {
        content: JSON.stringify({
          faithfulness: { score: 0.8, reasoning: 'OK' },
          groundedness: { score: 0.6, reasoning: 'Fixed.' },
          relevance: { score: 0.9, reasoning: 'OK' },
        }),
      },
    ]);

    // Act
    const result = await scoreResponse({
      userQuestion: 'Q',
      aiResponse: 'A',
      citations: [baseCitation],
      judgeProvider,
      judgeModel: 'claude-sonnet-4-6',
    });

    // Assert — first attempt was rejected (retried), second succeeded
    expect((judgeProvider.chat as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
    expect(result.scores.groundedness.score).toBe(0.6);
  });

  it('truncates citation excerpts and caps citation count in the judge prompt', async () => {
    const longExcerpt = 'X'.repeat(2000);
    const manyCitations = Array.from({ length: 20 }, (_, i) => ({
      ...baseCitation,
      marker: i + 1,
      chunkId: `c${i + 1}`,
      excerpt: longExcerpt,
    }));
    const judgeProvider = makeJudge([
      {
        content: JSON.stringify({
          faithfulness: { score: 0.9, reasoning: 'OK' },
          groundedness: { score: 0.9, reasoning: 'OK' },
          relevance: { score: 0.9, reasoning: 'OK' },
        }),
      },
    ]);
    await scoreResponse({
      userQuestion: 'Q',
      aiResponse: 'A',
      citations: manyCitations,
      judgeProvider,
      judgeModel: 'claude-sonnet-4-6',
    });
    const userMsg = (
      (judgeProvider.chat as ReturnType<typeof vi.fn>).mock.calls[0][0] as Array<{
        role: string;
        content: string;
      }>
    ).find((m) => m.role === 'user');
    expect(userMsg).toBeDefined();
    // Cap: only 12 citations included.
    expect((userMsg!.content.match(/"marker":\s*\d+/g) ?? []).length).toBe(12);
    // Truncation: ellipsis present, no full 2000-char excerpt.
    expect(userMsg!.content).toContain('…');
    expect(userMsg!.content).not.toContain('X'.repeat(2000));
  });
});
