/**
 * Unit tests for parse-structured — the shared LLM-as-judge plumbing.
 *
 * Covers:
 *  - happy path (first attempt parses → no retry, summed tokens = first only)
 *  - malformed first → retry succeeds (tokens summed across both attempts,
 *    temperature dropped to 0 on retry)
 *  - malformed first AND retry → throws (with caller's onFinalFailure if
 *    supplied, otherwise default error)
 *  - tryParseJson tolerates code-fenced output
 *  - tryParseJson returns null when validate rejects every candidate
 *  - stripCodeFence strips ```json ... ``` and ``` ... ``` wrappers
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/orchestration/llm/cost-tracker', () => ({
  calculateCost: vi.fn(() => ({
    inputCostUsd: 0.001,
    outputCostUsd: 0.002,
    totalCostUsd: 0.003,
  })),
}));

const { runStructuredCompletion, tryParseJson, stripCodeFence } =
  await import('@/lib/orchestration/evaluations/parse-structured');

interface DummyShape {
  ok: boolean;
}

function makeProvider(
  scripts: Array<{ content: string; usage?: { inputTokens: number; outputTokens: number } }>
) {
  let turn = 0;
  return {
    chat: vi.fn(async () => {
      const s = scripts[turn] ?? scripts[scripts.length - 1];
      turn++;
      return {
        content: s.content,
        usage: s.usage ?? { inputTokens: 10, outputTokens: 5 },
      };
    }),
  } as unknown as Parameters<typeof runStructuredCompletion>[0]['provider'];
}

function dummyParse(raw: string): DummyShape | null {
  return tryParseJson<DummyShape>(raw, (p) => {
    if (p && typeof p === 'object' && (p as { ok?: unknown }).ok === true) return { ok: true };
    return null;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('runStructuredCompletion', () => {
  it('returns the parsed value on the first attempt without calling chat twice', async () => {
    const provider = makeProvider([
      { content: '{"ok":true}', usage: { inputTokens: 12, outputTokens: 4 } },
    ]);
    const result = await runStructuredCompletion<DummyShape>({
      provider,
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'go' }],
      parse: dummyParse,
      retryUserMessage: 'try again',
    });
    expect(result.value).toEqual({ ok: true });
    expect(result.tokenUsage).toEqual({ input: 12, output: 4 });
    expect((provider.chat as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it('retries with a stricter prompt and temperature 0 on malformed JSON', async () => {
    const provider = makeProvider([
      { content: 'not-json', usage: { inputTokens: 3, outputTokens: 2 } },
      { content: '{"ok":true}', usage: { inputTokens: 5, outputTokens: 3 } },
    ]);
    const result = await runStructuredCompletion<DummyShape>({
      provider,
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'go' }],
      parse: dummyParse,
      retryUserMessage: 'STRICT — JSON only',
    });
    expect(result.value).toEqual({ ok: true });
    // Tokens summed across both attempts.
    expect(result.tokenUsage).toEqual({ input: 8, output: 5 });

    const calls = (provider.chat as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(2);
    // First call: original temperature
    expect((calls[0] as unknown[])[1]).toMatchObject({ temperature: 0.2 });
    // Retry: temperature 0 and the retry prompt appended
    expect((calls[1] as unknown[])[1]).toMatchObject({ temperature: 0 });
    const retryMessages = (calls[1] as unknown[])[0] as Array<{ role: string; content: string }>;
    expect(retryMessages[retryMessages.length - 1]).toMatchObject({
      role: 'user',
      content: 'STRICT — JSON only',
    });
    // The retry messages do NOT include the malformed prior response.
    expect(retryMessages.every((m) => m.content !== 'not-json')).toBe(true);
  });

  it('throws via onFinalFailure when both attempts fail', async () => {
    const provider = makeProvider([
      { content: 'no', usage: { inputTokens: 1, outputTokens: 1 } },
      { content: 'still no', usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    await expect(
      runStructuredCompletion<DummyShape>({
        provider,
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'go' }],
        parse: dummyParse,
        retryUserMessage: 'STRICT',
        onFinalFailure: () => new Error('caller-supplied error'),
      })
    ).rejects.toThrow('caller-supplied error');
  });

  it('throws a default error when both attempts fail and no onFinalFailure is supplied', async () => {
    const provider = makeProvider([
      { content: 'no', usage: { inputTokens: 1, outputTokens: 1 } },
      { content: 'still no', usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    await expect(
      runStructuredCompletion<DummyShape>({
        provider,
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'go' }],
        parse: dummyParse,
        retryUserMessage: 'STRICT',
      })
    ).rejects.toThrow('Structured completion response was not valid JSON after retry');
  });
});

describe('tryParseJson', () => {
  it('returns null when validate rejects every candidate', () => {
    const result = tryParseJson<{ ok: true }>('{"ok":false}', (p) => {
      if (p && typeof p === 'object' && (p as { ok?: unknown }).ok === true) return { ok: true };
      return null;
    });
    expect(result).toBeNull();
  });

  it('strips a ```json ... ``` fence before parsing', () => {
    const result = tryParseJson<{ ok: true }>('```json\n{"ok":true}\n```', (p) => {
      if (p && typeof p === 'object' && (p as { ok?: unknown }).ok === true) return { ok: true };
      return null;
    });
    expect(result).toEqual({ ok: true });
  });

  it('returns null on completely unparseable input', () => {
    const result = tryParseJson<{ ok: true }>('not json at all', () => null);
    expect(result).toBeNull();
  });
});

describe('stripCodeFence', () => {
  it('strips ```json wrappers', () => {
    expect(stripCodeFence('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('strips bare ``` wrappers', () => {
    expect(stripCodeFence('```\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('returns input unchanged when no fence is present', () => {
    expect(stripCodeFence('{"a":1}')).toBe('{"a":1}');
  });
});
