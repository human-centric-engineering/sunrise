/**
 * Embedder — Voyage AI Integration Tests
 *
 * Focused tests for the Voyage AI-specific changes to the embedder:
 *   - resolveProvider() prefers Voyage over local and openai-compatible providers
 *   - callEmbeddingApi() adds input_type and output_dimension for Voyage providers
 *   - callEmbeddingApi() does NOT add Voyage-specific params for non-Voyage providers
 *   - embedText() and embedBatch() accept and pass the optional inputType param
 *
 * These tests augment (but do not duplicate) the main embedder.test.ts suite.
 *
 * @see lib/orchestration/knowledge/embedder.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { prisma } from '@/lib/db/client';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

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

// Mock global fetch before SUT import
const mockFetch = vi.fn();
global.fetch = mockFetch;

// ---------------------------------------------------------------------------
// Import SUT after mocks
// ---------------------------------------------------------------------------

const { embedText, embedBatch } = await import('@/lib/orchestration/knowledge/embedder');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A simple 1536-dim zero vector */
const zeroVec = new Array(1536).fill(0);

/** Build a minimal valid fetch response */
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

/** A minimal AiProviderConfig stub */
function makeProvider(overrides: Record<string, unknown> = {}) {
  return {
    id: 'prov-1',
    name: 'Test Provider',
    providerType: 'openai-compatible',
    baseUrl: 'https://api.example.com/v1',
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

/** A Voyage AI provider stub */
function makeVoyageProvider(overrides: Record<string, unknown> = {}) {
  return makeProvider({
    id: 'voyage-1',
    name: 'Voyage AI',
    providerType: 'voyage',
    baseUrl: 'https://api.voyageai.com/v1',
    apiKeyEnvVar: 'VOYAGE_API_KEY',
    isLocal: false,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// resolveProvider() — Voyage preference
// ---------------------------------------------------------------------------

describe('resolveProvider() Voyage preference (via embedText)', () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(prisma.aiOrchestrationSettings.findFirst).mockResolvedValue(null);
    savedEnv = process.env;
    process.env = { ...savedEnv };
    process.env['VOYAGE_API_KEY'] = 'voy-test-key';
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  it('should prefer Voyage provider over a local provider', async () => {
    // Arrange: Voyage + local both active
    const voyageProvider = makeVoyageProvider();
    const localProvider = makeProvider({
      id: 'local-1',
      providerType: 'openai-compatible',
      baseUrl: 'http://ollama.local/v1',
      isLocal: true,
      apiKeyEnvVar: null,
    });

    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([
      voyageProvider,
      localProvider,
    ] as never);

    mockFetch.mockResolvedValue(makeFetchResponse([{ embedding: zeroVec, index: 0 }]));

    // Act
    await embedText('hello');

    // Assert: Voyage URL used, not local
    const [calledUrl] = mockFetch.mock.calls[0] as [string, ...unknown[]];
    expect(calledUrl).toBe('https://api.voyageai.com/v1/embeddings');
  });

  it('should prefer Voyage provider over an openai-compatible cloud provider', async () => {
    // Arrange
    const voyageProvider = makeVoyageProvider();
    const openaiProvider = makeProvider({
      id: 'openai-1',
      providerType: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      apiKeyEnvVar: 'OPENAI_API_KEY',
      isLocal: false,
    });

    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([
      openaiProvider,
      voyageProvider,
    ] as never);

    process.env['OPENAI_API_KEY'] = 'sk-openai';
    mockFetch.mockResolvedValue(makeFetchResponse([{ embedding: zeroVec, index: 0 }]));

    // Act
    await embedText('hello');

    // Assert: Voyage URL wins
    const [calledUrl] = mockFetch.mock.calls[0] as [string, ...unknown[]];
    expect(calledUrl).toBe('https://api.voyageai.com/v1/embeddings');
  });

  it('should use voyage-3 model when Voyage provider is selected', async () => {
    // Arrange
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([makeVoyageProvider()] as never);

    mockFetch.mockResolvedValue(makeFetchResponse([{ embedding: zeroVec, index: 0 }]));

    // Act
    await embedText('test');

    // Assert
    const [, init] = mockFetch.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(init.body) as { model: string };
    expect(body.model).toBe('voyage-3');
  });

  it('should use the baseUrl from the Voyage provider config when available', async () => {
    // Arrange: custom base URL
    const voyageProvider = makeVoyageProvider({
      baseUrl: 'https://custom.voyageai.com/v1',
    });

    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([voyageProvider] as never);

    mockFetch.mockResolvedValue(makeFetchResponse([{ embedding: zeroVec, index: 0 }]));

    // Act
    await embedText('hello');

    // Assert
    const [calledUrl] = mockFetch.mock.calls[0] as [string, ...unknown[]];
    expect(calledUrl).toBe('https://custom.voyageai.com/v1/embeddings');
  });

  it('should fall back to the default Voyage base URL when baseUrl is null', async () => {
    // Arrange: Voyage provider without an explicit baseUrl
    const voyageProvider = makeVoyageProvider({ baseUrl: null });

    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([voyageProvider] as never);

    mockFetch.mockResolvedValue(makeFetchResponse([{ embedding: zeroVec, index: 0 }]));

    // Act
    await embedText('hello');

    // Assert: falls back to default Voyage URL
    const [calledUrl] = mockFetch.mock.calls[0] as [string, ...unknown[]];
    expect(calledUrl).toBe('https://api.voyageai.com/v1/embeddings');
  });

  it('should resolve the API key from the Voyage apiKeyEnvVar env variable', async () => {
    // Arrange
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([
      makeVoyageProvider({ apiKeyEnvVar: 'VOYAGE_API_KEY' }),
    ] as never);

    process.env['VOYAGE_API_KEY'] = 'voy-secret-key';
    mockFetch.mockResolvedValue(makeFetchResponse([{ embedding: zeroVec, index: 0 }]));

    // Act
    await embedText('test');

    // Assert: auth header uses the resolved key
    const [, init] = mockFetch.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(init.headers['Authorization']).toBe('Bearer voy-secret-key');
  });
});

// ---------------------------------------------------------------------------
// callEmbeddingApi() — Voyage-specific body params
// ---------------------------------------------------------------------------

describe('callEmbeddingApi() Voyage-specific parameters (via embedText)', () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(prisma.aiOrchestrationSettings.findFirst).mockResolvedValue(null);
    savedEnv = process.env;
    process.env = { ...savedEnv };
    process.env['VOYAGE_API_KEY'] = 'voy-key';
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  it('should include input_type in the request body for Voyage providers', async () => {
    // Arrange
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([makeVoyageProvider()] as never);

    mockFetch.mockResolvedValue(makeFetchResponse([{ embedding: zeroVec, index: 0 }]));

    // Act
    await embedText('test');

    // Assert
    const [, init] = mockFetch.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(init.body) as Record<string, unknown>;
    expect(body).toHaveProperty('input_type');
  });

  it('should default input_type to "document" for Voyage when inputType is not supplied', async () => {
    // Arrange
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([makeVoyageProvider()] as never);

    mockFetch.mockResolvedValue(makeFetchResponse([{ embedding: zeroVec, index: 0 }]));

    // Act: no inputType argument
    await embedText('document content');

    // Assert
    const [, init] = mockFetch.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(init.body) as { input_type: string };
    expect(body.input_type).toBe('document');
  });

  it('should pass inputType "query" to Voyage when specified', async () => {
    // Arrange
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([makeVoyageProvider()] as never);

    mockFetch.mockResolvedValue(makeFetchResponse([{ embedding: zeroVec, index: 0 }]));

    // Act
    await embedText('search query', 'query');

    // Assert
    const [, init] = mockFetch.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(init.body) as { input_type: string };
    expect(body.input_type).toBe('query');
  });

  it('should include output_dimension: 1536 in the request body for Voyage providers', async () => {
    // Arrange
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([makeVoyageProvider()] as never);

    mockFetch.mockResolvedValue(makeFetchResponse([{ embedding: zeroVec, index: 0 }]));

    // Act
    await embedText('test');

    // Assert: must match the pgvector column width
    const [, init] = mockFetch.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(init.body) as { output_dimension: number };
    expect(body.output_dimension).toBe(1536);
  });

  it('should NOT include input_type for non-Voyage openai-compatible providers', async () => {
    // Arrange: standard OpenAI-compatible provider, not Voyage
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([
      makeProvider({
        providerType: 'openai-compatible',
        baseUrl: 'https://api.openai.com/v1',
        isLocal: false,
      }),
    ] as never);

    mockFetch.mockResolvedValue(makeFetchResponse([{ embedding: zeroVec, index: 0 }]));

    // Act
    await embedText('test');

    // Assert: no Voyage-specific fields
    const [, init] = mockFetch.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(init.body) as Record<string, unknown>;
    expect(body).not.toHaveProperty('input_type');
    expect(body).not.toHaveProperty('output_dimension');
  });

  it('should NOT include output_dimension for local Ollama providers', async () => {
    // Arrange
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([
      makeProvider({
        providerType: 'openai-compatible',
        baseUrl: 'http://localhost:11434/v1',
        isLocal: true,
        apiKeyEnvVar: null,
      }),
    ] as never);

    mockFetch.mockResolvedValue(makeFetchResponse([{ embedding: zeroVec, index: 0 }]));

    // Act
    await embedText('test');

    // Assert
    const [, init] = mockFetch.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(init.body) as Record<string, unknown>;
    expect(body).not.toHaveProperty('input_type');
    expect(body).not.toHaveProperty('output_dimension');
  });
});

// ---------------------------------------------------------------------------
// embedText() with inputType parameter
// ---------------------------------------------------------------------------

describe('embedText() inputType parameter', () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(prisma.aiOrchestrationSettings.findFirst).mockResolvedValue(null);
    savedEnv = process.env;
    process.env = { ...savedEnv };
    process.env['VOYAGE_API_KEY'] = 'voy-key';
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  it('should accept an optional inputType parameter and pass it to the API for Voyage', async () => {
    // Arrange
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([makeVoyageProvider()] as never);

    mockFetch.mockResolvedValue(makeFetchResponse([{ embedding: zeroVec, index: 0 }]));

    // Act: call embedText with explicit inputType
    await embedText('a document to index', 'document');

    // Assert
    const [, init] = mockFetch.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(init.body) as { input_type: string };
    expect(body.input_type).toBe('document');
  });

  it('should return a single embedding vector when called with inputType', async () => {
    // Arrange
    const expectedVector = [0.1, 0.2, 0.3];
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([makeVoyageProvider()] as never);

    mockFetch.mockResolvedValue(makeFetchResponse([{ embedding: expectedVector, index: 0 }]));

    // Act
    const result = await embedText('test', 'query');

    // Assert — embedText returns { embedding, model, provider, ... }
    expect(result.embedding).toEqual(expectedVector);
  });
});

// ---------------------------------------------------------------------------
// embedBatch() with inputType parameter
// ---------------------------------------------------------------------------

describe('embedBatch() inputType parameter', () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(prisma.aiOrchestrationSettings.findFirst).mockResolvedValue(null);
    savedEnv = process.env;
    process.env = { ...savedEnv };
    process.env['VOYAGE_API_KEY'] = 'voy-key';
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  it('should accept an optional inputType parameter and pass it through for Voyage', async () => {
    // Arrange
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([makeVoyageProvider()] as never);

    mockFetch.mockResolvedValue(
      makeFetchResponse([
        { embedding: [0.1, 0.2], index: 0 },
        { embedding: [0.3, 0.4], index: 1 },
      ])
    );

    // Act
    await embedBatch(['text one', 'text two'], 10, 'query');

    // Assert: Voyage params present and inputType forwarded
    const [, init] = mockFetch.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(init.body) as Record<string, unknown>;
    expect(body['input_type']).toBe('query');
    expect(body['output_dimension']).toBe(1536);
  });

  it('should return embeddings for all texts in batch when inputType is provided', async () => {
    // Arrange
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([makeVoyageProvider()] as never);

    const vec1 = [1, 2, 3];
    const vec2 = [4, 5, 6];

    mockFetch.mockResolvedValue(
      makeFetchResponse([
        { embedding: vec1, index: 0 },
        { embedding: vec2, index: 1 },
      ])
    );

    // Act
    const results = await embedBatch(['first', 'second'], 10, 'document');

    // Assert
    expect(results.embeddings).toHaveLength(2);
    expect(results.embeddings[0]).toEqual(vec1);
    expect(results.embeddings[1]).toEqual(vec2);
    expect(results.provenance.provider).toBe('voyage');
    expect(results.provenance.model).toBe('voyage-3');
  });

  it('should not include Voyage params in batch calls for non-Voyage providers', async () => {
    // Arrange: plain OpenAI-compatible provider
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([
      makeProvider({
        providerType: 'openai-compatible',
        baseUrl: 'https://api.openai.com/v1',
        isLocal: false,
      }),
    ] as never);

    mockFetch.mockResolvedValue(
      makeFetchResponse([
        { embedding: [0.1, 0.2], index: 0 },
        { embedding: [0.3, 0.4], index: 1 },
      ])
    );

    // Act: passing inputType but provider is not Voyage
    await embedBatch(['a', 'b'], 10, 'query');

    // Assert: no Voyage-specific fields in request body
    const [, init] = mockFetch.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(init.body) as Record<string, unknown>;
    expect(body).not.toHaveProperty('input_type');
    expect(body).not.toHaveProperty('output_dimension');
  });
});
