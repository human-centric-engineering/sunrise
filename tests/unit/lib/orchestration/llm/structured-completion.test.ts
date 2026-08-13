/**
 * Unit tests for runStructuredCompletion — the neutral structured-output
 * runner (call → parse → retry-once-at-temp-0-on-malformed-JSON).
 *
 * Covers:
 *  - happy path (first attempt parses → no retry, summed tokens = first only)
 *  - malformed first → retry succeeds (tokens summed across both attempts,
 *    temperature dropped to 0 on retry, malformed prior response never resent)
 *  - responseSchema forwarding (absent / empty / named / strict on-off)
 *  - malformed first AND retry → throws (with caller's onFinalFailure if
 *    supplied, otherwise default error)
 *  - truncation (#587): reported as truncation rather than as a schema
 *    failure, reached either from a `'length'` finish or from the adapter's
 *    own `truncated_no_output` throw, and still retried in both cases
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { ProviderError } from '@/lib/orchestration/llm/provider';
import { SPAN_LLM_CALL } from '@/lib/orchestration/tracing';
import { registerTracer, resetTracer } from '@/lib/orchestration/tracing/registry';
import { MockTracer } from '@/tests/helpers/mock-tracer';
import type { LlmFinishReason } from '@/lib/orchestration/llm/types';

vi.mock('@/lib/orchestration/llm/cost-tracker', () => ({
  calculateCost: vi.fn(() => ({
    inputCostUsd: 0.001,
    outputCostUsd: 0.002,
    totalCostUsd: 0.003,
  })),
}));

const { runStructuredCompletion } = await import('@/lib/orchestration/llm/structured-completion');

interface DummyShape {
  ok: boolean;
}

function makeProvider(
  scripts: Array<{
    content: string;
    usage?: { inputTokens: number; outputTokens: number };
    finishReason?: LlmFinishReason;
  }>
) {
  let turn = 0;
  return {
    chat: vi.fn(async () => {
      const s = scripts[turn] ?? scripts[scripts.length - 1];
      turn++;
      return {
        content: s.content,
        usage: s.usage ?? { inputTokens: 10, outputTokens: 5 },
        finishReason: s.finishReason ?? 'stop',
      };
    }),
  } as unknown as Parameters<typeof runStructuredCompletion>[0]['provider'];
}

// Self-contained parse: `{"ok":true}` → shape, anything else → null (triggers
// the retry path). Kept independent of the eval parse helpers so this test
// exercises only the runner.
function dummyParse(raw: string): DummyShape | null {
  try {
    const parsed = JSON.parse(raw.trim()) as unknown;
    if (parsed && typeof parsed === 'object' && (parsed as { ok?: unknown }).ok === true) {
      return { ok: true };
    }
  } catch {
    // fall through
  }
  return null;
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

  it('does not send a responseFormat when no responseSchema is supplied', async () => {
    const provider = makeProvider([
      { content: '{"ok":true}', usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    await runStructuredCompletion<DummyShape>({
      provider,
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'go' }],
      parse: dummyParse,
      retryUserMessage: 'try again',
    });
    const opts = (provider.chat as ReturnType<typeof vi.fn>).mock.calls[0][1] as Record<
      string,
      unknown
    >;
    expect(opts).not.toHaveProperty('responseFormat');
  });

  it('treats an empty {} responseSchema as no enforcement (forwards no responseFormat)', async () => {
    const provider = makeProvider([
      { content: '{"ok":true}', usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    await runStructuredCompletion<DummyShape>({
      provider,
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'go' }],
      parse: dummyParse,
      retryUserMessage: 'try again',
      responseSchema: {},
    });
    const opts = (provider.chat as ReturnType<typeof vi.fn>).mock.calls[0][1] as Record<
      string,
      unknown
    >;
    expect(opts).not.toHaveProperty('responseFormat');
  });

  it('forwards responseSchema as a json_schema responseFormat on both attempts', async () => {
    // First attempt malformed → forces the retry so we can assert both calls.
    const provider = makeProvider([
      { content: 'nope', usage: { inputTokens: 1, outputTokens: 1 } },
      { content: '{"ok":true}', usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const schema = { type: 'object', properties: { ok: { type: 'boolean' } } };
    await runStructuredCompletion<DummyShape>({
      provider,
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'go' }],
      parse: dummyParse,
      retryUserMessage: 'STRICT',
      responseSchema: schema,
    });
    const calls = (provider.chat as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(2);
    const expected = { type: 'json_schema', name: 'structured_output', schema };
    expect((calls[0] as unknown[])[1]).toMatchObject({ responseFormat: expected });
    expect((calls[1] as unknown[])[1]).toMatchObject({ responseFormat: expected });
    // strict is omitted when the caller doesn't opt in.
    const firstFormat = ((calls[0] as unknown[])[1] as { responseFormat: Record<string, unknown> })
      .responseFormat;
    expect(firstFormat).not.toHaveProperty('strict');
  });

  it('uses responseSchemaName when provided and forwards strict when set', async () => {
    const provider = makeProvider([
      { content: '{"ok":true}', usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const schema = { type: 'object', properties: { ok: { type: 'boolean' } } };
    await runStructuredCompletion<DummyShape>({
      provider,
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'go' }],
      parse: dummyParse,
      retryUserMessage: 'STRICT',
      responseSchema: schema,
      responseSchemaName: 'questionnaire_extract',
      responseSchemaStrict: true,
    });
    const opts = (provider.chat as ReturnType<typeof vi.fn>).mock.calls[0][1] as Record<
      string,
      unknown
    >;
    expect(opts.responseFormat).toEqual({
      type: 'json_schema',
      name: 'questionnaire_extract',
      schema,
      strict: true,
    });
  });

  it('forwards strict:false explicitly when the caller opts out', async () => {
    const provider = makeProvider([
      { content: '{"ok":true}', usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const schema = { type: 'object', properties: { ok: { type: 'boolean' } } };
    await runStructuredCompletion<DummyShape>({
      provider,
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'go' }],
      parse: dummyParse,
      retryUserMessage: 'STRICT',
      responseSchema: schema,
      responseSchemaStrict: false,
    });
    const opts = (provider.chat as ReturnType<typeof vi.fn>).mock.calls[0][1] as {
      responseFormat: Record<string, unknown>;
    };
    expect(opts.responseFormat).toMatchObject({ strict: false });
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

  describe('truncation (#587)', () => {
    // Partial JSON: the model started the object and was cut off mid-string.
    // `dummyParse` returns null on it, exactly as it would on genuine
    // rubbish — which is the whole problem. The two are indistinguishable
    // from the content alone, and only `finishReason` tells them apart.
    const CUT_OFF = '{"ok":tr';

    it('retries a truncation — the stricter prompt is a real remedy', async () => {
      // A chatty model spent the budget introducing its answer and got cut
      // off before finishing the JSON. "Respond ONLY with a JSON object" at
      // temperature 0 fixes exactly that, and the cap bounds the COMPLETION,
      // so appending the retry message does not shrink the output budget.
      // Skipping this retry hard-fails a recoverable call and blames a token
      // cap that was adequate.
      const provider = makeProvider([
        { content: `here is my considered answer: ${CUT_OFF}`, finishReason: 'length' },
        { content: '{"ok":true}', finishReason: 'stop' },
      ]);

      const result = await runStructuredCompletion<DummyShape>({
        provider,
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'go' }],
        parse: dummyParse,
        retryUserMessage: 'Respond ONLY with a JSON object. No prose, no code fences.',
        maxTokens: 1500,
      });

      expect(result.value).toEqual({ ok: true });
      expect((provider.chat as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
    });

    it('retries even when a responseSchema was sent — sent is not honoured', async () => {
      // The proxy that looks right and is not: `responseSchema` records what
      // was SENT. `OpenAiCompatibleProvider` targets hosts that ignore
      // `response_format` (Ollama, LM Studio, vLLM, older gateways), and one
      // of those can still emit a preamble and get cut off. Skipping the
      // retry here breaks the cross-provider safety net that `responseSchema`
      // documents ("`parse` plus the existing temp-0 retry").
      const provider = makeProvider([
        { content: `Sure! Here's the JSON: ${CUT_OFF}`, finishReason: 'length' },
        { content: '{"ok":true}', finishReason: 'stop' },
      ]);

      const result = await runStructuredCompletion<DummyShape>({
        provider,
        model: 'llama-3.3-70b',
        messages: [{ role: 'user', content: 'go' }],
        parse: dummyParse,
        retryUserMessage: 'Respond ONLY with a JSON object.',
        maxTokens: 1500,
        responseSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
      });

      expect(result.value).toEqual({ ok: true });
      expect((provider.chat as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
    });

    it('recovers when the ADAPTER throws the truncation rather than returning it', async () => {
      // Both in-repo adapters raise `truncated_no_output` from inside
      // `provider.chat` for a structured extraction, so on that path the
      // runner never sees a `'length'` finish — it sees an exception. If that
      // escapes, the retry never runs and a recoverable call hard-fails.
      const chat = vi
        .fn()
        .mockRejectedValueOnce(
          new ProviderError('Model "gpt-5" hit max_completion_tokens', {
            code: 'truncated_no_output',
            retriable: false,
          })
        )
        .mockResolvedValueOnce({
          content: '{"ok":true}',
          usage: { inputTokens: 5, outputTokens: 3 },
          finishReason: 'stop',
        });
      const provider = { chat } as unknown as Parameters<
        typeof runStructuredCompletion
      >[0]['provider'];

      const result = await runStructuredCompletion<DummyShape>({
        provider,
        model: 'gpt-5',
        messages: [{ role: 'user', content: 'go' }],
        parse: dummyParse,
        retryUserMessage: 'Respond ONLY with a JSON object.',
        responseSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
      });

      expect(result.value).toEqual({ ok: true });
      expect(chat).toHaveBeenCalledTimes(2);
      // The thrown attempt reported no usage, so only the retry's is counted.
      expect(result.tokenUsage).toEqual({ input: 5, output: 3 });
    });

    it('reports truncation when the adapter throws on both attempts', async () => {
      const truncated = () =>
        new ProviderError('hit max_completion_tokens', {
          code: 'truncated_no_output',
          retriable: false,
        });
      const chat = vi.fn().mockRejectedValue(truncated());
      const provider = { chat } as unknown as Parameters<
        typeof runStructuredCompletion
      >[0]['provider'];

      await expect(
        runStructuredCompletion<DummyShape>({
          provider,
          model: 'gpt-5',
          messages: [{ role: 'user', content: 'go' }],
          parse: dummyParse,
          retryUserMessage: 'STRICT',
          maxTokens: 2048,
          responseSchema: { type: 'object' },
        })
      ).rejects.toThrow(/truncated at maxTokens \(2048\)/);
      expect(chat).toHaveBeenCalledTimes(2);
    });

    it('counts the tokens of a truncated first attempt in the total', async () => {
      // A truncated attempt is a full cap's worth of output — the LARGEST
      // component of the bill, and the one most worth counting. It is billed
      // whether or not it parsed, `complete-session.ts` feeds this straight
      // into `logCost`, and the module docstring promises the sum spans both
      // attempts. Signalling the truncation by discarding the response threw
      // these away.
      const provider = makeProvider([
        {
          content: CUT_OFF,
          usage: { inputTokens: 100, outputTokens: 1500 },
          finishReason: 'length',
        },
        {
          content: '{"ok":true}',
          usage: { inputTokens: 110, outputTokens: 20 },
          finishReason: 'stop',
        },
      ]);

      const result = await runStructuredCompletion<DummyShape>({
        provider,
        model: 'gpt-5.4',
        messages: [{ role: 'user', content: 'go' }],
        parse: dummyParse,
        retryUserMessage: 'STRICT',
      });

      expect(result.value).toEqual({ ok: true });
      expect(result.tokenUsage).toEqual({ input: 210, output: 1520 });
    });

    it("reports both attempts' billed tokens on the thrown truncation", async () => {
      // Both calls were charged, and the truncated one is a full cap of
      // output — the most expensive part. Attributing only one of them (or
      // only the non-truncated one, which an earlier version did) under-reports
      // the failure that costs the most. Attempt 1 finished cleanly at 'stop'
      // and merely failed to parse; attempt 2 is the truncation.
      const provider = makeProvider([
        {
          content: 'here is prose',
          usage: { inputTokens: 10, outputTokens: 8 },
          finishReason: 'stop',
        },
        { content: CUT_OFF, usage: { inputTokens: 12, outputTokens: 900 }, finishReason: 'length' },
      ]);

      let caught: unknown;
      try {
        await runStructuredCompletion<DummyShape>({
          provider,
          model: 'gpt-5.4',
          messages: [{ role: 'user', content: 'go' }],
          parse: dummyParse,
          retryUserMessage: 'STRICT',
        });
      } catch (err) {
        caught = err;
      }

      const usage = (caught as { usage?: { inputTokens: number; outputTokens: number } }).usage;
      expect(usage).toEqual({ inputTokens: 22, outputTokens: 908 });
    });

    it('omits usage from the final error when neither attempt reported any', async () => {
      // Same invariant the adapter guards hold: a consumer doing
      // `if (err.usage) logCost(...)` must not be handed {0, 0} and write a
      // "this turn was free" row for a full-cap failure. Hosts that ignore
      // `stream_options.include_usage` report nothing.
      const provider = makeProvider([
        { content: CUT_OFF, usage: { inputTokens: 0, outputTokens: 0 }, finishReason: 'length' },
        { content: CUT_OFF, usage: { inputTokens: 0, outputTokens: 0 }, finishReason: 'length' },
      ]);

      let caught: unknown;
      try {
        await runStructuredCompletion<DummyShape>({
          provider,
          model: 'local-model',
          messages: [{ role: 'user', content: 'go' }],
          parse: dummyParse,
          retryUserMessage: 'STRICT',
        });
      } catch (err) {
        caught = err;
      }

      expect((caught as { code?: string }).code).toBe('truncated_no_output');
      expect((caught as { usage?: unknown }).usage).toBeUndefined();
    });

    it('records a truncated attempt as a FAILED span, not a successful one', async () => {
      // `withSpan` stamps `{ code: 'ok' }` on any normal return, so an early
      // `return` from the callback would file the truncated attempt in the
      // trace as a success — hiding the one fault this work exists to make
      // diagnosable, in the exact place an operator goes to look for it. The
      // truncation is therefore thrown inside the span and caught outside.
      const tracer = new MockTracer();
      registerTracer(tracer);
      try {
        const provider = makeProvider([
          { content: CUT_OFF, finishReason: 'length' },
          { content: '{"ok":true}', finishReason: 'stop' },
        ]);

        await runStructuredCompletion<DummyShape>({
          provider,
          model: 'gpt-5.4',
          messages: [{ role: 'user', content: 'go' }],
          parse: dummyParse,
          retryUserMessage: 'STRICT',
        });

        const llmSpans = tracer.spans.filter((s) => s.name === SPAN_LLM_CALL);
        expect(llmSpans).toHaveLength(2);
        expect(llmSpans[0]?.status).toMatchObject({ code: 'error' });
        // ...and names the cap, so the trace alone is enough to diagnose it.
        expect(llmSpans[0]?.status?.message).toMatch(/truncated at maxTokens/);
        // The recovered retry is still recorded as the success it was.
        expect(llmSpans[1]?.status).toMatchObject({ code: 'ok' });
      } finally {
        resetTracer();
      }
    });

    it('lets a non-truncation provider error escape immediately', async () => {
      // Only `truncated_no_output` is absorbed into the retry. A 401 or a
      // network fault must not be turned into a second call.
      const chat = vi
        .fn()
        .mockRejectedValue(new ProviderError('bad key', { code: 'http_401', retriable: false }));
      const provider = { chat } as unknown as Parameters<
        typeof runStructuredCompletion
      >[0]['provider'];

      await expect(
        runStructuredCompletion<DummyShape>({
          provider,
          model: 'gpt-5',
          messages: [{ role: 'user', content: 'go' }],
          parse: dummyParse,
          retryUserMessage: 'STRICT',
        })
      ).rejects.toThrow('bad key');
      expect(chat).toHaveBeenCalledTimes(1);
    });

    it('reports truncation when the retry is cut off too', async () => {
      // The retry earned its call and still ran out of room — now the cap
      // genuinely is the fault, and the error says so rather than blaming
      // the schema.
      const provider = makeProvider([
        { content: `preamble ${CUT_OFF}`, finishReason: 'length' },
        { content: CUT_OFF, finishReason: 'length' },
      ]);

      let caught: unknown;
      try {
        await runStructuredCompletion<DummyShape>({
          provider,
          model: 'claude-sonnet-4-6',
          messages: [{ role: 'user', content: 'go' }],
          parse: dummyParse,
          retryUserMessage: 'STRICT',
          maxTokens: 1500,
        });
      } catch (err) {
        caught = err;
      }

      expect((caught as { code?: string }).code).toBe('truncated_no_output');
      expect((caught as Error).message).toMatch(/1500/);
      expect((provider.chat as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
    });

    it("does not defer to the caller's onFinalFailure, whose premise is false here", async () => {
      // `onFinalFailure` exists to phrase "the model broke my contract". On a
      // truncation that premise is wrong, and every caller that supplies one
      // would otherwise have to rediscover this and duplicate the check.
      const provider = makeProvider([
        { content: CUT_OFF, finishReason: 'length' },
        { content: CUT_OFF, finishReason: 'length' },
      ]);

      await expect(
        runStructuredCompletion<DummyShape>({
          provider,
          model: 'gpt-5.4',
          messages: [{ role: 'user', content: 'go' }],
          parse: dummyParse,
          retryUserMessage: 'STRICT',
          onFinalFailure: () => new Error('Judge response was not valid against the schema'),
        })
      ).rejects.toThrow(/truncat/i);
    });

    it('reports truncation when the retry is the attempt that gets cut off', async () => {
      const provider = makeProvider([
        // A genuine malformed response — finished cleanly, just not JSON. The
        // retry is warranted here.
        { content: 'here is your answer:', finishReason: 'stop' },
        { content: CUT_OFF, finishReason: 'length' },
      ]);

      let caught: unknown;
      try {
        await runStructuredCompletion<DummyShape>({
          provider,
          model: 'gpt-5.4',
          messages: [{ role: 'user', content: 'go' }],
          parse: dummyParse,
          retryUserMessage: 'STRICT',
          maxTokens: 512,
        });
      } catch (err) {
        caught = err;
      }

      expect((caught as Error).message).toMatch(/truncat/i);
      expect((provider.chat as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
    });

    it('still reports a schema failure when both attempts finished cleanly', async () => {
      // The guard against over-correcting: a response that ran to `stop` and
      // still did not parse IS a contract violation, and the caller's error
      // is the right one.
      const provider = makeProvider([
        { content: 'no', finishReason: 'stop' },
        { content: 'still no', finishReason: 'stop' },
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

    it('surfaces finishReason on a successful result so a truncated-but-parseable response is visible', async () => {
      // A lenient parse can accept content that was cut off at a point where
      // it happened to be well-formed — a truncated array of results reads as
      // a complete short one. Nothing throws, so the result field is the only
      // place a caller can see it.
      const provider = makeProvider([{ content: '{"ok":true}', finishReason: 'length' }]);

      const result = await runStructuredCompletion<DummyShape>({
        provider,
        model: 'gpt-5.4',
        messages: [{ role: 'user', content: 'go' }],
        parse: dummyParse,
        retryUserMessage: 'STRICT',
      });

      expect(result.value).toEqual({ ok: true });
      expect(result.finishReason).toBe('length');
    });
  });
});
