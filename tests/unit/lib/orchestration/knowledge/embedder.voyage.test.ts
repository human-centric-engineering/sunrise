/**
 * Embedder — Voyage AI Integration Tests
 *
 * Focused tests for the Voyage-specific behaviour of the embedder:
 *   - resolveProvider() prefers Voyage over local and openai-compatible providers
 *   - the Voyage arm always asks embedMany for `dimensions` (1536) and model voyage-3
 *   - non-Voyage arms do not get a `dimensions` they would reject
 *   - embedText() and embedBatch() forward the optional inputType to embedMany
 *
 * How Voyage turns those options into `input_type` / `output_dimension`, and
 * what it defaults `input_type` to, is the provider's job and is tested in
 * `tests/unit/lib/orchestration/llm/voyage.test.ts`.
 *
 * These tests augment (but do not duplicate) the main embedder.test.ts suite.
 *
 * @see lib/orchestration/knowledge/embedder.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '@/lib/db/client';
import type { LlmProvider } from '@/lib/orchestration/llm/provider';
import type { EmbedManyOptions, EmbedManyResult } from '@/lib/orchestration/llm/types';

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

vi.mock('@/lib/orchestration/llm/provider-manager', () => ({
  getProvider: vi.fn(),
  isApiKeyEnvVarSet: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Import SUT after mocks
// ---------------------------------------------------------------------------

const { embedText, embedBatch } = await import('@/lib/orchestration/knowledge/embedder');
const { getProvider } = await import('@/lib/orchestration/llm/provider-manager');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type EmbedManyFn = (texts: string[], options: EmbedManyOptions) => Promise<EmbedManyResult>;

/** A simple 1536-dim zero vector */
const zeroVec = new Array(1536).fill(0);

/** Install a fake provider whose `embedMany` is the returned mock. */
function installEmbedMany(
  impl: EmbedManyFn = async (texts) => ({
    embeddings: texts.map(() => zeroVec),
    inputTokens: 3,
  })
) {
  const embedMany = vi.fn(impl);
  vi.mocked(getProvider).mockResolvedValue({
    name: 'fake',
    isLocal: false,
    embedMany,
  } as unknown as LlmProvider);
  return embedMany;
}

/** A minimal AiProviderConfig stub */
function makeProvider(overrides: Record<string, unknown> = {}) {
  return {
    id: 'prov-1',
    name: 'Test Provider',
    slug: 'test-provider',
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
    slug: 'voyage',
    providerType: 'voyage',
    baseUrl: 'https://api.voyageai.com/v1',
    apiKeyEnvVar: 'VOYAGE_API_KEY',
    isLocal: false,
    ...overrides,
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(prisma.aiOrchestrationSettings.findFirst).mockResolvedValue(null);
});

// ---------------------------------------------------------------------------
// resolveProvider() — Voyage preference
// ---------------------------------------------------------------------------

describe('resolveProvider() Voyage preference (via embedText)', () => {
  it('should prefer Voyage provider over a local provider', async () => {
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([
      makeVoyageProvider(),
      makeProvider({ id: 'local-1', slug: 'ollama', isLocal: true }),
    ] as never);
    const embedMany = installEmbedMany();

    await embedText('hello');

    expect(getProvider).toHaveBeenCalledTimes(1);
    expect(getProvider).toHaveBeenCalledWith('voyage');
    expect(embedMany.mock.calls[0][1]).toMatchObject({ model: 'voyage-3' });
  });

  it('should prefer Voyage provider over an openai-compatible cloud provider, whichever sorts first', async () => {
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([
      makeProvider({ id: 'openai-1', slug: 'openai', apiKeyEnvVar: 'OPENAI_API_KEY' }),
      makeVoyageProvider(),
    ] as never);
    const embedMany = installEmbedMany();

    await embedText('hello');

    expect(getProvider).toHaveBeenCalledWith('voyage');
    expect(embedMany.mock.calls[0][1]).toMatchObject({ model: 'voyage-3' });
  });

  it('should use voyage-3 model when Voyage provider is selected', async () => {
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([makeVoyageProvider()] as never);
    const embedMany = installEmbedMany();

    const result = await embedText('test');

    expect(embedMany).toHaveBeenCalledWith(['test'], { model: 'voyage-3', dimensions: 1536 });
    expect(result.model).toBe('voyage-3');
  });

  it('should select a Voyage row that has no baseUrl, by slug', async () => {
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([
      makeVoyageProvider({ slug: 'voyage-default', baseUrl: null }),
    ] as never);
    const embedMany = installEmbedMany();

    await embedText('hello');

    // The embedder no longer knows a URL at all: the slug is the whole handoff.
    expect(getProvider).toHaveBeenCalledWith('voyage-default');
    expect(embedMany).toHaveBeenCalledTimes(1);
  });

  it('should hand the embedder row to the provider manager by its slug, not its name', async () => {
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([
      makeVoyageProvider({ name: 'Voyage AI (EU)', slug: 'voyage-eu' }),
    ] as never);
    installEmbedMany();

    await embedText('hello');

    expect(getProvider).toHaveBeenCalledWith('voyage-eu');
    expect(getProvider).not.toHaveBeenCalledWith('Voyage AI (EU)');
  });
});

// ---------------------------------------------------------------------------
// embedMany options — Voyage vs non-Voyage
// ---------------------------------------------------------------------------

describe('embedMany options by provider type (via embedText)', () => {
  it('should always request dimensions 1536 from a Voyage provider', async () => {
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([makeVoyageProvider()] as never);
    const embedMany = installEmbedMany();

    await embedText('test');

    // Must match the pgvector column width.
    expect(embedMany.mock.calls[0][1]).toMatchObject({ model: 'voyage-3', dimensions: 1536 });
  });

  it('should not set inputType for Voyage when the caller supplied none', async () => {
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([makeVoyageProvider()] as never);
    const embedMany = installEmbedMany();

    await embedText('document content');

    // The "document" default is the provider's to apply; the embedder stays silent.
    expect(embedMany).toHaveBeenCalledTimes(1);
    expect(embedMany.mock.calls[0][1]).toEqual({ model: 'voyage-3', dimensions: 1536 });
    expect(embedMany.mock.calls[0][1]).not.toHaveProperty('inputType');
  });

  it('should pass inputType "query" to Voyage when specified', async () => {
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([makeVoyageProvider()] as never);
    const embedMany = installEmbedMany();

    await embedText('search query', 'query');

    expect(embedMany).toHaveBeenCalledWith(['search query'], {
      model: 'voyage-3',
      dimensions: 1536,
      inputType: 'query',
    });
  });

  it('should request dimensions from a plain openai-compatible provider on the default text-embedding-3 model', async () => {
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([
      makeProvider({ slug: 'openai-like' }),
    ] as never);
    const embedMany = installEmbedMany();

    await embedText('test');

    // text-embedding-3-small IS schema compatible, so width is sent (and no Voyage-only inputType).
    expect(getProvider).toHaveBeenCalledWith('openai-like');
    expect(embedMany.mock.calls[0][1]).toEqual({
      model: 'text-embedding-3-small',
      dimensions: 1536,
    });
  });

  it('should not send dimensions to a local Ollama provider', async () => {
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([
      makeProvider({ slug: 'ollama', baseUrl: 'http://localhost:11434/v1', isLocal: true }),
    ] as never);
    const embedMany = installEmbedMany();

    await embedText('test');

    expect(getProvider).toHaveBeenCalledWith('ollama');
    expect(embedMany).toHaveBeenCalledTimes(1);
    expect(embedMany.mock.calls[0][1]).toEqual({ model: 'nomic-embed-text' });
    expect(embedMany.mock.calls[0][1]).not.toHaveProperty('dimensions');
  });
});

// ---------------------------------------------------------------------------
// embedText() with inputType parameter
// ---------------------------------------------------------------------------

describe('embedText() inputType parameter', () => {
  it('should accept an optional inputType parameter and pass it to embedMany for Voyage', async () => {
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([makeVoyageProvider()] as never);
    const embedMany = installEmbedMany();

    await embedText('a document to index', 'document');

    expect(embedMany.mock.calls[0][1]).toEqual({
      model: 'voyage-3',
      dimensions: 1536,
      inputType: 'document',
    });
  });

  it('should return a single embedding vector when called with inputType', async () => {
    const expectedVector = [0.1, 0.2, 0.3];
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([makeVoyageProvider()] as never);
    installEmbedMany(async () => ({ embeddings: [expectedVector], inputTokens: 2 }));

    const result = await embedText('test', 'query');

    expect(result.embedding).toEqual(expectedVector);
    expect(result.provider).toBe('voyage');
  });
});

// ---------------------------------------------------------------------------
// embedBatch() with inputType parameter
// ---------------------------------------------------------------------------

describe('embedBatch() inputType parameter', () => {
  it('should accept an optional inputType parameter and pass it through for Voyage', async () => {
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([makeVoyageProvider()] as never);
    const embedMany = installEmbedMany();

    await embedBatch(['text one', 'text two'], 10, 'query');

    expect(embedMany).toHaveBeenCalledTimes(1);
    expect(embedMany).toHaveBeenCalledWith(['text one', 'text two'], {
      model: 'voyage-3',
      dimensions: 1536,
      inputType: 'query',
    });
  });

  it('should return embeddings for all texts in batch when inputType is provided', async () => {
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([makeVoyageProvider()] as never);
    const vec1 = [1, 2, 3];
    const vec2 = [4, 5, 6];
    installEmbedMany(async () => ({ embeddings: [vec1, vec2], inputTokens: 4 }));

    const results = await embedBatch(['first', 'second'], 10, 'document');

    expect(results.embeddings).toEqual([vec1, vec2]);
    expect(results.provenance.provider).toBe('voyage');
    expect(results.provenance.model).toBe('voyage-3');
    expect(results.provenance.dimensions).toBe(1536);
  });

  it('should forward inputType on every chunk of a multi-batch run', async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([
        makeVoyageProvider(),
      ] as never);
      const embedMany = installEmbedMany();

      const promise = embedBatch(['a', 'b', 'c'], 2, 'document');
      await vi.advanceTimersByTimeAsync(500);
      await promise;

      expect(embedMany.mock.calls.map((c) => c[0])).toEqual([['a', 'b'], ['c']]);
      expect(embedMany.mock.calls.map((c) => c[1])).toEqual([
        { model: 'voyage-3', dimensions: 1536, inputType: 'document' },
        { model: 'voyage-3', dimensions: 1536, inputType: 'document' },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('should forward inputType to a non-Voyage provider too, leaving the provider to decide what to do with it', async () => {
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([
      makeProvider({ slug: 'openai-like' }),
    ] as never);
    const embedMany = installEmbedMany();

    await embedBatch(['a', 'b'], 10, 'query');

    // Dropping `input_type` for a host that rejects it is the openai-compatible
    // provider's job now; the embedder does not gate it on provider type.
    expect(getProvider).toHaveBeenCalledWith('openai-like');
    expect(embedMany).toHaveBeenCalledWith(['a', 'b'], {
      model: 'text-embedding-3-small',
      dimensions: 1536,
      inputType: 'query',
    });
  });
});
