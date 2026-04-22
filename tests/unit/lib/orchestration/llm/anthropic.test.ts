/**
 * Tests for AnthropicProvider: message conversion, tool round-trip,
 * streaming, helpers, and `embed()` rejection.
 *
 * We mock the `@anthropic-ai/sdk` default export so no network I/O runs.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const createMock = vi.fn();

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    public messages = { create: createMock };
    constructor(_opts: unknown) {}
  }
  return { default: MockAnthropic };
});

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { AnthropicProvider } = await import('@/lib/orchestration/llm/anthropic');
const { ProviderError } = await import('@/lib/orchestration/llm/provider');

beforeEach(() => {
  createMock.mockReset();
});

function makeProvider() {
  return new AnthropicProvider({
    name: 'anthropic',
    type: 'anthropic',
    apiKey: 'test-key',
    isLocal: false,
  });
}

/**
 * Build an async iterable from an array of raw Anthropic stream events.
 * The source file consumes `stream` with `for await (const event of stream)`,
 * so we just need an object that is async-iterable.
 */
async function* makeStream(events: object[]): AsyncGenerator<object, void, unknown> {
  for (const event of events) {
    yield event;
  }
}

describe('AnthropicProvider.chat', () => {
  it('extracts system messages and maps response content', async () => {
    createMock.mockResolvedValue({
      content: [{ type: 'text', text: 'hello!' }],
      usage: { input_tokens: 10, output_tokens: 3 },
      model: 'claude-sonnet-4-6',
      stop_reason: 'end_turn',
    });

    const provider = makeProvider();
    const response = await provider.chat(
      [
        { role: 'system', content: 'you are helpful' },
        { role: 'user', content: 'hi' },
      ],
      { model: 'claude-sonnet-4-6' }
    );

    expect(response.content).toBe('hello!');
    expect(response.usage).toEqual({ inputTokens: 10, outputTokens: 3 });
    expect(response.finishReason).toBe('stop');

    const callArgs = createMock.mock.calls[0][0];
    expect(callArgs.system).toBe('you are helpful');
    expect(callArgs.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('emits tool calls and maps finishReason=tool_use', async () => {
    createMock.mockResolvedValue({
      content: [
        { type: 'text', text: 'calling tool' },
        {
          type: 'tool_use',
          id: 'tool_1',
          name: 'search',
          input: { query: 'cats' },
        },
      ],
      usage: { input_tokens: 5, output_tokens: 5 },
      model: 'claude-sonnet-4-6',
      stop_reason: 'tool_use',
    });

    const provider = makeProvider();
    const response = await provider.chat([{ role: 'user', content: 'find cats' }], {
      model: 'claude-sonnet-4-6',
      tools: [
        {
          name: 'search',
          description: 'search the web',
          parameters: { type: 'object', properties: { query: { type: 'string' } } },
        },
      ],
    });

    expect(response.finishReason).toBe('tool_use');
    expect(response.toolCalls).toEqual([
      { id: 'tool_1', name: 'search', arguments: { query: 'cats' } },
    ]);
  });

  it('converts tool results back into Anthropic user messages', async () => {
    createMock.mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 1, output_tokens: 1 },
      model: 'claude-sonnet-4-6',
      stop_reason: 'end_turn',
    });

    const provider = makeProvider();
    await provider.chat(
      [
        { role: 'user', content: 'search' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 't1', name: 'search', arguments: { q: 'x' } }],
        },
        { role: 'tool', content: 'result!', toolCallId: 't1' },
      ],
      { model: 'claude-sonnet-4-6' }
    );

    const args = createMock.mock.calls[0][0];
    // Last message should be user with tool_result content block.
    const last = args.messages[args.messages.length - 1];
    expect(last.role).toBe('user');
    expect(last.content[0].type).toBe('tool_result');
    expect(last.content[0].tool_use_id).toBe('t1');
    expect(last.content[0].content).toBe('result!');
  });

  it('wraps SDK errors as ProviderError', async () => {
    // Arrange: SDK throws a plain Error during chat
    createMock.mockRejectedValue(new Error('upstream failure'));

    const provider = makeProvider();

    // Act + Assert
    await expect(
      provider.chat([{ role: 'user', content: 'hi' }], { model: 'claude-haiku-4-5' })
    ).rejects.toBeInstanceOf(ProviderError);
  });

  it('passes tools array to the underlying params when tools are provided', async () => {
    createMock.mockResolvedValue({
      content: [{ type: 'text', text: 'done' }],
      usage: { input_tokens: 2, output_tokens: 2 },
      model: 'claude-sonnet-4-6',
      stop_reason: 'end_turn',
    });

    const provider = makeProvider();
    await provider.chat([{ role: 'user', content: 'go' }], {
      model: 'claude-sonnet-4-6',
      tools: [
        {
          name: 'calc',
          description: 'calculator',
          parameters: { type: 'object', properties: {} },
        },
      ],
      toolChoice: 'auto',
    });

    const callArgs = createMock.mock.calls[0][0];
    expect(callArgs.tools).toBeDefined();
    expect(callArgs.tools[0].name).toBe('calc');
  });

  it('passes temperature when specified', async () => {
    createMock.mockResolvedValue({
      content: [{ type: 'text', text: 'cool' }],
      usage: { input_tokens: 1, output_tokens: 1 },
      model: 'claude-haiku-4-5',
      stop_reason: 'end_turn',
    });

    const provider = makeProvider();
    await provider.chat([{ role: 'user', content: 'hi' }], {
      model: 'claude-haiku-4-5',
      temperature: 0.7,
    });

    const callArgs = createMock.mock.calls[0][0];
    expect(callArgs.temperature).toBe(0.7);
  });
});

describe('AnthropicProvider.chatStream', () => {
  it('yields text chunks from text_delta events', async () => {
    const events = [
      { type: 'message_start', message: { usage: { input_tokens: 10 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' world' } },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 5 },
      },
      { type: 'message_stop' },
    ];
    createMock.mockResolvedValue(makeStream(events));

    const provider = makeProvider();
    const chunks: object[] = [];
    for await (const chunk of provider.chatStream([{ role: 'user', content: 'hi' }], {
      model: 'claude-haiku-4-5',
    })) {
      chunks.push(chunk);
    }

    // Should have two text chunks plus one done chunk
    expect(chunks).toContainEqual({ type: 'text', content: 'Hello' });
    expect(chunks).toContainEqual({ type: 'text', content: ' world' });
    const done = chunks[chunks.length - 1] as { type: string; usage: object; finishReason: string };
    expect(done.type).toBe('done');
    expect(done.finishReason).toBe('stop');
    expect(done.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
  });

  it('records input_tokens from message_start event', async () => {
    const events = [
      { type: 'message_start', message: { usage: { input_tokens: 42 } } },
      { type: 'message_stop' },
    ];
    createMock.mockResolvedValue(makeStream(events));

    const provider = makeProvider();
    const chunks: object[] = [];
    for await (const chunk of provider.chatStream([{ role: 'user', content: 'ping' }], {
      model: 'claude-haiku-4-5',
    })) {
      chunks.push(chunk);
    }

    const done = chunks[chunks.length - 1] as { type: string; usage: { inputTokens: number } };
    expect(done.usage.inputTokens).toBe(42);
  });

  it('buffers tool_use content_block and emits tool_call on block_stop', async () => {
    const events = [
      { type: 'message_start', message: { usage: { input_tokens: 5 } } },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'call_abc', name: 'search' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"q":' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '"cats"}' },
      },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use' },
        usage: { output_tokens: 8 },
      },
    ];
    createMock.mockResolvedValue(makeStream(events));

    const provider = makeProvider();
    const chunks: object[] = [];
    for await (const chunk of provider.chatStream([{ role: 'user', content: 'find cats' }], {
      model: 'claude-haiku-4-5',
    })) {
      chunks.push(chunk);
    }

    const toolChunk = chunks.find(
      (c): c is { type: 'tool_call'; toolCall: { id: string; name: string; arguments: object } } =>
        (c as { type: string }).type === 'tool_call'
    );
    expect(toolChunk).toBeDefined();
    expect(toolChunk?.toolCall.id).toBe('call_abc');
    expect(toolChunk?.toolCall.name).toBe('search');
    expect(toolChunk?.toolCall.arguments).toEqual({ q: 'cats' });

    const done = chunks[chunks.length - 1] as { type: string; finishReason: string };
    expect(done.finishReason).toBe('tool_use');
  });

  it('handles malformed tool input JSON gracefully via safeParseJson fallback', async () => {
    const events = [
      { type: 'message_start', message: { usage: { input_tokens: 1 } } },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'call_bad', name: 'broken' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{invalid json' },
      },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } },
    ];
    createMock.mockResolvedValue(makeStream(events));

    const provider = makeProvider();
    const chunks: object[] = [];
    for await (const chunk of provider.chatStream([{ role: 'user', content: 'go' }], {
      model: 'claude-haiku-4-5',
    })) {
      chunks.push(chunk);
    }

    const toolChunk = chunks.find(
      (c): c is { type: 'tool_call'; toolCall: { arguments: Record<string, unknown> } } =>
        (c as { type: string }).type === 'tool_call'
    );
    expect(toolChunk).toBeDefined();
    // safeParseJson returns {} for malformed JSON
    expect(toolChunk?.toolCall.arguments).toEqual({});
  });

  it('honours AbortSignal aborted before event iteration begins', async () => {
    const controller = new AbortController();
    controller.abort();

    // Stream has one event that would normally process fine
    const events = [{ type: 'message_start', message: { usage: { input_tokens: 1 } } }];
    createMock.mockResolvedValue(makeStream(events));

    const provider = makeProvider();

    await expect(async () => {
      for await (const _chunk of provider.chatStream([{ role: 'user', content: 'hi' }], {
        model: 'claude-haiku-4-5',
        signal: controller.signal,
      })) {
        // Should never reach here
      }
    }).rejects.toMatchObject({ code: 'aborted', retriable: false });
  });

  it('wraps SDK errors thrown at stream creation as ProviderError', async () => {
    // Arrange: messages.create() itself rejects before we can iterate
    createMock.mockRejectedValue(new Error('stream init failed'));

    const provider = makeProvider();

    await expect(async () => {
      for await (const _chunk of provider.chatStream([{ role: 'user', content: 'hi' }], {
        model: 'claude-haiku-4-5',
      })) {
        // nothing
      }
    }).rejects.toBeInstanceOf(ProviderError);
  });

  it('wraps errors thrown during stream iteration as ProviderError', async () => {
    // Arrange: create a generator that throws mid-stream
    async function* throwingStream() {
      yield { type: 'message_start', message: { usage: { input_tokens: 1 } } };
      throw new Error('mid-stream error');
    }
    createMock.mockResolvedValue(throwingStream());

    const provider = makeProvider();

    await expect(async () => {
      for await (const _chunk of provider.chatStream([{ role: 'user', content: 'hi' }], {
        model: 'claude-haiku-4-5',
      })) {
        // nothing
      }
    }).rejects.toBeInstanceOf(ProviderError);
  });

  it('passes stream:true in the SDK call params', async () => {
    const events = [
      { type: 'message_start', message: { usage: { input_tokens: 1 } } },
      { type: 'message_stop' },
    ];
    createMock.mockResolvedValue(makeStream(events));

    const provider = makeProvider();
    for await (const _chunk of provider.chatStream([{ role: 'user', content: 'hi' }], {
      model: 'claude-haiku-4-5',
    })) {
      // drain
    }

    const callArgs = createMock.mock.calls[0][0];
    expect(callArgs.stream).toBe(true);
  });

  it('handles content_block_stop for non-tool index gracefully (no tool_call emitted)', async () => {
    // content_block_stop on an index that was never registered as tool_use
    const events = [
      { type: 'message_start', message: { usage: { input_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
    ];
    createMock.mockResolvedValue(makeStream(events));

    const provider = makeProvider();
    const chunks: object[] = [];
    for await (const chunk of provider.chatStream([{ role: 'user', content: 'hi' }], {
      model: 'claude-haiku-4-5',
    })) {
      chunks.push(chunk);
    }

    const toolChunks = chunks.filter((c) => (c as { type: string }).type === 'tool_call');
    expect(toolChunks).toHaveLength(0);
  });

  it('handles message_delta with no output_tokens gracefully', async () => {
    const events = [
      { type: 'message_start', message: { usage: { input_tokens: 3 } } },
      // message_delta without usage
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
      { type: 'message_stop' },
    ];
    createMock.mockResolvedValue(makeStream(events));

    const provider = makeProvider();
    const chunks: object[] = [];
    for await (const chunk of provider.chatStream([{ role: 'user', content: 'hi' }], {
      model: 'claude-haiku-4-5',
    })) {
      chunks.push(chunk);
    }

    const done = chunks[chunks.length - 1] as {
      type: string;
      usage: { outputTokens: number };
    };
    expect(done.type).toBe('done');
    // outputTokens should remain 0 since no usage was provided
    expect(done.usage.outputTokens).toBe(0);
  });

  it('ignores unknown event types (message_stop, ping) without errors', async () => {
    const events = [
      { type: 'message_start', message: { usage: { input_tokens: 1 } } },
      { type: 'ping' },
      { type: 'message_stop' },
    ];
    createMock.mockResolvedValue(makeStream(events));

    const provider = makeProvider();
    const chunks: object[] = [];
    for await (const chunk of provider.chatStream([{ role: 'user', content: 'hi' }], {
      model: 'claude-haiku-4-5',
    })) {
      chunks.push(chunk);
    }

    const done = chunks[chunks.length - 1] as { type: string };
    expect(done.type).toBe('done');
  });
});

describe('AnthropicProvider.testConnection', () => {
  it('returns ok:true with model ids on successful ping', async () => {
    createMock.mockResolvedValue({
      content: [{ type: 'text', text: 'pong' }],
      usage: { input_tokens: 1, output_tokens: 1 },
      model: 'claude-haiku-4-5',
      stop_reason: 'end_turn',
    });

    const provider = makeProvider();
    const result = await provider.testConnection();

    expect(result.ok).toBe(true);
    expect(result.models).toContain('claude-haiku-4-5');
    expect(result.models).toContain('claude-sonnet-4-6');
    expect(result.models).toContain('claude-opus-4-6');
    expect(result.error).toBeUndefined();
  });

  it('returns ok:false with error message when SDK throws', async () => {
    createMock.mockRejectedValue(new Error('auth failed'));

    const provider = makeProvider();
    const result = await provider.testConnection();

    expect(result.ok).toBe(false);
    expect(result.models).toEqual([]);
    expect(result.error).toBe('auth failed');
  });

  it('returns ok:false with stringified error for non-Error throws', async () => {
    createMock.mockRejectedValue('plain string error');

    const provider = makeProvider();
    const result = await provider.testConnection();

    expect(result.ok).toBe(false);
    expect(result.error).toBe('plain string error');
  });
});

describe('AnthropicProvider.listModels', () => {
  it('returns a copy of all Claude models', async () => {
    const provider = makeProvider();
    const models = await provider.listModels();

    expect(models).toHaveLength(3);
    const ids = models.map((m) => m.id);
    expect(ids).toContain('claude-opus-4-6');
    expect(ids).toContain('claude-sonnet-4-6');
    expect(ids).toContain('claude-haiku-4-5');
  });

  it('returns models with correct provider field', async () => {
    const provider = makeProvider();
    const models = await provider.listModels();

    for (const model of models) {
      expect(model.provider).toBe('anthropic');
    }
  });
});

describe('AnthropicProvider.embed', () => {
  it('throws a non-retriable ProviderError', async () => {
    const provider = makeProvider();
    await expect(provider.embed('anything')).rejects.toBeInstanceOf(ProviderError);
    await expect(provider.embed('anything')).rejects.toMatchObject({
      code: 'not_supported',
      retriable: false,
    });
  });
});

describe('AnthropicProvider constructor', () => {
  it('throws when apiKey is missing', () => {
    expect(() => new AnthropicProvider({ name: 'x', type: 'anthropic', isLocal: false })).toThrow(
      /apiKey/
    );
  });

  it('throws a ProviderError with code missing_api_key when apiKey is missing', () => {
    expect(() => new AnthropicProvider({ name: 'x', type: 'anthropic', isLocal: false })).toThrow(
      ProviderError
    );
  });
});

describe('splitSystemMessages helper (via chat params)', () => {
  beforeEach(() => {
    createMock.mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 1, output_tokens: 1 },
      model: 'claude-haiku-4-5',
      stop_reason: 'end_turn',
    });
  });

  it('concatenates multiple leading system messages with double newline', async () => {
    const provider = makeProvider();
    await provider.chat(
      [
        { role: 'system', content: 'instruction one' },
        { role: 'system', content: 'instruction two' },
        { role: 'user', content: 'go' },
      ],
      { model: 'claude-haiku-4-5' }
    );

    const callArgs = createMock.mock.calls[0][0];
    expect(callArgs.system).toBe('instruction one\n\ninstruction two');
  });

  it('omits system key when no system messages are present', async () => {
    const provider = makeProvider();
    await provider.chat([{ role: 'user', content: 'hi' }], { model: 'claude-haiku-4-5' });

    const callArgs = createMock.mock.calls[0][0];
    expect(callArgs.system).toBeUndefined();
  });

  it('passes system message with empty content as empty part (skipped via falsy check)', async () => {
    const provider = makeProvider();
    await provider.chat(
      [
        { role: 'system', content: '' },
        { role: 'user', content: 'hi' },
      ],
      { model: 'claude-haiku-4-5' }
    );

    const callArgs = createMock.mock.calls[0][0];
    // Empty string is falsy — splitSystemMessages skips it, so system is undefined
    expect(callArgs.system).toBeUndefined();
  });

  it('keeps a system message that appears after user messages in the conversation array', async () => {
    // System messages in Anthropic go into the `system` param regardless of position;
    // non-system messages pass through to the conversation array.
    const provider = makeProvider();
    await provider.chat(
      [
        { role: 'user', content: 'first' },
        { role: 'system', content: 'late system' },
        { role: 'user', content: 'second' },
      ],
      { model: 'claude-haiku-4-5' }
    );

    const callArgs = createMock.mock.calls[0][0];
    // The system content should still be extracted to the system param
    expect(callArgs.system).toBe('late system');
    // Conversation should only have the two user messages
    expect(callArgs.messages).toHaveLength(2);
    expect(callArgs.messages[0]).toEqual({ role: 'user', content: 'first' });
    expect(callArgs.messages[1]).toEqual({ role: 'user', content: 'second' });
  });

  it('handles assistant message with both content and toolCalls as multi-block', async () => {
    const provider = makeProvider();
    await provider.chat(
      [
        { role: 'user', content: 'do it' },
        {
          role: 'assistant',
          content: 'thinking...',
          toolCalls: [{ id: 'tc1', name: 'fn', arguments: { x: 1 } }],
        },
        { role: 'tool', content: 'done', toolCallId: 'tc1' },
      ],
      { model: 'claude-haiku-4-5' }
    );

    const callArgs = createMock.mock.calls[0][0];
    const assistantMsg = callArgs.messages[1] as {
      role: string;
      content: Array<{ type: string; text?: string; id?: string; name?: string }>;
    };
    expect(assistantMsg.role).toBe('assistant');
    expect(assistantMsg.content).toHaveLength(2);
    expect(assistantMsg.content[0]).toEqual({ type: 'text', text: 'thinking...' });
    expect(assistantMsg.content[1]).toMatchObject({ type: 'tool_use', id: 'tc1', name: 'fn' });
  });

  it('handles assistant message with only toolCalls (no text content block)', async () => {
    const provider = makeProvider();
    await provider.chat(
      [
        { role: 'user', content: 'do it' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'tc2', name: 'greet', arguments: {} }],
        },
        { role: 'tool', content: 'hello', toolCallId: 'tc2' },
      ],
      { model: 'claude-haiku-4-5' }
    );

    const callArgs = createMock.mock.calls[0][0];
    const assistantMsg = callArgs.messages[1] as {
      role: string;
      content: Array<{ type: string }>;
    };
    // content is empty so only the tool_use block should appear
    expect(assistantMsg.content).toHaveLength(1);
    expect(assistantMsg.content[0].type).toBe('tool_use');
  });
});

describe('mapToolChoice helper (via chat params with tools)', () => {
  beforeEach(() => {
    createMock.mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 1, output_tokens: 1 },
      model: 'claude-haiku-4-5',
      stop_reason: 'end_turn',
    });
  });

  const baseTool = {
    name: 'fn',
    description: 'desc',
    parameters: { type: 'object', properties: {} },
  };

  it("maps toolChoice 'auto' to { type: 'auto' }", async () => {
    const provider = makeProvider();
    await provider.chat([{ role: 'user', content: 'go' }], {
      model: 'claude-haiku-4-5',
      tools: [baseTool],
      toolChoice: 'auto',
    });

    const callArgs = createMock.mock.calls[0][0];
    expect(callArgs.tool_choice).toEqual({ type: 'auto' });
  });

  it("maps toolChoice 'none' to { type: 'none' }", async () => {
    const provider = makeProvider();
    await provider.chat([{ role: 'user', content: 'go' }], {
      model: 'claude-haiku-4-5',
      tools: [baseTool],
      toolChoice: 'none',
    });

    const callArgs = createMock.mock.calls[0][0];
    expect(callArgs.tool_choice).toEqual({ type: 'none' });
  });

  it('maps toolChoice {name} to { type: "tool", name }', async () => {
    const provider = makeProvider();
    await provider.chat([{ role: 'user', content: 'go' }], {
      model: 'claude-haiku-4-5',
      tools: [baseTool],
      toolChoice: { name: 'fn' },
    });

    const callArgs = createMock.mock.calls[0][0];
    expect(callArgs.tool_choice).toEqual({ type: 'tool', name: 'fn' });
  });

  it('omits tool_choice when toolChoice is undefined', async () => {
    const provider = makeProvider();
    await provider.chat([{ role: 'user', content: 'go' }], {
      model: 'claude-haiku-4-5',
      tools: [baseTool],
      // no toolChoice
    });

    const callArgs = createMock.mock.calls[0][0];
    expect(callArgs.tool_choice).toBeUndefined();
  });
});

describe('buildToolInputSchema helper (via chat params with tools)', () => {
  beforeEach(() => {
    createMock.mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 1, output_tokens: 1 },
      model: 'claude-haiku-4-5',
      stop_reason: 'end_turn',
    });
  });

  it('always sets type:"object" at the top level of the input schema', async () => {
    const provider = makeProvider();
    await provider.chat([{ role: 'user', content: 'go' }], {
      model: 'claude-haiku-4-5',
      tools: [
        {
          name: 'fn',
          description: 'desc',
          // Note: type is something else; buildToolInputSchema should force 'object'
          parameters: { type: 'string', properties: { q: { type: 'string' } } },
        },
      ],
    });

    const callArgs = createMock.mock.calls[0][0];
    expect(callArgs.tools[0].input_schema.type).toBe('object');
  });

  it('preserves additional JSON Schema keys (properties, required)', async () => {
    const provider = makeProvider();
    await provider.chat([{ role: 'user', content: 'go' }], {
      model: 'claude-haiku-4-5',
      tools: [
        {
          name: 'fn',
          description: 'desc',
          parameters: {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
          },
        },
      ],
    });

    const callArgs = createMock.mock.calls[0][0];
    const schema = callArgs.tools[0].input_schema as {
      type: string;
      properties: object;
      required: string[];
    };
    expect(schema.properties).toEqual({ query: { type: 'string' } });
    expect(schema.required).toEqual(['query']);
  });
});

describe('mapStopReason helper (via chat response)', () => {
  async function chatWithStopReason(stop_reason: string | null) {
    createMock.mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 1, output_tokens: 1 },
      model: 'claude-haiku-4-5',
      stop_reason,
    });
    const provider = makeProvider();
    return provider.chat([{ role: 'user', content: 'hi' }], { model: 'claude-haiku-4-5' });
  }

  it("maps 'end_turn' to 'stop'", async () => {
    const r = await chatWithStopReason('end_turn');
    expect(r.finishReason).toBe('stop');
  });

  it("maps 'stop_sequence' to 'stop'", async () => {
    const r = await chatWithStopReason('stop_sequence');
    expect(r.finishReason).toBe('stop');
  });

  it("maps 'pause_turn' to 'stop'", async () => {
    const r = await chatWithStopReason('pause_turn');
    expect(r.finishReason).toBe('stop');
  });

  it("maps 'tool_use' to 'tool_use'", async () => {
    createMock.mockResolvedValue({
      content: [],
      usage: { input_tokens: 1, output_tokens: 1 },
      model: 'claude-haiku-4-5',
      stop_reason: 'tool_use',
    });
    const provider = makeProvider();
    const r = await provider.chat([{ role: 'user', content: 'hi' }], {
      model: 'claude-haiku-4-5',
    });
    expect(r.finishReason).toBe('tool_use');
  });

  it("maps 'max_tokens' to 'length'", async () => {
    const r = await chatWithStopReason('max_tokens');
    expect(r.finishReason).toBe('length');
  });

  it("maps 'refusal' to 'error'", async () => {
    const r = await chatWithStopReason('refusal');
    expect(r.finishReason).toBe('error');
  });

  it('maps null stop_reason to stop', async () => {
    const r = await chatWithStopReason(null);
    expect(r.finishReason).toBe('stop');
  });

  it('maps unknown stop_reason to stop', async () => {
    const r = await chatWithStopReason('something_new');
    expect(r.finishReason).toBe('stop');
  });
});

describe('AnthropicProvider.chatStream — additional branch coverage', () => {
  it('ignores input_json_delta for an index that was never registered as tool_use', async () => {
    // Covers: buf is undefined in the input_json_delta branch (lines 215-217)
    const events = [
      { type: 'message_start', message: { usage: { input_tokens: 1 } } },
      // No content_block_start for index 99 — so toolBuffers has no entry for it
      {
        type: 'content_block_delta',
        index: 99,
        delta: { type: 'input_json_delta', partial_json: '{"x":1}' },
      },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
    ];
    createMock.mockResolvedValue(makeStream(events));

    const provider = makeProvider();
    const chunks: object[] = [];
    for await (const chunk of provider.chatStream([{ role: 'user', content: 'hi' }], {
      model: 'claude-haiku-4-5',
    })) {
      chunks.push(chunk);
    }

    // Should complete normally with a done chunk and no tool_call chunks
    const toolChunks = chunks.filter((c) => (c as { type: string }).type === 'tool_call');
    expect(toolChunks).toHaveLength(0);
    const done = chunks[chunks.length - 1] as { type: string };
    expect(done.type).toBe('done');
  });

  it('handles message_delta with usage.output_tokens set to null gracefully', async () => {
    // Covers: the output_tokens null branch on line 239
    const events = [
      { type: 'message_start', message: { usage: { input_tokens: 2 } } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: null } },
    ];
    createMock.mockResolvedValue(makeStream(events));

    const provider = makeProvider();
    const chunks: object[] = [];
    for await (const chunk of provider.chatStream([{ role: 'user', content: 'hi' }], {
      model: 'claude-haiku-4-5',
    })) {
      chunks.push(chunk);
    }

    const done = chunks[chunks.length - 1] as { type: string; usage: { outputTokens: number } };
    expect(done.type).toBe('done');
    expect(done.usage.outputTokens).toBe(0);
  });
});

describe('tool message without toolCallId (covers ?? fallback)', () => {
  it('uses empty string for tool_use_id when toolCallId is missing', async () => {
    createMock.mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 1, output_tokens: 1 },
      model: 'claude-haiku-4-5',
      stop_reason: 'end_turn',
    });

    const provider = makeProvider();
    await provider.chat(
      [
        { role: 'user', content: 'go' },
        // tool message without toolCallId — covers msg.toolCallId ?? '' (line 351)
        { role: 'tool', content: 'result' },
      ],
      { model: 'claude-haiku-4-5' }
    );

    const callArgs = createMock.mock.calls[0][0];
    const toolMsg = callArgs.messages[1] as {
      role: string;
      content: Array<{ tool_use_id: string }>;
    };
    expect(toolMsg.content[0].tool_use_id).toBe('');
  });
});

describe('toolUseBlockToToolCall — null input fallback', () => {
  it('uses {} when block.input is null/undefined (covers ?? {} fallback)', async () => {
    // Trigger via chat() response that contains a tool_use block with null input
    createMock.mockResolvedValue({
      content: [
        {
          type: 'tool_use',
          id: 'tool_null',
          name: 'fn',
          input: null,
        },
      ],
      usage: { input_tokens: 1, output_tokens: 1 },
      model: 'claude-haiku-4-5',
      stop_reason: 'tool_use',
    });

    const provider = makeProvider();
    const response = await provider.chat([{ role: 'user', content: 'hi' }], {
      model: 'claude-haiku-4-5',
    });

    expect(response.toolCalls).toBeDefined();
    expect(response.toolCalls![0].arguments).toEqual({});
  });
});

describe('safeParseJson helper (exercised via chatStream tool buffering)', () => {
  it('parses valid JSON object and returns it as arguments', async () => {
    const events = [
      { type: 'message_start', message: { usage: { input_tokens: 1 } } },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'id1', name: 'fn' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"key":"value"}' },
      },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } },
    ];
    createMock.mockResolvedValue(makeStream(events));

    const provider = makeProvider();
    const chunks: object[] = [];
    for await (const chunk of provider.chatStream([{ role: 'user', content: 'hi' }], {
      model: 'claude-haiku-4-5',
    })) {
      chunks.push(chunk);
    }

    const toolChunk = chunks.find(
      (c): c is { type: 'tool_call'; toolCall: { arguments: Record<string, unknown> } } =>
        (c as { type: string }).type === 'tool_call'
    );
    expect(toolChunk?.toolCall.arguments).toEqual({ key: 'value' });
  });

  it('wraps a valid non-object JSON value (e.g. array) in {value}', async () => {
    const events = [
      { type: 'message_start', message: { usage: { input_tokens: 1 } } },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'id2', name: 'fn' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        // JSON array is valid JSON but not an object
        delta: { type: 'input_json_delta', partial_json: '[1,2,3]' },
      },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } },
    ];
    createMock.mockResolvedValue(makeStream(events));

    const provider = makeProvider();
    const chunks: object[] = [];
    for await (const chunk of provider.chatStream([{ role: 'user', content: 'hi' }], {
      model: 'claude-haiku-4-5',
    })) {
      chunks.push(chunk);
    }

    const toolChunk = chunks.find(
      (c): c is { type: 'tool_call'; toolCall: { arguments: Record<string, unknown> } } =>
        (c as { type: string }).type === 'tool_call'
    );
    expect(toolChunk?.toolCall.arguments).toEqual({ value: [1, 2, 3] });
  });

  it('returns empty object for empty partial JSON string', async () => {
    const events = [
      { type: 'message_start', message: { usage: { input_tokens: 1 } } },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'id3', name: 'fn' },
      },
      // No input_json_delta events — partial remains ''
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } },
    ];
    createMock.mockResolvedValue(makeStream(events));

    const provider = makeProvider();
    const chunks: object[] = [];
    for await (const chunk of provider.chatStream([{ role: 'user', content: 'hi' }], {
      model: 'claude-haiku-4-5',
    })) {
      chunks.push(chunk);
    }

    const toolChunk = chunks.find(
      (c): c is { type: 'tool_call'; toolCall: { arguments: Record<string, unknown> } } =>
        (c as { type: string }).type === 'tool_call'
    );
    expect(toolChunk?.toolCall.arguments).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Branch-hardening: SDK status-bearing errors → ProviderError mapping
// ---------------------------------------------------------------------------

describe('AnthropicProvider.chat — SDK status-bearing error mapping', () => {
  it('wraps a 429 rate-limit SDK error as a retriable ProviderError with status 429', async () => {
    // Arrange: simulate the SDK throwing an error that carries status=429 (like RateLimitError)
    const rateLimitErr = Object.assign(new Error('rate limit exceeded'), { status: 429 });
    createMock.mockRejectedValue(rateLimitErr);

    const provider = makeProvider();

    // Act + Assert
    const thrown = await provider
      .chat([{ role: 'user', content: 'hi' }], { model: 'claude-haiku-4-5' })
      .catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(ProviderError);
    const pe = thrown as ProviderError;
    // toProviderError reads .status and marks it retriable when status is 429
    expect(pe.status).toBe(429);
    expect(pe.retriable).toBe(true);
    expect(pe.code).toBe('http_429');
  });

  it('wraps a 400 bad-request SDK error as a non-retriable ProviderError with status 400', async () => {
    // Arrange: simulate the SDK throwing an error that carries status=400 (like BadRequestError
    // for context-window-exceeded or invalid parameters)
    const badRequestErr = Object.assign(new Error('context_length_exceeded: too many tokens'), {
      status: 400,
    });
    createMock.mockRejectedValue(badRequestErr);

    const provider = makeProvider();

    // Act + Assert
    const thrown = await provider
      .chat([{ role: 'user', content: 'hi' }], { model: 'claude-haiku-4-5' })
      .catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(ProviderError);
    const pe = thrown as ProviderError;
    // 400 is not in the retriable set (429 or 5xx only)
    expect(pe.status).toBe(400);
    expect(pe.retriable).toBe(false);
    expect(pe.code).toBe('http_400');
  });
});

// ---------------------------------------------------------------------------
// Branch-hardening: structured output extraction via tool-based pattern
// ---------------------------------------------------------------------------

describe('AnthropicProvider.chat — structured output extraction (json_schema responseFormat)', () => {
  it('extracts structured output from __structured_ tool_use block as JSON text content', async () => {
    // Arrange: the model responds with a tool_use block using the __structured_ convention;
    // the provider should convert its arguments to JSON text rather than treating it as a tool call.
    const structuredPayload = { name: 'Alice', age: 30 };
    createMock.mockResolvedValue({
      content: [
        {
          type: 'tool_use',
          id: 'struct_1',
          name: '__structured_user_profile',
          input: structuredPayload,
        },
      ],
      usage: { input_tokens: 8, output_tokens: 12 },
      model: 'claude-sonnet-4-6',
      stop_reason: 'tool_use',
    });

    const provider = makeProvider();
    const response = await provider.chat([{ role: 'user', content: 'extract user profile' }], {
      model: 'claude-sonnet-4-6',
      responseFormat: {
        type: 'json_schema',
        name: 'user_profile',
        schema: {
          type: 'object',
          properties: { name: { type: 'string' }, age: { type: 'number' } },
        },
      },
    });

    // The structured extraction path should produce content (JSON string), not toolCalls
    expect(response.content).toBe(JSON.stringify(structuredPayload));
    expect(response.toolCalls).toBeUndefined();
    // finishReason is forced to 'stop' for structured extractions regardless of stop_reason
    expect(response.finishReason).toBe('stop');
  });

  it('passes the extraction tool and forced tool_choice to the SDK when responseFormat is json_schema', async () => {
    // Arrange: verify the params sent to the SDK include the extraction tool definition
    createMock.mockResolvedValue({
      content: [
        {
          type: 'tool_use',
          id: 'struct_2',
          name: '__structured_result',
          input: { value: 42 },
        },
      ],
      usage: { input_tokens: 5, output_tokens: 5 },
      model: 'claude-haiku-4-5',
      stop_reason: 'tool_use',
    });

    const provider = makeProvider();
    await provider.chat([{ role: 'user', content: 'compute' }], {
      model: 'claude-haiku-4-5',
      responseFormat: {
        type: 'json_schema',
        name: 'result',
        schema: { type: 'object', properties: { value: { type: 'number' } } },
      },
    });

    const callArgs = createMock.mock.calls[0][0] as {
      tools: Array<{ name: string; description: string }>;
      tool_choice: { type: string; name: string };
    };
    // The extraction tool name should be __structured_<name>
    expect(callArgs.tools).toHaveLength(1);
    expect(callArgs.tools[0].name).toBe('__structured_result');
    // Tool choice must be forced to the extraction tool
    expect(callArgs.tool_choice).toEqual({ type: 'tool', name: '__structured_result' });
  });
});

describe('AnthropicProvider.chatStream — structured output extraction (json_schema responseFormat)', () => {
  it('emits assembled JSON as text chunk (not tool_call) when tool name starts with __structured_', async () => {
    // Arrange: streaming structured output — the tool buffer is assembled and emitted as text
    const events = [
      { type: 'message_start', message: { usage: { input_tokens: 10 } } },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'struct_s1', name: '__structured_answer' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"answer":' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '"42"}' },
      },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use' },
        usage: { output_tokens: 6 },
      },
    ];
    createMock.mockResolvedValue(makeStream(events));

    const provider = makeProvider();
    const chunks: object[] = [];
    for await (const chunk of provider.chatStream([{ role: 'user', content: 'answer?' }], {
      model: 'claude-haiku-4-5',
      responseFormat: {
        type: 'json_schema',
        name: 'answer',
        schema: { type: 'object', properties: { answer: { type: 'string' } } },
      },
    })) {
      chunks.push(chunk);
    }

    // Should have a text chunk with the JSON-stringified parsed result, NOT a tool_call chunk
    const textChunks = chunks.filter((c) => (c as { type: string }).type === 'text');
    const toolChunks = chunks.filter((c) => (c as { type: string }).type === 'tool_call');

    expect(toolChunks).toHaveLength(0);
    expect(textChunks).toHaveLength(1);
    // The content should be the JSON-stringified parsed payload
    expect((textChunks[0] as { type: string; content: string }).content).toBe(
      JSON.stringify({ answer: '42' })
    );

    // finishReason in done chunk should be 'stop' (forced for structured extraction)
    const done = chunks[chunks.length - 1] as { type: string; finishReason: string };
    expect(done.type).toBe('done');
    expect(done.finishReason).toBe('stop');
  });
});
