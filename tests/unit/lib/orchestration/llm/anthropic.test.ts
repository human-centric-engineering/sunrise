/**
 * Tests for AnthropicProvider: message conversion, tool round-trip,
 * and `embed()` rejection.
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
});
