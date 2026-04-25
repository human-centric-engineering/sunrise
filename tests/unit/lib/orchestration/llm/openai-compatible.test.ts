/**
 * OpenAiCompatibleProvider Tests
 *
 * Comprehensive coverage for the OpenAI-compatible provider including:
 * - Constructor validation (baseUrl required, apiKey sentinel, local timeouts)
 * - chat() — happy path, empty choices, tool calls, SDK error wrapping
 * - chatStream() — text deltas, usage chunks, tool-call buffering, abort, SDK errors
 * - embed() — default models (cloud/local), override, SDK error, empty data
 * - listModels() — registry merge, synthetic, SDK error
 * - testConnection() — success/failure
 * - Mapping helpers — toSdkMessage, mapToolChoice, mapFinishReason, safeParseJson, buildBaseParams
 *
 * @see lib/orchestration/llm/openai-compatible.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Module-level mock stubs (must be declared before vi.mock hoisting)
// ---------------------------------------------------------------------------

const chatCreateMock = vi.fn();
const embeddingsCreateMock = vi.fn();
const modelsListMock = vi.fn();

vi.mock('openai', () => {
  class MockOpenAI {
    public chat = { completions: { create: chatCreateMock } };
    public embeddings = { create: embeddingsCreateMock };
    public models = { list: modelsListMock };
    constructor(_opts: unknown) {}
  }
  return { default: MockOpenAI };
});

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Dynamic import AFTER vi.mock — ensures mocks are in place
const { OpenAiCompatibleProvider } = await import('@/lib/orchestration/llm/openai-compatible');

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

beforeEach(() => {
  chatCreateMock.mockReset();
  embeddingsCreateMock.mockReset();
  modelsListMock.mockReset();
});

/**
 * Factory for a cloud (non-local) provider instance.
 */
function makeProvider(overrides: Record<string, unknown> = {}) {
  return new OpenAiCompatibleProvider({
    name: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'test-key',
    isLocal: false,
    ...overrides,
  });
}

/**
 * Factory for a local provider instance (Ollama-style).
 */
function makeLocalProvider(overrides: Record<string, unknown> = {}) {
  return new OpenAiCompatibleProvider({
    name: 'ollama',
    baseUrl: 'http://localhost:11434/v1',
    isLocal: true,
    ...overrides,
  });
}

/**
 * Build a minimal non-streaming chat completion response.
 */
function makeChatCompletion(
  content: string,
  finishReason: string,
  toolCalls: unknown[] | null = null,
  usage = { prompt_tokens: 10, completion_tokens: 5 }
) {
  return {
    id: 'cmpl-test',
    model: 'gpt-4o',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content, tool_calls: toolCalls },
        finish_reason: finishReason,
      },
    ],
    usage,
  };
}

/**
 * Build a minimal streaming chunk (ChatCompletionChunk shape).
 */
function makeChunk(opts: {
  content?: string;
  toolCalls?: Array<{
    index: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }>;
  finishReason?: string | null;
  usage?: { prompt_tokens: number; completion_tokens: number };
}) {
  return {
    id: 'chunk-test',
    model: 'gpt-4o',
    choices:
      opts.finishReason !== undefined || opts.content !== undefined || opts.toolCalls
        ? [
            {
              index: 0,
              delta: {
                content: opts.content ?? null,
                tool_calls: opts.toolCalls ?? null,
              },
              finish_reason: opts.finishReason ?? null,
            },
          ]
        : [],
    usage: opts.usage ?? null,
  };
}

/**
 * Create an async iterable from an array of values.
 */
async function* toAsyncIterable<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) {
    yield item;
  }
}

// ---------------------------------------------------------------------------
// Constructor
// ---------------------------------------------------------------------------

describe('constructor', () => {
  it('throws ProviderError when baseUrl is missing', () => {
    // Arrange + Act + Assert
    expect(
      () =>
        new OpenAiCompatibleProvider({
          name: 'test',
          baseUrl: '',
          isLocal: false,
        })
    ).toThrow('OpenAiCompatibleProvider requires a baseUrl');
  });

  it('throws ProviderError with code missing_base_url when baseUrl is empty', () => {
    // Arrange
    let caught: unknown;
    try {
      new OpenAiCompatibleProvider({ name: 'test', baseUrl: '', isLocal: false });
    } catch (err) {
      caught = err;
    }

    // Assert
    expect((caught as { code?: string }).code).toBe('missing_base_url');
  });

  it('uses LOCAL_API_KEY_SENTINEL when no apiKey provided for local provider', () => {
    // Arrange + Act — constructor must not throw even without apiKey
    const provider = makeLocalProvider();

    // Assert — provider is created; name and isLocal reflect options
    expect(provider.name).toBe('ollama');
    // test-review:accept tobe_true — isLocal is a boolean field set directly from constructor options; asserting true is the correct structural check
    expect(provider.isLocal).toBe(true);
  });

  it('uses LOCAL_API_KEY_SENTINEL when apiKey is explicitly empty string', () => {
    // Arrange + Act
    const provider = new OpenAiCompatibleProvider({
      name: 'local',
      baseUrl: 'http://localhost:1234/v1',
      apiKey: '',
      isLocal: true,
    });

    // Assert
    // test-review:accept tobe_true — isLocal is a boolean field; true is the expected value when constructed with isLocal: true
    expect(provider.isLocal).toBe(true);
  });

  it('constructs successfully for cloud provider with no apiKey (SDK decides)', () => {
    // Arrange + Act
    const provider = new OpenAiCompatibleProvider({
      name: 'together',
      baseUrl: 'https://api.together.xyz/v1',
      isLocal: false,
    });

    // Assert
    expect(provider.isLocal).toBe(false);
    expect(provider.name).toBe('together');
  });

  it('exposes isLocal: false on cloud provider', () => {
    const provider = makeProvider();
    expect(provider.isLocal).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// chat()
// ---------------------------------------------------------------------------

describe('chat', () => {
  it('returns mapped response with usage and finishReason', async () => {
    // Arrange
    chatCreateMock.mockResolvedValue(makeChatCompletion('hello', 'stop'));

    // Act
    const provider = makeProvider();
    const response = await provider.chat([{ role: 'user', content: 'hi' }], { model: 'gpt-4o' });

    // Assert
    expect(response.content).toBe('hello');
    expect(response.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(response.finishReason).toBe('stop');
  });

  it('extracts tool_calls and maps finishReason to tool_use', async () => {
    // Arrange
    chatCreateMock.mockResolvedValue(
      makeChatCompletion('', 'tool_calls', [
        {
          id: 'tc1',
          type: 'function',
          function: { name: 'search', arguments: '{"query":"x"}' },
        },
      ])
    );

    // Act
    const provider = makeProvider();
    const response = await provider.chat([{ role: 'user', content: 'go' }], { model: 'gpt-4o' });

    // Assert
    expect(response.finishReason).toBe('tool_use');
    expect(response.toolCalls).toEqual([{ id: 'tc1', name: 'search', arguments: { query: 'x' } }]);
  });

  it('throws ProviderError with code empty_response when choices is empty', async () => {
    // Arrange
    chatCreateMock.mockResolvedValue({
      id: 'r-empty',
      model: 'gpt-4o',
      choices: [],
      usage: { prompt_tokens: 0, completion_tokens: 0 },
    });

    // Act + Assert
    const provider = makeProvider();
    await expect(
      provider.chat([{ role: 'user', content: 'hi' }], { model: 'gpt-4o' })
    ).rejects.toMatchObject({ code: 'empty_response', retriable: false });
  });

  it('wraps SDK errors via toProviderError', async () => {
    // Arrange
    const sdkError = Object.assign(new Error('rate limited'), { status: 429 });
    chatCreateMock.mockRejectedValue(sdkError);

    // Act + Assert
    const provider = makeProvider();
    const err = await provider
      .chat([{ role: 'user', content: 'hi' }], { model: 'gpt-4o' })
      .catch((e: unknown) => e);

    expect(err).toMatchObject({ message: 'rate limited', retriable: true });
  });

  it('includes toolCalls in response only when present', async () => {
    // Arrange — no tool_calls field at all
    chatCreateMock.mockResolvedValue(makeChatCompletion('answer', 'stop'));

    // Act
    const provider = makeProvider();
    const response = await provider.chat([{ role: 'user', content: 'q' }], { model: 'gpt-4o' });

    // Assert — toolCalls should not be set
    expect(response.toolCalls).toBeUndefined();
  });

  it('passes tool choice options through to SDK params', async () => {
    // Arrange
    chatCreateMock.mockResolvedValue(makeChatCompletion('ok', 'stop'));

    // Act
    const provider = makeProvider();
    const response = await provider.chat([{ role: 'user', content: 'x' }], {
      model: 'gpt-4o',
      tools: [{ name: 'fn', description: 'desc', parameters: {} }],
      toolChoice: 'auto',
    });

    // Assert — verify SDK was called with tool_choice and the response is mapped correctly
    const calledParams = chatCreateMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(calledParams?.tool_choice).toBe('auto');
    expect(response.content).toBe('ok');
    expect(response.finishReason).toBe('stop');
  });

  it('passes temperature and maxTokens through to SDK params', async () => {
    // Arrange
    chatCreateMock.mockResolvedValue(makeChatCompletion('ok', 'stop'));

    // Act
    const provider = makeProvider();
    const response = await provider.chat([{ role: 'user', content: 'x' }], {
      model: 'gpt-4o',
      temperature: 0.5,
      maxTokens: 256,
    });

    // Assert — SDK params are correct and the response content flows through
    const calledParams = chatCreateMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(calledParams?.temperature).toBe(0.5);
    expect(calledParams?.max_tokens).toBe(256);
    expect(response.content).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// chatStream()
// ---------------------------------------------------------------------------

describe('chatStream', () => {
  it('yields text chunks for content deltas', async () => {
    // Arrange
    const chunks = [
      makeChunk({ content: 'Hel' }),
      makeChunk({ content: 'lo' }),
      makeChunk({ finishReason: 'stop', usage: { prompt_tokens: 3, completion_tokens: 2 } }),
    ];
    chatCreateMock.mockResolvedValue(toAsyncIterable(chunks));

    // Act
    const provider = makeProvider();
    const collected: unknown[] = [];
    for await (const chunk of provider.chatStream([{ role: 'user', content: 'hi' }], {
      model: 'gpt-4o',
    })) {
      collected.push(chunk);
    }

    // Assert — text chunks then done
    expect(collected).toContainEqual({ type: 'text', content: 'Hel' });
    expect(collected).toContainEqual({ type: 'text', content: 'lo' });
    const done = collected.find((c) => (c as { type: string }).type === 'done');
    expect(done).toMatchObject({
      type: 'done',
      finishReason: 'stop',
    });
  });

  it('captures usage from trailing usage-only chunk (OpenAI style)', async () => {
    // Arrange — the usage chunk has no choices
    const chunks = [
      makeChunk({ content: 'hi' }),
      makeChunk({ finishReason: 'stop' }),
      // usage-only chunk: choices is empty, usage is populated
      {
        id: 'chunk-usage',
        model: 'gpt-4o',
        choices: [],
        usage: { prompt_tokens: 20, completion_tokens: 10 },
      },
    ];
    chatCreateMock.mockResolvedValue(toAsyncIterable(chunks));

    // Act
    const provider = makeProvider();
    const collected: unknown[] = [];
    for await (const chunk of provider.chatStream([{ role: 'user', content: 'hi' }], {
      model: 'gpt-4o',
    })) {
      collected.push(chunk);
    }

    // Assert — done chunk has the usage from the trailing chunk
    const done = collected.find((c) => (c as { type: string }).type === 'done') as
      | { type: 'done'; usage: { inputTokens: number; outputTokens: number } }
      | undefined;
    expect(done?.usage).toEqual({ inputTokens: 20, outputTokens: 10 });
  });

  it('buffers tool_call deltas and emits a single tool_call chunk per index', async () => {
    // Arrange — three deltas accumulate into one tool call
    const chunks = [
      makeChunk({
        toolCalls: [{ index: 0, id: 'tc-1', function: { name: 'search', arguments: '' } }],
      }),
      makeChunk({
        toolCalls: [{ index: 0, function: { arguments: '{"q"' } }],
      }),
      makeChunk({
        toolCalls: [{ index: 0, function: { arguments: ':"x"}' } }],
      }),
      makeChunk({ finishReason: 'tool_calls' }),
    ];
    chatCreateMock.mockResolvedValue(toAsyncIterable(chunks));

    // Act
    const provider = makeProvider();
    const collected: unknown[] = [];
    for await (const chunk of provider.chatStream([{ role: 'user', content: 'go' }], {
      model: 'gpt-4o',
    })) {
      collected.push(chunk);
    }

    // Assert — one tool_call chunk with assembled arguments
    const toolCalls = collected.filter((c) => (c as { type: string }).type === 'tool_call');
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toMatchObject({
      type: 'tool_call',
      toolCall: { id: 'tc-1', name: 'search', arguments: { q: 'x' } },
    });
  });

  it('buffers multiple concurrent tool calls at different indices', async () => {
    // Arrange — two tool calls streamed interleaved
    const chunks = [
      makeChunk({
        toolCalls: [
          { index: 0, id: 'tc-a', function: { name: 'fn_a', arguments: '' } },
          { index: 1, id: 'tc-b', function: { name: 'fn_b', arguments: '' } },
        ],
      }),
      makeChunk({
        toolCalls: [
          { index: 0, function: { arguments: '{"x":1}' } },
          { index: 1, function: { arguments: '{"y":2}' } },
        ],
      }),
      makeChunk({ finishReason: 'tool_calls' }),
    ];
    chatCreateMock.mockResolvedValue(toAsyncIterable(chunks));

    // Act
    const provider = makeProvider();
    const collected: unknown[] = [];
    for await (const chunk of provider.chatStream([{ role: 'user', content: 'go' }], {
      model: 'gpt-4o',
    })) {
      collected.push(chunk);
    }

    // Assert — two distinct tool_call chunks
    const toolCalls = collected.filter((c) => (c as { type: string }).type === 'tool_call');
    expect(toolCalls).toHaveLength(2);
    const names = toolCalls.map((c) => (c as { toolCall: { name: string } }).toolCall.name);
    expect(names).toContain('fn_a');
    expect(names).toContain('fn_b');
  });

  it('emits done chunk with finishReason from the choice that has it', async () => {
    // Arrange
    const chunks = [makeChunk({ content: 'x' }), makeChunk({ finishReason: 'length' })];
    chatCreateMock.mockResolvedValue(toAsyncIterable(chunks));

    // Act
    const provider = makeProvider();
    const collected: unknown[] = [];
    for await (const chunk of provider.chatStream([{ role: 'user', content: 'hi' }], {
      model: 'gpt-4o',
    })) {
      collected.push(chunk);
    }

    // Assert
    const done = collected.find((c) => (c as { type: string }).type === 'done');
    expect(done).toMatchObject({ type: 'done', finishReason: 'length' });
  });

  it('throws ProviderError with code aborted when signal is already aborted at chunk boundary', async () => {
    // Arrange — signal aborts after first chunk is yielded
    const controller = new AbortController();
    const chunks = [
      makeChunk({ content: 'hello' }),
      makeChunk({ content: ' world' }),
      makeChunk({ finishReason: 'stop' }),
    ];

    async function* aborting() {
      for (const chunk of chunks) {
        yield chunk;
        // Abort after first chunk so the signal is set before the next iteration
        controller.abort();
      }
    }

    chatCreateMock.mockResolvedValue(aborting());

    // Act
    const provider = makeProvider();
    const err = await (async () => {
      try {
        for await (const _chunk of provider.chatStream([{ role: 'user', content: 'hi' }], {
          model: 'gpt-4o',
          signal: controller.signal,
        })) {
          // consume
        }
        return null;
      } catch (e) {
        return e;
      }
    })();

    // Assert
    expect(err).toMatchObject({ code: 'aborted', retriable: false });
  });

  it('wraps SDK error thrown at stream creation via toProviderError', async () => {
    // Arrange — SDK throws synchronously when creating the stream
    const sdkError = Object.assign(new Error('auth failed'), { status: 401 });
    chatCreateMock.mockRejectedValue(sdkError);

    // Act
    const provider = makeProvider();
    const err = await (async () => {
      try {
        // We must start iterating to trigger the async generator
        for await (const _chunk of provider.chatStream([{ role: 'user', content: 'x' }], {
          model: 'gpt-4o',
        })) {
          // consume
        }
        return null;
      } catch (e) {
        return e;
      }
    })();

    // Assert
    expect(err).toMatchObject({ message: 'auth failed' });
  });

  it('wraps SDK error thrown during stream iteration via toProviderError', async () => {
    // Arrange — async iterable throws mid-stream
    async function* throwingStream() {
      yield makeChunk({ content: 'start' });
      throw Object.assign(new Error('stream broken'), { status: 500 });
    }
    chatCreateMock.mockResolvedValue(throwingStream());

    // Act
    const provider = makeProvider();
    const err = await (async () => {
      try {
        for await (const _chunk of provider.chatStream([{ role: 'user', content: 'x' }], {
          model: 'gpt-4o',
        })) {
          // consume
        }
        return null;
      } catch (e) {
        return e;
      }
    })();

    // Assert
    expect(err).toMatchObject({ message: 'stream broken' });
  });

  it('skips choices with no content and no tool_calls', async () => {
    // Arrange — chunk with empty choices array
    const chunks = [
      { id: 'c1', model: 'gpt-4o', choices: [], usage: null },
      makeChunk({ content: 'hi' }),
      makeChunk({ finishReason: 'stop' }),
    ];
    chatCreateMock.mockResolvedValue(toAsyncIterable(chunks));

    // Act
    const provider = makeProvider();
    const collected: unknown[] = [];
    for await (const chunk of provider.chatStream([{ role: 'user', content: 'x' }], {
      model: 'gpt-4o',
    })) {
      collected.push(chunk);
    }

    // Assert — only the text chunk and done
    const texts = collected.filter((c) => (c as { type: string }).type === 'text');
    expect(texts).toHaveLength(1);
  });

  it('streams with include_usage option in params', async () => {
    // Arrange
    chatCreateMock.mockResolvedValue(toAsyncIterable([makeChunk({ finishReason: 'stop' })]));

    // Act
    const provider = makeProvider();
    for await (const _chunk of provider.chatStream([{ role: 'user', content: 'x' }], {
      model: 'gpt-4o',
    })) {
      // consume
    }

    // Assert — streaming params include stream_options
    const calledParams = chatCreateMock.mock.calls[0]?.[0] as Record<string, unknown>;
    // test-review:accept tobe_true — stream is a boolean field in ChatCompletionCreateParamsStreaming; true is the exact required value per OpenAI SDK
    expect(calledParams?.stream).toBe(true);
    // test-review:accept tobe_true — include_usage is a boolean field in stream_options; true is the exact required value to get token usage in streaming responses
    expect((calledParams?.stream_options as Record<string, unknown>)?.include_usage).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// listModels()
// ---------------------------------------------------------------------------

describe('listModels', () => {
  it('returns synthetic entries for unknown ids', async () => {
    // Arrange
    modelsListMock.mockResolvedValue({
      data: [{ id: 'custom-model-1' }, { id: 'another-one' }],
    });

    // Act
    const provider = makeProvider({ isLocal: true });
    const models = await provider.listModels();

    // Assert
    expect(models).toHaveLength(2);
    // test-review:accept tobe_true — available is a boolean field; the provider explicitly sets it to true for all discovered models
    expect(models[0]?.available).toBe(true);
    expect(models[0]?.tier).toBe('local');
  });

  it('merges with registry metadata for known ids', async () => {
    // Arrange
    modelsListMock.mockResolvedValue({ data: [{ id: 'gpt-4o' }] });

    // Act
    const provider = makeProvider();
    const models = await provider.listModels();

    // Assert
    expect(models[0]?.id).toBe('gpt-4o');
    // test-review:accept tobe_true — available is a boolean field; the provider always sets it to true when listing models
    expect(models[0]?.available).toBe(true);
    expect(models[0]?.inputCostPerMillion).toBeGreaterThan(0);
  });

  it('wraps SDK errors via toProviderError', async () => {
    // Arrange
    modelsListMock.mockRejectedValue(new Error('connection refused'));

    // Act + Assert
    const provider = makeProvider();
    await expect(provider.listModels()).rejects.toMatchObject({
      message: 'connection refused',
    });
  });

  it('uses mid tier for unknown cloud model ids', async () => {
    // Arrange
    modelsListMock.mockResolvedValue({ data: [{ id: 'some-cloud-model' }] });

    // Act
    const provider = makeProvider({ isLocal: false });
    const models = await provider.listModels();

    // Assert
    expect(models[0]?.tier).toBe('mid');
  });
});

// ---------------------------------------------------------------------------
// testConnection()
// ---------------------------------------------------------------------------

describe('testConnection', () => {
  it('returns ok: false with error on failure', async () => {
    // Arrange
    modelsListMock.mockRejectedValue(new Error('connection refused'));

    // Act
    const provider = makeProvider();
    const result = await provider.testConnection();

    // Assert
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/connection refused/);
    expect(result.models).toEqual([]);
  });

  it('returns ok: true with model ids on success', async () => {
    // Arrange
    modelsListMock.mockResolvedValue({ data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }] });

    // Act
    const provider = makeProvider();
    const result = await provider.testConnection();

    // Assert
    // test-review:accept tobe_true — ok is a boolean field in ProviderTestResult; true signals a healthy connection
    expect(result.ok).toBe(true);
    expect(result.models).toContain('gpt-4o');
  });
});

// ---------------------------------------------------------------------------
// embed()
// ---------------------------------------------------------------------------

describe('embed', () => {
  it('returns the first vector from the SDK response', async () => {
    // Arrange
    embeddingsCreateMock.mockResolvedValue({ data: [{ embedding: [0.1, 0.2, 0.3] }] });

    // Act
    const provider = makeProvider();
    const vec = await provider.embed('hello');

    // Assert
    expect(vec).toEqual([0.1, 0.2, 0.3]);
  });

  it('uses text-embedding-3-small as default embedding model for cloud provider', async () => {
    // Arrange
    embeddingsCreateMock.mockResolvedValue({ data: [{ embedding: [0.5] }] });

    // Act
    const provider = makeProvider(); // isLocal: false
    const vec = await provider.embed('text');

    // Assert — correct model was used and the vector is returned
    const calledParams = embeddingsCreateMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(calledParams?.model).toBe('text-embedding-3-small');
    expect(vec).toEqual([0.5]);
  });

  it('uses nomic-embed-text as default embedding model for local provider', async () => {
    // Arrange
    embeddingsCreateMock.mockResolvedValue({ data: [{ embedding: [0.5] }] });

    // Act
    const provider = makeLocalProvider(); // isLocal: true
    await provider.embed('text');

    // Assert
    const calledParams = embeddingsCreateMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(calledParams?.model).toBe('nomic-embed-text');
  });

  it('uses the overridden embeddingModel when provided', async () => {
    // Arrange
    embeddingsCreateMock.mockResolvedValue({ data: [{ embedding: [0.5] }] });

    // Act
    const provider = makeProvider({ embeddingModel: 'custom-embed-v2' });
    await provider.embed('text');

    // Assert
    const calledParams = embeddingsCreateMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(calledParams?.model).toBe('custom-embed-v2');
  });

  it('throws ProviderError with code empty_response when data array is empty', async () => {
    // Arrange
    embeddingsCreateMock.mockResolvedValue({ data: [] });

    // Act + Assert
    const provider = makeProvider();
    await expect(provider.embed('hello')).rejects.toMatchObject({
      code: 'empty_response',
      retriable: false,
    });
  });

  it('wraps SDK errors via toProviderError', async () => {
    // Arrange
    embeddingsCreateMock.mockRejectedValue(
      Object.assign(new Error('model not found'), { status: 404 })
    );

    // Act + Assert
    const provider = makeProvider();
    await expect(provider.embed('text')).rejects.toMatchObject({ message: 'model not found' });
  });
});

// ---------------------------------------------------------------------------
// Mapping helpers (exercised indirectly via chat / chatStream)
// ---------------------------------------------------------------------------

describe('toSdkMessage mapping', () => {
  it('maps system message correctly', async () => {
    // Arrange
    chatCreateMock.mockResolvedValue(makeChatCompletion('ok', 'stop'));

    // Act
    const provider = makeProvider();
    await provider.chat([{ role: 'system', content: 'You are helpful.' }], { model: 'gpt-4o' });

    // Assert
    const calledParams = chatCreateMock.mock.calls[0]?.[0] as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(calledParams.messages[0]).toEqual({ role: 'system', content: 'You are helpful.' });
  });

  it('maps user message correctly', async () => {
    // Arrange
    chatCreateMock.mockResolvedValue(makeChatCompletion('ok', 'stop'));

    // Act
    const provider = makeProvider();
    await provider.chat([{ role: 'user', content: 'Hello' }], { model: 'gpt-4o' });

    // Assert
    const calledParams = chatCreateMock.mock.calls[0]?.[0] as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(calledParams.messages[0]).toEqual({ role: 'user', content: 'Hello' });
  });

  it('maps assistant message without toolCalls as plain content', async () => {
    // Arrange
    chatCreateMock.mockResolvedValue(makeChatCompletion('ok', 'stop'));

    // Act
    const provider = makeProvider();
    await provider.chat(
      [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: 'answer' },
      ],
      { model: 'gpt-4o' }
    );

    // Assert
    const calledParams = chatCreateMock.mock.calls[0]?.[0] as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(calledParams.messages[1]).toEqual({ role: 'assistant', content: 'answer' });
  });

  it('maps assistant message with toolCalls including serialized arguments', async () => {
    // Arrange
    chatCreateMock.mockResolvedValue(makeChatCompletion('ok', 'stop'));

    // Act
    const provider = makeProvider();
    await provider.chat(
      [
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'tc1', name: 'fn', arguments: { x: 1 } }],
        },
      ],
      { model: 'gpt-4o' }
    );

    // Assert
    const calledParams = chatCreateMock.mock.calls[0]?.[0] as {
      messages: Array<{
        role: string;
        tool_calls?: Array<{
          id: string;
          type: string;
          function: { name: string; arguments: string };
        }>;
      }>;
    };
    expect(calledParams.messages[0]?.tool_calls?.[0]).toMatchObject({
      id: 'tc1',
      type: 'function',
      function: { name: 'fn', arguments: '{"x":1}' },
    });
  });

  it('maps tool role message with tool_call_id', async () => {
    // Arrange
    chatCreateMock.mockResolvedValue(makeChatCompletion('ok', 'stop'));

    // Act
    const provider = makeProvider();
    await provider.chat(
      [
        {
          role: 'tool',
          content: '{"result":"done"}',
          toolCallId: 'tc1',
        },
      ],
      { model: 'gpt-4o' }
    );

    // Assert
    const calledParams = chatCreateMock.mock.calls[0]?.[0] as {
      messages: Array<{ role: string; tool_call_id?: string; content: string }>;
    };
    expect(calledParams.messages[0]).toMatchObject({
      role: 'tool',
      tool_call_id: 'tc1',
      content: '{"result":"done"}',
    });
  });

  it('uses empty string for tool_call_id when toolCallId is not provided', async () => {
    // Arrange
    chatCreateMock.mockResolvedValue(makeChatCompletion('ok', 'stop'));

    // Act
    const provider = makeProvider();
    await provider.chat([{ role: 'tool', content: 'result' }], { model: 'gpt-4o' });

    // Assert
    const calledParams = chatCreateMock.mock.calls[0]?.[0] as {
      messages: Array<{ role: string; tool_call_id?: string }>;
    };
    expect(calledParams.messages[0]?.tool_call_id).toBe('');
  });
});

// ---------------------------------------------------------------------------
// toOpenAiParts — multimodal content-part branches (exercised via toSdkMessage)
// ---------------------------------------------------------------------------

describe('toOpenAiParts — multimodal content-part mapping', () => {
  it('maps base64 image part to image_url with data URI', async () => {
    // Arrange
    chatCreateMock.mockResolvedValue(makeChatCompletion('ok', 'stop'));
    const provider = makeProvider();

    // Act — user message with base64 image content part
    await provider.chat(
      [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', mediaType: 'image/png', data: 'abc123' },
            },
          ],
        },
      ],
      { model: 'gpt-4o' }
    );

    // Assert — SDK message should include an image_url part with base64 data URI
    const calledParams = chatCreateMock.mock.calls[0]?.[0] as {
      messages: Array<{ role: string; content: unknown }>;
    };
    const msgContent = calledParams.messages[0]?.content as Array<Record<string, unknown>>;
    expect(msgContent).toHaveLength(1);
    expect(msgContent[0]).toMatchObject({
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,abc123' },
    });
  });

  it('maps URL image part to image_url with the raw URL', async () => {
    // Arrange
    chatCreateMock.mockResolvedValue(makeChatCompletion('ok', 'stop'));
    const provider = makeProvider();

    // Act — user message with URL image content part
    await provider.chat(
      [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'url', url: 'https://example.com/photo.jpg' },
            },
          ],
        },
      ],
      { model: 'gpt-4o' }
    );

    // Assert — SDK message should include an image_url part with the raw URL
    const calledParams = chatCreateMock.mock.calls[0]?.[0] as {
      messages: Array<{ role: string; content: unknown }>;
    };
    const msgContent = calledParams.messages[0]?.content as Array<Record<string, unknown>>;
    expect(msgContent).toHaveLength(1);
    expect(msgContent[0]).toMatchObject({
      type: 'image_url',
      image_url: { url: 'https://example.com/photo.jpg' },
    });
  });

  it('maps document part to a text block with decoded base64 content and filename header', async () => {
    // Arrange — base64-encode "Hello Doc" as the document data
    const docContent = 'Hello Doc';
    const docBase64 = Buffer.from(docContent).toString('base64');
    chatCreateMock.mockResolvedValue(makeChatCompletion('ok', 'stop'));
    const provider = makeProvider();

    // Act — user message with document content part
    await provider.chat(
      [
        {
          role: 'user',
          content: [
            {
              type: 'document',
              source: { type: 'base64', mediaType: 'text/plain', data: docBase64 },
              name: 'notes.txt',
            },
          ],
        },
      ],
      { model: 'gpt-4o' }
    );

    // Assert — OpenAI has no native document blocks; provider embeds as text
    const calledParams = chatCreateMock.mock.calls[0]?.[0] as {
      messages: Array<{ role: string; content: unknown }>;
    };
    const msgContent = calledParams.messages[0]?.content as Array<Record<string, unknown>>;
    expect(msgContent).toHaveLength(1);
    expect(msgContent[0]).toMatchObject({ type: 'text' });
    const text = (msgContent[0] as { type: string; text: string }).text;
    expect(text).toContain('[Document: notes.txt]');
    expect(text).toContain(docContent);
  });

  it('maps unknown content part type to an empty text block (fallback)', async () => {
    // Arrange — inject a part type that does not match text | image | document
    chatCreateMock.mockResolvedValue(makeChatCompletion('ok', 'stop'));
    const provider = makeProvider();

    // Act — cast to bypass TypeScript — exercises the final `return { type: 'text', text: '' }` branch
    await provider.chat(
      [
        {
          role: 'user',
          content: [{ type: 'video' as 'text', text: '' }],
        },
      ],
      { model: 'gpt-4o' }
    );

    // Assert — fallback yields an empty text block
    const calledParams = chatCreateMock.mock.calls[0]?.[0] as {
      messages: Array<{ role: string; content: unknown }>;
    };
    const msgContent = calledParams.messages[0]?.content as Array<Record<string, unknown>>;
    expect(msgContent).toHaveLength(1);
    expect(msgContent[0]).toEqual({ type: 'text', text: '' });
  });
});

describe('mapToolChoice mapping', () => {
  async function callWithToolChoice(
    toolChoice: unknown
  ): Promise<Record<string, unknown> | undefined> {
    chatCreateMock.mockResolvedValue(makeChatCompletion('ok', 'stop'));
    const provider = makeProvider();
    await provider.chat([{ role: 'user', content: 'x' }], {
      model: 'gpt-4o',
      tools: [{ name: 'fn', description: 'desc', parameters: {} }],
      toolChoice: toolChoice as never,
    });
    const params = chatCreateMock.mock.calls[0]?.[0] as Record<string, unknown>;
    chatCreateMock.mockReset();
    return params?.tool_choice as Record<string, unknown> | undefined;
  }

  it('passes "auto" string directly', async () => {
    const choice = await callWithToolChoice('auto');
    expect(choice).toBe('auto');
  });

  it('passes "none" string directly', async () => {
    const choice = await callWithToolChoice('none');
    expect(choice).toBe('none');
  });

  it('converts named tool choice to function object', async () => {
    const choice = await callWithToolChoice({ name: 'my_fn' });
    expect(choice).toEqual({ type: 'function', function: { name: 'my_fn' } });
  });

  it('omits tool_choice when toolChoice is undefined', async () => {
    chatCreateMock.mockResolvedValue(makeChatCompletion('ok', 'stop'));
    const provider = makeProvider();
    await provider.chat([{ role: 'user', content: 'x' }], {
      model: 'gpt-4o',
      tools: [{ name: 'fn', description: 'desc', parameters: {} }],
      // toolChoice is intentionally omitted
    });
    const params = chatCreateMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(params?.tool_choice).toBeUndefined();
  });
});

describe('mapFinishReason mapping', () => {
  async function getFinishReason(sdkReason: string | null): Promise<string> {
    chatCreateMock.mockResolvedValue(
      makeChatCompletion('ok', sdkReason ?? (null as unknown as string))
    );
    const provider = makeProvider();
    const response = await provider.chat([{ role: 'user', content: 'x' }], { model: 'gpt-4o' });
    chatCreateMock.mockReset();
    return response.finishReason;
  }

  it('maps "stop" to "stop"', async () => {
    expect(await getFinishReason('stop')).toBe('stop');
  });

  it('maps "length" to "length"', async () => {
    expect(await getFinishReason('length')).toBe('length');
  });

  it('maps "tool_calls" to "tool_use"', async () => {
    expect(await getFinishReason('tool_calls')).toBe('tool_use');
  });

  it('maps "function_call" to "tool_use"', async () => {
    expect(await getFinishReason('function_call')).toBe('tool_use');
  });

  it('maps "content_filter" to "error"', async () => {
    expect(await getFinishReason('content_filter')).toBe('error');
  });

  it('maps unknown value to "stop" as default', async () => {
    expect(await getFinishReason('unknown_reason')).toBe('stop');
  });

  it('maps null to "stop" as default', async () => {
    expect(await getFinishReason(null)).toBe('stop');
  });
});

describe('safeParseJson (via tool_call arguments)', () => {
  it('parses valid JSON arguments into an object', async () => {
    // Arrange — valid JSON tool_call arguments
    chatCreateMock.mockResolvedValue(
      makeChatCompletion('', 'tool_calls', [
        {
          id: 'tc1',
          type: 'function',
          function: { name: 'fn', arguments: '{"key":"value","num":42}' },
        },
      ])
    );

    // Act
    const provider = makeProvider();
    const response = await provider.chat([{ role: 'user', content: 'x' }], { model: 'gpt-4o' });

    // Assert
    expect(response.toolCalls?.[0]?.arguments).toEqual({ key: 'value', num: 42 });
  });

  it('returns empty object for invalid JSON', async () => {
    // Arrange — malformed JSON
    chatCreateMock.mockResolvedValue(
      makeChatCompletion('', 'tool_calls', [
        {
          id: 'tc1',
          type: 'function',
          function: { name: 'fn', arguments: '{invalid json' },
        },
      ])
    );

    // Act
    const provider = makeProvider();
    const response = await provider.chat([{ role: 'user', content: 'x' }], { model: 'gpt-4o' });

    // Assert — falls back to empty object
    expect(response.toolCalls?.[0]?.arguments).toEqual({});
  });

  it('returns empty object for empty arguments string', async () => {
    // Arrange — empty arguments
    chatCreateMock.mockResolvedValue(
      makeChatCompletion('', 'tool_calls', [
        {
          id: 'tc1',
          type: 'function',
          function: { name: 'fn', arguments: '' },
        },
      ])
    );

    // Act
    const provider = makeProvider();
    const response = await provider.chat([{ role: 'user', content: 'x' }], { model: 'gpt-4o' });

    // Assert
    expect(response.toolCalls?.[0]?.arguments).toEqual({});
  });

  it('wraps non-object JSON in a value key', async () => {
    // Arrange — JSON is an array, not an object
    chatCreateMock.mockResolvedValue(
      makeChatCompletion('', 'tool_calls', [
        {
          id: 'tc1',
          type: 'function',
          function: { name: 'fn', arguments: '[1,2,3]' },
        },
      ])
    );

    // Act
    const provider = makeProvider();
    const response = await provider.chat([{ role: 'user', content: 'x' }], { model: 'gpt-4o' });

    // Assert — arrays wrapped in { value: ... }
    expect(response.toolCalls?.[0]?.arguments).toEqual({ value: [1, 2, 3] });
  });
});

describe('toolCallFromSdk — non-function type is filtered out', () => {
  it('filters out tool_calls with type other than function', async () => {
    // Arrange — inject a tool_call with type != 'function'
    chatCreateMock.mockResolvedValue({
      id: 'r-nonfn',
      model: 'gpt-4o',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              // V8 coverage: the `if (call.type !== 'function') return null` branch
              { id: 'tc-x', type: 'other', function: { name: 'fn', arguments: '{}' } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });

    // Act
    const provider = makeProvider();
    const response = await provider.chat([{ role: 'user', content: 'x' }], { model: 'gpt-4o' });

    // Assert — the non-function tool_call is filtered and toolCalls is not set
    expect(response.toolCalls).toBeUndefined();
  });
});

describe('testConnection — non-Error rejection stringified', () => {
  it('returns ok: false when listModels rejection is a plain string (toProviderError wraps it)', async () => {
    // Arrange — modelsListMock rejects with a non-Error value.
    // toProviderError in listModels wraps it as a ProviderError with the fallback
    // message. testConnection then calls err instanceof Error (true for ProviderError)
    // and takes err.message.
    modelsListMock.mockRejectedValue('plain string error');

    // Act
    const provider = makeProvider();
    const result = await provider.testConnection();

    // Assert — error comes through as the toProviderError fallback message
    expect(result.ok).toBe(false);
    expect(typeof result.error).toBe('string');
    expect(result.models).toEqual([]);
  });
});

describe('chat — missing usage in response', () => {
  it('returns zero usage tokens when completion.usage is null', async () => {
    // Arrange — usage is null (some providers omit it)
    chatCreateMock.mockResolvedValue({
      id: 'r-nousage',
      model: 'gpt-4o',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'hi', tool_calls: null },
          finish_reason: 'stop',
        },
      ],
      usage: null,
    });

    // Act
    const provider = makeProvider();
    const response = await provider.chat([{ role: 'user', content: 'x' }], { model: 'gpt-4o' });

    // Assert — falls back to 0 via ?? operator
    expect(response.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
});

describe('buildBaseParams', () => {
  it('defaults max_tokens to 4096 when maxTokens is not specified', async () => {
    // Arrange
    chatCreateMock.mockResolvedValue(makeChatCompletion('ok', 'stop'));

    // Act
    const provider = makeProvider();
    await provider.chat([{ role: 'user', content: 'x' }], { model: 'gpt-4o' });

    // Assert
    const params = chatCreateMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(params?.max_tokens).toBe(4096);
  });

  it('does not include temperature when not specified', async () => {
    // Arrange
    chatCreateMock.mockResolvedValue(makeChatCompletion('ok', 'stop'));

    // Act
    const provider = makeProvider();
    await provider.chat([{ role: 'user', content: 'x' }], { model: 'gpt-4o' });

    // Assert
    const params = chatCreateMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(params?.temperature).toBeUndefined();
  });

  it('does not include tools when tools array is empty', async () => {
    // Arrange
    chatCreateMock.mockResolvedValue(makeChatCompletion('ok', 'stop'));

    // Act
    const provider = makeProvider();
    await provider.chat([{ role: 'user', content: 'x' }], { model: 'gpt-4o', tools: [] });

    // Assert
    const params = chatCreateMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(params?.tools).toBeUndefined();
  });

  it('includes tools when tools are provided', async () => {
    // Arrange
    chatCreateMock.mockResolvedValue(makeChatCompletion('ok', 'stop'));

    // Act
    const provider = makeProvider();
    await provider.chat([{ role: 'user', content: 'x' }], {
      model: 'gpt-4o',
      tools: [{ name: 'my_tool', description: 'does stuff', parameters: { type: 'object' } }],
    });

    // Assert
    const params = chatCreateMock.mock.calls[0]?.[0] as {
      tools?: Array<{ type: string; function: { name: string } }>;
    };
    expect(params?.tools).toHaveLength(1);
    expect(params?.tools?.[0]).toMatchObject({
      type: 'function',
      function: { name: 'my_tool', description: 'does stuff' },
    });
  });
});
