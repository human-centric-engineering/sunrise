/**
 * VoyageProvider Unit Tests
 *
 * Tests for the Voyage AI provider: construction, embed() behaviour,
 * delegation of chat/stream/listModels/testConnection to the inner
 * OpenAiCompatibleProvider, and error handling.
 *
 * Test Coverage:
 * - Constructor: throws ProviderError when apiKey is missing
 * - embed(): correct URL, headers, body params (model, input, input_type, output_dimension)
 * - embed(): respects options.inputType; defaults to 'document'
 * - embed(): parses and returns the embedding vector from response
 * - embed(): throws ProviderError on HTTP error with parsed Voyage detail message
 * - embed(): throws ProviderError on empty response data array
 * - chat(), chatStream(), listModels(), testConnection(): delegate to inner provider
 *
 * @see lib/orchestration/llm/voyage.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock dependencies before importing SUT
// Use vi.hoisted() for variables referenced inside vi.mock() factories,
// because vi.mock() is hoisted to the top of the file by the Vitest
// transform pass — any top-level `const` declarations are NOT yet
// initialised at that point.
// ---------------------------------------------------------------------------

const {
  mockInnerChat,
  mockInnerChatStream,
  mockInnerListModels,
  mockInnerTestConnection,
  mockFetchWithTimeout,
} = vi.hoisted(() => ({
  mockInnerChat: vi.fn(),
  mockInnerChatStream: vi.fn(),
  mockInnerListModels: vi.fn(),
  mockInnerTestConnection: vi.fn(),
  mockFetchWithTimeout: vi.fn(),
}));

vi.mock('@/lib/logging', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Mock the inner OpenAiCompatibleProvider so we can verify delegation
// without hitting any real HTTP endpoints or SDK validation.
// Must use a class (not a plain factory) because VoyageProvider calls
// `new OpenAiCompatibleProvider(...)` — a plain vi.fn() mock is not
// a valid constructor target.
vi.mock('@/lib/orchestration/llm/openai-compatible', () => {
  class MockOpenAiCompatibleProvider {
    public readonly name: string;
    public readonly isLocal: boolean = false;
    public chat = mockInnerChat;
    public chatStream = mockInnerChatStream;
    public listModels = mockInnerListModels;
    public testConnection = mockInnerTestConnection;
    constructor(config: { name: string }) {
      this.name = config.name;
    }
  }
  return { OpenAiCompatibleProvider: MockOpenAiCompatibleProvider };
});

// Mock fetchWithTimeout AND withRetry from the provider module.
// withRetry is mocked to call the function once (no retries) so tests that
// exercise retriable errors don't trigger real backoff delays — we only care
// about the ProviderError properties, not the retry count.
vi.mock('@/lib/orchestration/llm/provider', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/orchestration/llm/provider')>();
  return {
    ...original,
    fetchWithTimeout: mockFetchWithTimeout,
    // Stub withRetry to execute `fn` exactly once (no backoff loop)
    withRetry: async <T>(fn: () => Promise<T>) => fn(),
  };
});

// ---------------------------------------------------------------------------
// Import SUT after mocks
// ---------------------------------------------------------------------------

import { VoyageProvider } from '@/lib/orchestration/llm/voyage';
import { ProviderError } from '@/lib/orchestration/llm/provider';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_CONFIG = {
  name: 'voyage-test',
  type: 'voyage' as const,
  apiKey: 'test-voyage-api-key',
  isLocal: false,
};

/** Create a minimal mock Response that fetchWithTimeout resolves to. */
function makeMockResponse(opts: {
  ok: boolean;
  status?: number;
  body?: unknown;
  text?: string;
}): Response {
  const { ok, status = ok ? 200 : 400, body, text } = opts;
  return {
    ok,
    status,
    json: vi.fn().mockResolvedValue(body ?? {}),
    text: vi.fn().mockResolvedValue(text ?? JSON.stringify(body ?? {})),
  } as unknown as Response;
}

/** A valid Voyage embedding response with a single 3-dim vector for simplicity. */
function makeEmbeddingResponse(embedding: number[] = [0.1, 0.2, 0.3]) {
  return makeMockResponse({
    ok: true,
    status: 200,
    body: { data: [{ embedding, index: 0 }] },
  });
}

// ---------------------------------------------------------------------------
// Constructor
// ---------------------------------------------------------------------------

describe('VoyageProvider constructor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should construct successfully when apiKey is provided', () => {
    // Act + Assert: no throw
    expect(() => new VoyageProvider(VALID_CONFIG)).not.toThrow();
  });

  it('should throw ProviderError with code missing_api_key when apiKey is absent', () => {
    // Arrange: config without apiKey
    const config = { name: 'voyage-no-key', type: 'voyage' as const, isLocal: false };

    // Act + Assert
    expect(() => new VoyageProvider(config)).toThrow(ProviderError);
    expect(() => new VoyageProvider(config)).toThrow('VoyageProvider requires an apiKey');
  });

  it('should set the ProviderError code to missing_api_key', () => {
    // Arrange
    const config = { name: 'voyage-no-key', type: 'voyage' as const, isLocal: false };

    // Act
    let caught: unknown;
    try {
      new VoyageProvider(config);
    } catch (err) {
      caught = err;
    }

    // Assert
    expect(caught).toBeInstanceOf(ProviderError);
    expect((caught as ProviderError).code).toBe('missing_api_key');
    expect((caught as ProviderError).retriable).toBe(false);
  });

  it('should set provider name from config.name', () => {
    // Act
    const provider = new VoyageProvider(VALID_CONFIG);

    // Assert
    expect(provider.name).toBe(VALID_CONFIG.name);
  });

  it('should set isLocal to false regardless of config', () => {
    // Act
    const provider = new VoyageProvider(VALID_CONFIG);

    // Assert: Voyage is always a cloud provider
    expect(provider.isLocal).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// embed()
// ---------------------------------------------------------------------------

describe('VoyageProvider.embed()', () => {
  let provider: VoyageProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new VoyageProvider(VALID_CONFIG);
  });

  it('should call fetchWithTimeout with the Voyage embeddings URL', async () => {
    // Arrange
    mockFetchWithTimeout.mockResolvedValue(makeEmbeddingResponse());

    // Act
    await provider.embed('hello world');

    // Assert
    const [calledUrl] = mockFetchWithTimeout.mock.calls[0] as [string, ...unknown[]];
    expect(calledUrl).toBe('https://api.voyageai.com/v1/embeddings');
  });

  it('should use POST method', async () => {
    // Arrange
    mockFetchWithTimeout.mockResolvedValue(makeEmbeddingResponse());

    // Act
    await provider.embed('hello');

    // Assert
    const [, init] = mockFetchWithTimeout.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('POST');
  });

  it('should set Content-Type: application/json header', async () => {
    // Arrange
    mockFetchWithTimeout.mockResolvedValue(makeEmbeddingResponse());

    // Act
    await provider.embed('hello');

    // Assert
    const [, init] = mockFetchWithTimeout.mock.calls[0] as [
      string,
      { headers: Record<string, string> },
    ];
    expect(init.headers['Content-Type']).toBe('application/json');
  });

  it('should set Authorization header with Bearer token from apiKey', async () => {
    // Arrange
    mockFetchWithTimeout.mockResolvedValue(makeEmbeddingResponse());

    // Act
    await provider.embed('hello');

    // Assert
    const [, init] = mockFetchWithTimeout.mock.calls[0] as [
      string,
      { headers: Record<string, string> },
    ];
    expect(init.headers['Authorization']).toBe(`Bearer ${VALID_CONFIG.apiKey}`);
  });

  it('should include model voyage-3 in the request body', async () => {
    // Arrange
    mockFetchWithTimeout.mockResolvedValue(makeEmbeddingResponse());

    // Act
    await provider.embed('test text');

    // Assert
    const [, init] = mockFetchWithTimeout.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(init.body) as { model: string };
    expect(body.model).toBe('voyage-3');
  });

  it('should include the input text in the request body', async () => {
    // Arrange
    mockFetchWithTimeout.mockResolvedValue(makeEmbeddingResponse());
    const inputText = 'the quick brown fox';

    // Act
    await provider.embed(inputText);

    // Assert
    const [, init] = mockFetchWithTimeout.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(init.body) as { input: string };
    expect(body.input).toBe(inputText);
  });

  it('should default input_type to "document" when no options provided', async () => {
    // Arrange
    mockFetchWithTimeout.mockResolvedValue(makeEmbeddingResponse());

    // Act
    await provider.embed('text without options');

    // Assert
    const [, init] = mockFetchWithTimeout.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(init.body) as { input_type: string };
    expect(body.input_type).toBe('document');
  });

  it('should use options.inputType when provided', async () => {
    // Arrange
    mockFetchWithTimeout.mockResolvedValue(makeEmbeddingResponse());

    // Act
    await provider.embed('search query text', { inputType: 'query' });

    // Assert
    const [, init] = mockFetchWithTimeout.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(init.body) as { input_type: string };
    expect(body.input_type).toBe('query');
  });

  it('should use options.inputType "document" when explicitly passed', async () => {
    // Arrange
    mockFetchWithTimeout.mockResolvedValue(makeEmbeddingResponse());

    // Act
    await provider.embed('document text', { inputType: 'document' });

    // Assert
    const [, init] = mockFetchWithTimeout.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(init.body) as { input_type: string };
    expect(body.input_type).toBe('document');
  });

  it('should always include output_dimension: 1536 in the request body', async () => {
    // Arrange
    mockFetchWithTimeout.mockResolvedValue(makeEmbeddingResponse());

    // Act
    await provider.embed('test');

    // Assert: 1536 matches the pgvector vector(1536) column
    const [, init] = mockFetchWithTimeout.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(init.body) as { output_dimension: number };
    expect(body.output_dimension).toBe(1536);
  });

  it('should return the embedding vector from the first data element', async () => {
    // Arrange
    const expectedEmbedding = [0.5, 0.6, 0.7, 0.8];
    mockFetchWithTimeout.mockResolvedValue(makeEmbeddingResponse(expectedEmbedding));

    // Act
    const result = await provider.embed('test');

    // Assert
    expect(result).toEqual(expectedEmbedding);
  });

  it('should throw ProviderError on HTTP 401 error', async () => {
    // Arrange
    mockFetchWithTimeout.mockResolvedValue(
      makeMockResponse({
        ok: false,
        status: 401,
        text: JSON.stringify({ detail: 'Invalid API key' }),
      })
    );

    // Act + Assert
    await expect(provider.embed('test')).rejects.toThrow(ProviderError);
    await expect(provider.embed('test')).rejects.toThrow(
      'Voyage embed failed (401): Invalid API key'
    );
  });

  it('should throw ProviderError on HTTP 429 with parsed Voyage detail message', async () => {
    // Arrange: withRetry is stubbed to call fn once so no real backoff occurs
    mockFetchWithTimeout.mockResolvedValue(
      makeMockResponse({
        ok: false,
        status: 429,
        text: JSON.stringify({ detail: 'Rate limit exceeded. Please retry after 60 seconds.' }),
      })
    );

    // Act + Assert
    await expect(provider.embed('test')).rejects.toMatchObject({
      code: 'http_429',
      status: 429,
      retriable: true,
    });
  });

  it('should use raw error text when Voyage response is not valid JSON', async () => {
    // Arrange
    mockFetchWithTimeout.mockResolvedValue(
      makeMockResponse({
        ok: false,
        status: 500,
        text: 'Internal Server Error',
      })
    );

    // Act + Assert
    await expect(provider.embed('test')).rejects.toThrow(
      'Voyage embed failed (500): Internal Server Error'
    );
  });

  it('should set retriable: false for non-retriable HTTP errors (4xx except 429)', async () => {
    // Arrange: 400 Bad Request is not retriable
    mockFetchWithTimeout.mockResolvedValue(
      makeMockResponse({
        ok: false,
        status: 400,
        text: JSON.stringify({ detail: 'Bad request' }),
      })
    );

    // Act
    let caught: ProviderError | undefined;
    try {
      await provider.embed('test');
    } catch (err) {
      caught = err as ProviderError;
    }

    // Assert
    expect(caught).toBeInstanceOf(ProviderError);
    expect(caught?.retriable).toBe(false);
  });

  it('should set retriable: true for HTTP 500 errors', async () => {
    // Arrange: withRetry is stubbed to call fn once so no real backoff occurs
    mockFetchWithTimeout.mockResolvedValue(
      makeMockResponse({
        ok: false,
        status: 500,
        text: 'server error',
      })
    );

    let caught: ProviderError | undefined;
    try {
      await provider.embed('test');
    } catch (err) {
      caught = err as ProviderError;
    }

    // Assert: 500 produces a retriable ProviderError
    expect(caught).toBeInstanceOf(ProviderError);
    expect(caught?.retriable).toBe(true);
  });

  it('should throw ProviderError with code empty_response when data array is empty', async () => {
    // Arrange: valid HTTP response but no vectors
    mockFetchWithTimeout.mockResolvedValue(
      makeMockResponse({
        ok: true,
        status: 200,
        body: { data: [] },
      })
    );

    // Act + Assert
    await expect(provider.embed('test')).rejects.toMatchObject({
      code: 'empty_response',
      retriable: false,
    });
    await expect(provider.embed('test')).rejects.toThrow(
      'Voyage embedding response contained no vectors'
    );
  });
});

// ---------------------------------------------------------------------------
// Delegation to inner OpenAiCompatibleProvider
// ---------------------------------------------------------------------------

describe('VoyageProvider delegation', () => {
  let provider: VoyageProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new VoyageProvider(VALID_CONFIG);
  });

  it('chat() should delegate to the inner provider', async () => {
    // Arrange
    const mockResponse = { content: 'hello', usage: { inputTokens: 5, outputTokens: 3 } };
    mockInnerChat.mockResolvedValue(mockResponse);
    const messages = [{ role: 'user' as const, content: 'hi' }];
    const options = { model: 'voyage-3' };

    // Act
    const result = await provider.chat(messages, options);

    // Assert
    expect(mockInnerChat).toHaveBeenCalledWith(messages, options);
    expect(result).toBe(mockResponse);
  });

  it('chatStream() should delegate to the inner provider', () => {
    // Arrange
    const mockStream = (async function* () {
      yield { type: 'text' as const, content: 'hi' };
    })();
    mockInnerChatStream.mockReturnValue(mockStream);
    const messages = [{ role: 'user' as const, content: 'hello' }];
    const options = { model: 'voyage-3' };

    // Act
    const result = provider.chatStream(messages, options);

    // Assert
    expect(mockInnerChatStream).toHaveBeenCalledWith(messages, options);
    expect(result).toBe(mockStream);
  });

  it('listModels() should delegate to the inner provider', async () => {
    // Arrange
    const mockModels = [{ id: 'voyage-3', name: 'Voyage 3' }];
    mockInnerListModels.mockResolvedValue(mockModels);

    // Act
    const result = await provider.listModels();

    // Assert
    expect(mockInnerListModels).toHaveBeenCalled();
    expect(result).toBe(mockModels);
  });

  it('testConnection() should delegate to the inner provider', async () => {
    // Arrange
    const mockResult = { ok: true, models: ['voyage-3'] };
    mockInnerTestConnection.mockResolvedValue(mockResult);

    // Act
    const result = await provider.testConnection();

    // Assert
    expect(mockInnerTestConnection).toHaveBeenCalled();
    expect(result).toBe(mockResult);
  });
});
