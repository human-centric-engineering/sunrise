/**
 * Embedder Unit Tests
 *
 * Tests for text embedding service: provider resolution, API calls,
 * batching, rate limiting, and response ordering.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { prisma } from '@/lib/db/client';

// --- Mocks ---

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiProviderConfig: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
    },
    aiOrchestrationSettings: {
      findFirst: vi.fn().mockResolvedValue(null),
    },
    aiProviderModel: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
  },
}));

vi.mock('@/lib/logging', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

// Stub the settings-resolver so the test fixture-defined embedding model
// (text-embedding-3-small) wins over whatever the live registry would
// compute. Real callers still get the operator-configured value via
// AiOrchestrationSettings.defaultModels.embeddings.
vi.mock('@/lib/orchestration/llm/settings-resolver', () => ({
  getDefaultModelForTask: vi.fn(async (task: string) =>
    task === 'embeddings' ? 'text-embedding-3-small' : 'fixture-chat-model'
  ),
}));

// Mock global fetch before importing the SUT so the module picks it up
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Import SUT after mocks are in place
const { embedText, embedBatch } = await import('@/lib/orchestration/knowledge/embedder');

// Helper: build a minimal fetch response
function makeFetchResponse(
  data: Array<{ embedding: number[]; index: number }>,
  ok = true,
  status = 200
) {
  return {
    ok,
    status,
    json: vi.fn().mockResolvedValue({ data }),
    text: vi.fn().mockResolvedValue(JSON.stringify({ error: 'bad request' })),
  };
}

// A simple 1536-dim zero vector
const zeroVec = new Array(1536).fill(0);

// A minimal AiProviderConfig stub
function makeProvider(overrides: Record<string, unknown> = {}) {
  return {
    id: 'prov-1',
    name: 'Test Provider',
    providerType: 'openai-compatible',
    baseUrl: 'https://local.test/v1',
    apiKeyEnvVar: null,
    isLocal: false,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    createdById: null,
    defaultModel: null,
    maxTokens: null,
    temperature: null,
    metadata: null,
    ...overrides,
  };
}

describe('resolveProvider (via embedText)', () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    vi.resetAllMocks();
    // Default: no operator-picked active embedding model. Tests that
    // exercise the active-model path override this explicitly.
    vi.mocked(prisma.aiOrchestrationSettings.findFirst).mockResolvedValue(null);
    savedEnv = process.env;
    process.env = { ...savedEnv };
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  it('should prefer a local provider when one is present alongside openai-compatible', async () => {
    const localProvider = makeProvider({
      id: 'local-1',
      isLocal: true,
      providerType: 'openai-compatible',
      baseUrl: 'http://ollama.local/v1',
      apiKeyEnvVar: null,
    });
    const remoteProvider = makeProvider({
      id: 'remote-1',
      isLocal: false,
      providerType: 'openai-compatible',
      baseUrl: 'https://remote.test/v1',
      apiKeyEnvVar: 'REMOTE_KEY',
    });

    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([
      localProvider,
      remoteProvider,
    ] as never);

    process.env['REMOTE_KEY'] = 'sk-remote';

    mockFetch.mockResolvedValue(makeFetchResponse([{ embedding: zeroVec, index: 0 }]));

    await embedText('hello');

    // Should call local baseUrl, not remote
    const [calledUrl, calledOptions] = mockFetch.mock.calls[0] as [
      string,
      { body: string; headers: Record<string, string> },
    ];

    expect(calledUrl).toBe('http://ollama.local/v1/embeddings');

    const body = JSON.parse(calledOptions.body) as { model: string };
    // Local model should be nomic-embed-text
    expect(body.model).toBe('nomic-embed-text');
    // No auth header when apiKeyEnvVar is null
    expect(calledOptions.headers['Authorization']).toBeUndefined();
  });

  it('should fall back to first openai-compatible provider when no local provider', async () => {
    const remoteProvider = makeProvider({
      id: 'remote-1',
      isLocal: false,
      providerType: 'openai-compatible',
      baseUrl: 'https://remote.test/v1',
      apiKeyEnvVar: 'REMOTE_API_KEY',
    });

    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([remoteProvider] as never);

    process.env['REMOTE_API_KEY'] = 'sk-remote-abc';

    mockFetch.mockResolvedValue(makeFetchResponse([{ embedding: zeroVec, index: 0 }]));

    await embedText('hello');

    const [calledUrl, calledOptions] = mockFetch.mock.calls[0] as [
      string,
      { body: string; headers: Record<string, string> },
    ];

    expect(calledUrl).toBe('https://remote.test/v1/embeddings');
    expect(calledOptions.headers['Authorization']).toBe('Bearer sk-remote-abc');

    const body = JSON.parse(calledOptions.body) as { model: string };
    expect(body.model).toBe('text-embedding-3-small');
  });

  it('should use voyage provider with null apiKey when apiKeyEnvVar is not set', async () => {
    const voyageProvider = makeProvider({
      id: 'voyage-1',
      providerType: 'voyage',
      baseUrl: 'https://api.voyageai.com/v1',
      apiKeyEnvVar: null,
      isLocal: false,
    });

    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([voyageProvider] as never);

    mockFetch.mockResolvedValue(makeFetchResponse([{ embedding: zeroVec, index: 0 }]));

    await embedText('hello');

    const [calledUrl, calledOptions] = mockFetch.mock.calls[0] as [
      string,
      { body: string; headers: Record<string, string> },
    ];

    expect(calledUrl).toBe('https://api.voyageai.com/v1/embeddings');
    // No Authorization header when apiKeyEnvVar is null
    expect(calledOptions.headers['Authorization']).toBeUndefined();
    // Voyage-specific body params present
    const body = JSON.parse(calledOptions.body) as { model: string; input_type: string };
    expect(body.model).toBe('voyage-3');
    expect(body.input_type).toBe('document');
  });

  it('should read apiKey from env when voyage provider has apiKeyEnvVar set', async () => {
    const voyageProvider = makeProvider({
      id: 'voyage-2',
      providerType: 'voyage',
      baseUrl: 'https://api.voyageai.com/v1',
      apiKeyEnvVar: 'VOYAGE_API_KEY',
      isLocal: false,
    });

    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([voyageProvider] as never);

    process.env['VOYAGE_API_KEY'] = 'voyage-key-123';

    mockFetch.mockResolvedValue(makeFetchResponse([{ embedding: zeroVec, index: 0 }]));

    await embedText('hello');

    const [calledUrl, calledOptions] = mockFetch.mock.calls[0] as [
      string,
      { headers: Record<string, string> },
    ];

    expect(calledUrl).toBe('https://api.voyageai.com/v1/embeddings');
    expect(calledOptions.headers['Authorization']).toBe('Bearer voyage-key-123');
  });

  it('should read apiKey from env when local provider has apiKeyEnvVar set', async () => {
    const localProvider = makeProvider({
      id: 'local-2',
      isLocal: true,
      providerType: 'openai-compatible',
      baseUrl: 'http://ollama.local/v1',
      apiKeyEnvVar: 'LOCAL_KEY',
    });

    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([localProvider] as never);

    process.env['LOCAL_KEY'] = 'local-secret-456';

    mockFetch.mockResolvedValue(makeFetchResponse([{ embedding: zeroVec, index: 0 }]));

    await embedText('hello');

    const [calledUrl, calledOptions] = mockFetch.mock.calls[0] as [
      string,
      { headers: Record<string, string> },
    ];

    expect(calledUrl).toBe('http://ollama.local/v1/embeddings');
    expect(calledOptions.headers['Authorization']).toBe('Bearer local-secret-456');
  });

  it('should read apiKey from env when openai-compatible provider has apiKeyEnvVar set', async () => {
    const openaiCompatProvider = makeProvider({
      id: 'oai-compat-2',
      providerType: 'openai-compatible',
      baseUrl: 'https://proxy.example.com/v1',
      apiKeyEnvVar: 'CUSTOM_OAI_KEY',
      isLocal: false,
    });

    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([openaiCompatProvider] as never);

    process.env['CUSTOM_OAI_KEY'] = 'custom-oai-789';

    mockFetch.mockResolvedValue(makeFetchResponse([{ embedding: zeroVec, index: 0 }]));

    await embedText('hello');

    const [calledUrl, calledOptions] = mockFetch.mock.calls[0] as [
      string,
      { headers: Record<string, string> },
    ];

    expect(calledUrl).toBe('https://proxy.example.com/v1/embeddings');
    expect(calledOptions.headers['Authorization']).toBe('Bearer custom-oai-789');
  });

  it('should use openai-compatible provider with null apiKey when apiKeyEnvVar is not set', async () => {
    const openaiCompatProvider = makeProvider({
      id: 'oai-compat-1',
      providerType: 'openai-compatible',
      baseUrl: 'https://proxy.example.com/v1',
      apiKeyEnvVar: null,
      isLocal: false,
    });

    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([openaiCompatProvider] as never);

    mockFetch.mockResolvedValue(makeFetchResponse([{ embedding: zeroVec, index: 0 }]));

    await embedText('hello');

    const [calledUrl, calledOptions] = mockFetch.mock.calls[0] as [
      string,
      { headers: Record<string, string> },
    ];

    expect(calledUrl).toBe('https://proxy.example.com/v1/embeddings');
    expect(calledOptions.headers['Authorization']).toBeUndefined();
  });

  it('should fall back to OpenAI direct when no providers are configured', async () => {
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([] as never);

    process.env['OPENAI_API_KEY'] = 'sk-openai-direct';

    mockFetch.mockResolvedValue(makeFetchResponse([{ embedding: zeroVec, index: 0 }]));

    await embedText('hello');

    const [calledUrl, calledOptions] = mockFetch.mock.calls[0] as [
      string,
      { body: string; headers: Record<string, string> },
    ];

    expect(calledUrl).toBe('https://api.openai.com/v1/embeddings');
    expect(calledOptions.headers['Authorization']).toBe('Bearer sk-openai-direct');

    const body = JSON.parse(calledOptions.body) as { model: string };
    expect(body.model).toBe('text-embedding-3-small');
  });

  it('throws "No embedding provider configured" when no providers exist and OPENAI_API_KEY is unset', async () => {
    // Source resolveProvider() throws explicitly when both branches
    // fail — no DB row AND no env fallback. Without this test the
    // throw message could be silently changed (e.g. typed
    // ProviderError with a different string) and the suite would
    // stay green because the OpenAI-direct test always sets the env.
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([] as never);
    delete process.env['OPENAI_API_KEY'];

    await expect(embedText('hello')).rejects.toThrow(/No embedding provider configured/i);
  });
});

describe('embedText', () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    vi.resetAllMocks();
    // Default: no operator-picked active embedding model. Tests that
    // exercise the active-model path override this explicitly.
    vi.mocked(prisma.aiOrchestrationSettings.findFirst).mockResolvedValue(null);
    savedEnv = process.env;
    process.env = { ...savedEnv };
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  it('should call POST {baseUrl}/embeddings with trailing slash trimmed', async () => {
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([
      makeProvider({ baseUrl: 'https://api.example.com/v1/' }),
    ] as never);

    mockFetch.mockResolvedValue(makeFetchResponse([{ embedding: zeroVec, index: 0 }]));

    await embedText('test input');

    const [calledUrl, calledOptions] = mockFetch.mock.calls[0] as [string, { method: string }];

    expect(calledUrl).toBe('https://api.example.com/v1/embeddings');
    expect(calledOptions.method).toBe('POST');
  });

  it('should include Authorization header when apiKey is present', async () => {
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([
      makeProvider({ apiKeyEnvVar: 'MY_KEY' }),
    ] as never);

    process.env['MY_KEY'] = 'sk-my-key';

    mockFetch.mockResolvedValue(makeFetchResponse([{ embedding: zeroVec, index: 0 }]));

    await embedText('test');

    const [, calledOptions] = mockFetch.mock.calls[0] as [
      string,
      { headers: Record<string, string> },
    ];

    expect(calledOptions.headers['Authorization']).toBe('Bearer sk-my-key');
  });

  it('should omit Authorization header when apiKey is null', async () => {
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([
      makeProvider({ apiKeyEnvVar: null }),
    ] as never);

    mockFetch.mockResolvedValue(makeFetchResponse([{ embedding: zeroVec, index: 0 }]));

    await embedText('test');

    const [, calledOptions] = mockFetch.mock.calls[0] as [
      string,
      { headers: Record<string, string> },
    ];

    expect(calledOptions.headers['Authorization']).toBeUndefined();
  });

  it('should include model and input in request body', async () => {
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([
      makeProvider({ isLocal: false }),
    ] as never);

    mockFetch.mockResolvedValue(makeFetchResponse([{ embedding: zeroVec, index: 0 }]));

    await embedText('my test text');

    const [, calledOptions] = mockFetch.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(calledOptions.body) as { model: string; input: string };

    expect(body.model).toBe('text-embedding-3-small');
    expect(body.input).toBe('my test text');
  });

  it('should include dimensions for non-local text-embedding-3-small', async () => {
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([
      makeProvider({ isLocal: false }),
    ] as never);

    mockFetch.mockResolvedValue(makeFetchResponse([{ embedding: zeroVec, index: 0 }]));

    await embedText('test');

    const [, calledOptions] = mockFetch.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(calledOptions.body) as { dimensions?: number };

    expect(body.dimensions).toBe(1536);
  });

  it('should omit dimensions for local providers', async () => {
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([
      makeProvider({ isLocal: true }),
    ] as never);

    mockFetch.mockResolvedValue(makeFetchResponse([{ embedding: zeroVec, index: 0 }]));

    await embedText('test');

    const [, calledOptions] = mockFetch.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(calledOptions.body) as { dimensions?: number };

    expect(body.dimensions).toBeUndefined();
  });

  it('should reject with error containing HTTP status and body when response is not ok', async () => {
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([makeProvider()] as never);

    const errorResponse = {
      ok: false,
      status: 429,
      text: vi.fn().mockResolvedValue('Rate limit exceeded'),
      json: vi.fn(),
    };
    mockFetch.mockResolvedValue(errorResponse);

    await expect(embedText('test')).rejects.toThrow(
      'Embedding API error (429): Rate limit exceeded'
    );
  });

  it('should use raw response text when error body is not valid JSON', async () => {
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([makeProvider()] as never);

    mockFetch.mockResolvedValue(new Response('upstream crashed', { status: 502 }));

    await expect(embedText('test')).rejects.toThrow('Embedding API error (502): upstream crashed');
  });

  it('should re-sort response data by index to maintain input order', async () => {
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([makeProvider()] as never);

    const vecA = [1, 2, 3];
    const vecB = [4, 5, 6];

    // Return index 1 before index 0 — shuffled
    mockFetch.mockResolvedValue(
      makeFetchResponse([
        { embedding: vecB, index: 1 },
        { embedding: vecA, index: 0 },
      ])
    );

    // embedText returns { embedding, … } where embedding is results[0]
    // — the first after sorting by index.
    const result = await embedText('test');

    expect(result.embedding).toEqual(vecA);
  });
});

describe('embedBatch', () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    vi.resetAllMocks();
    // Default: no operator-picked active embedding model. Tests that
    // exercise the active-model path override this explicitly.
    vi.mocked(prisma.aiOrchestrationSettings.findFirst).mockResolvedValue(null);
    savedEnv = process.env;
    process.env = { ...savedEnv };
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  it('should return an empty array and make no fetch calls for empty input', async () => {
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([makeProvider()] as never);

    const result = await embedBatch([]);

    expect(result.embeddings).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('should split 250 texts into 3 batches of 100/100/50 with default batch size', async () => {
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([makeProvider()] as never);

    // Each fetch call returns embeddings for a full batch
    mockFetch.mockImplementation((_url: string, options: { body: string }) => {
      const body = JSON.parse(options.body) as { input: string[] };
      const batchSize = body.input.length;
      const data = Array.from({ length: batchSize }, (_, i) => ({
        embedding: new Array(1536).fill(i),
        index: i,
      }));
      return Promise.resolve(makeFetchResponse(data));
    });

    const texts = Array.from({ length: 250 }, (_, i) => `text-${i}`);
    const result = await embedBatch(texts);

    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(result.embeddings).toHaveLength(250);

    // Verify batch sizes from the call bodies
    const calls = mockFetch.mock.calls as Array<[string, { body: string }]>;
    const batchSizes = calls.map(
      (c) => (JSON.parse(c[1].body) as { input: string[] }).input.length
    );
    expect(batchSizes).toEqual([100, 100, 50]);
  });

  it('should pause 200ms between batches but not after the last batch', async () => {
    vi.useFakeTimers();

    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([makeProvider()] as never);

    mockFetch.mockResolvedValue(makeFetchResponse([{ embedding: zeroVec, index: 0 }]));

    const texts = Array.from({ length: 3 }, (_, i) => `t${i}`);

    // embedBatch with batchSize=1 gives 3 batches → 2 delays
    const promise = embedBatch(texts, 1);

    // Advance past first inter-batch delay
    await vi.advanceTimersByTimeAsync(200);
    // Advance past second inter-batch delay
    await vi.advanceTimersByTimeAsync(200);

    const result = await promise;

    expect(result.embeddings).toHaveLength(3);
    // fetch called 3 times
    expect(mockFetch).toHaveBeenCalledTimes(3);

    vi.useRealTimers();
  });

  it('should preserve input order when fetch returns shuffled index values', async () => {
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([makeProvider()] as never);

    const vec0 = [10, 20];
    const vec1 = [30, 40];
    const vec2 = [50, 60];

    // Single batch of 3, returned in reverse index order
    mockFetch.mockResolvedValue(
      makeFetchResponse([
        { embedding: vec2, index: 2 },
        { embedding: vec0, index: 0 },
        { embedding: vec1, index: 1 },
      ])
    );

    const result = await embedBatch(['a', 'b', 'c'], 10);

    expect(result.embeddings[0]).toEqual(vec0);
    expect(result.embeddings[1]).toEqual(vec1);
    expect(result.embeddings[2]).toEqual(vec2);
    expect(result.provenance.model).toBe('text-embedding-3-small');
    expect(result.provenance.provider).toBe('openai-compatible');
    expect(result.provenance.embeddedAt).toBeInstanceOf(Date);
  });

  it('should reject when a mid-batch fetch call fails', async () => {
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([makeProvider()] as never);

    // First batch succeeds, second rejects
    mockFetch
      .mockResolvedValueOnce(makeFetchResponse([{ embedding: zeroVec, index: 0 }]))
      .mockRejectedValueOnce(new Error('Network error on batch 2'));

    const texts = Array.from({ length: 2 }, (_, i) => `text-${i}`);

    await expect(embedBatch(texts, 1)).rejects.toThrow('Network error on batch 2');
  });
});
