/**
 * Tests for OpenAiCompatibleProvider: listModels mapping and
 * testConnection error handling. SDK is mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

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

const { OpenAiCompatibleProvider } = await import('@/lib/orchestration/llm/openai-compatible');

beforeEach(() => {
  chatCreateMock.mockReset();
  embeddingsCreateMock.mockReset();
  modelsListMock.mockReset();
});

function makeProvider(overrides: Record<string, unknown> = {}) {
  return new OpenAiCompatibleProvider({
    name: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'test-key',
    isLocal: false,
    ...overrides,
  });
}

describe('chat', () => {
  it('returns mapped response with usage and finishReason', async () => {
    chatCreateMock.mockResolvedValue({
      id: 'r1',
      model: 'gpt-4o',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'hello', tool_calls: null },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 2 },
    });

    const provider = makeProvider();
    const response = await provider.chat([{ role: 'user', content: 'hi' }], { model: 'gpt-4o' });
    expect(response.content).toBe('hello');
    expect(response.usage).toEqual({ inputTokens: 10, outputTokens: 2 });
    expect(response.finishReason).toBe('stop');
  });

  it('extracts tool_calls and maps finishReason to tool_use', async () => {
    chatCreateMock.mockResolvedValue({
      id: 'r2',
      model: 'gpt-4o',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'tc1',
                type: 'function',
                function: { name: 'search', arguments: '{"query":"x"}' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });

    const provider = makeProvider();
    const response = await provider.chat([{ role: 'user', content: 'go' }], { model: 'gpt-4o' });
    expect(response.finishReason).toBe('tool_use');
    expect(response.toolCalls).toEqual([{ id: 'tc1', name: 'search', arguments: { query: 'x' } }]);
  });
});

describe('listModels', () => {
  it('returns synthetic entries for unknown ids', async () => {
    modelsListMock.mockResolvedValue({
      data: [{ id: 'custom-model-1' }, { id: 'another-one' }],
    });
    const provider = makeProvider({ isLocal: true });
    const models = await provider.listModels();
    expect(models).toHaveLength(2);
    expect(models[0]?.available).toBe(true);
    expect(models[0]?.tier).toBe('local');
  });

  it('merges with registry metadata for known ids', async () => {
    modelsListMock.mockResolvedValue({ data: [{ id: 'gpt-4o' }] });
    const provider = makeProvider();
    const models = await provider.listModels();
    expect(models[0]?.id).toBe('gpt-4o');
    expect(models[0]?.available).toBe(true);
    expect(models[0]?.inputCostPerMillion).toBeGreaterThan(0);
  });
});

describe('testConnection', () => {
  it('returns ok: false with error on failure', async () => {
    modelsListMock.mockRejectedValue(new Error('connection refused'));
    const provider = makeProvider();
    const result = await provider.testConnection();
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/connection refused/);
    expect(result.models).toEqual([]);
  });

  it('returns ok: true with model ids on success', async () => {
    modelsListMock.mockResolvedValue({ data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }] });
    const provider = makeProvider();
    const result = await provider.testConnection();
    expect(result.ok).toBe(true);
    expect(result.models).toContain('gpt-4o');
  });
});

describe('embed', () => {
  it('returns the first vector from the SDK response', async () => {
    embeddingsCreateMock.mockResolvedValue({ data: [{ embedding: [0.1, 0.2, 0.3] }] });
    const provider = makeProvider();
    const vec = await provider.embed('hello');
    expect(vec).toEqual([0.1, 0.2, 0.3]);
  });
});
