/**
 * Embedder Unit Tests
 *
 * The embedder CHOOSES a provider row and a model, then reaches the vendor
 * through the provider manager's `embedMany` (t-740). These tests pin the
 * choice and the call: which slug `getProvider` is asked for, and exactly what
 * `embedMany` is given. HTTP mechanics (URL, auth header, SSRF, redirects,
 * error bodies, usage parsing, index ordering) belong to the providers and are
 * tested in `tests/unit/lib/orchestration/llm/{voyage,openai-compatible}.test.ts`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { prisma } from '@/lib/db/client';
import type { LlmProvider } from '@/lib/orchestration/llm/provider';
import type { EmbedManyOptions, EmbedManyResult } from '@/lib/orchestration/llm/types';

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

// The embedder's only route to a vendor. `getProvider` hands back a fake whose
// `embedMany` each test controls; `isApiKeyEnvVarSet` drives the retired
// bare-key message.
vi.mock('@/lib/orchestration/llm/provider-manager', () => ({
  getProvider: vi.fn(),
  isApiKeyEnvVarSet: vi.fn(),
}));

// Import SUT after mocks are in place
const { embedText, embedBatch, getActiveEmbeddingModelSummary } =
  await import('@/lib/orchestration/knowledge/embedder');
const { getProvider, isApiKeyEnvVarSet } = await import('@/lib/orchestration/llm/provider-manager');

/**
 * The gate context the embedder fetches its provider with (§120 t-741): a row
 * the fallback chain picked is Sunrise's choice, the operator's pinned active
 * model is theirs. The call-time gate hands it to the eligibility rule.
 */
const CHAIN_PICK = { task: 'embeddings', source: 'primary', primarySlug: null } as const;
const OPERATOR_PIN = { task: 'embeddings', source: 'explicit', primarySlug: null } as const;
const { logger } = await import('@/lib/logging');
const { NoProviderConfiguredError } = await import('@/lib/orchestration/llm/agent-resolver');

// --- Fakes ---

type EmbedManyFn = (texts: string[], options: EmbedManyOptions) => Promise<EmbedManyResult>;

// A simple 1536-dim zero vector
const zeroVec = new Array(1536).fill(0);

/** One zero vector per input text, with a fixed reported token count. */
const echoEmbedMany = (): EmbedManyFn =>
  vi.fn(async (texts: string[]) => ({
    embeddings: texts.map(() => zeroVec),
    inputTokens: 7,
  }));

/**
 * Build the fake provider `getProvider` returns. The one cast lives here: the
 * fake carries only the members the embedder touches.
 */
function fakeProvider(embedMany: EmbedManyFn | undefined): LlmProvider {
  return { name: 'fake', isLocal: false, embedMany } as unknown as LlmProvider;
}

/** Point `getProvider` at a fake whose `embedMany` is the returned mock. */
function installEmbedMany(impl: EmbedManyFn = echoEmbedMany()) {
  const embedMany = vi.fn(impl);
  vi.mocked(getProvider).mockResolvedValue(fakeProvider(embedMany));
  return embedMany;
}

// A minimal AiProviderConfig stub
function makeProvider(overrides: Record<string, unknown> = {}) {
  return {
    id: 'prov-1',
    name: 'Test Provider',
    slug: 'test-provider',
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
  beforeEach(() => {
    vi.resetAllMocks();
    // Default: no operator-picked active embedding model. Tests that
    // exercise the active-model path override this explicitly.
    vi.mocked(prisma.aiOrchestrationSettings.findFirst).mockResolvedValue(null);
  });

  it('should prefer a local provider when one is present alongside openai-compatible', async () => {
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([
      makeProvider({ id: 'remote-1', slug: 'remote', isLocal: false }),
      makeProvider({ id: 'local-1', slug: 'ollama', isLocal: true }),
    ] as never);
    const embedMany = installEmbedMany();

    await embedText('hello');

    // The local row wins even though the remote row sorts first.
    expect(getProvider).toHaveBeenCalledTimes(1);
    expect(getProvider).toHaveBeenCalledWith('ollama', CHAIN_PICK);
    // Local model is nomic-embed-text, and a fixed-width model is not asked for `dimensions`.
    expect(embedMany).toHaveBeenCalledTimes(1);
    expect(embedMany).toHaveBeenCalledWith(['hello'], { model: 'nomic-embed-text' });
  });

  it('should fall back to first openai-compatible provider when no local provider', async () => {
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([
      makeProvider({ id: 'remote-1', slug: 'remote', isLocal: false }),
    ] as never);
    const embedMany = installEmbedMany();

    await embedText('hello');

    expect(getProvider).toHaveBeenCalledWith('remote', CHAIN_PICK);
    // settings model, and `dimensions` because text-embedding-3-* accepts it
    expect(embedMany).toHaveBeenCalledWith(['hello'], {
      model: 'text-embedding-3-small',
      dimensions: 1536,
    });
  });

  it('should pick a voyage row by type alone, with no baseUrl needed', async () => {
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([
      makeProvider({ id: 'voyage-1', slug: 'voyage', providerType: 'voyage', baseUrl: null }),
    ] as never);
    const embedMany = installEmbedMany();

    await embedText('hello');

    expect(getProvider).toHaveBeenCalledWith('voyage', CHAIN_PICK);
    expect(embedMany).toHaveBeenCalledWith(['hello'], { model: 'voyage-3', dimensions: 1536 });
  });

  it('should skip an openai-compatible row with no baseUrl and take the next one', async () => {
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([
      makeProvider({ id: 'no-url', slug: 'no-url', baseUrl: null }),
      makeProvider({ id: 'has-url', slug: 'has-url' }),
    ] as never);
    const embedMany = installEmbedMany();

    await embedText('hello');

    expect(getProvider).toHaveBeenCalledWith('has-url', CHAIN_PICK);
    expect(embedMany).toHaveBeenCalledTimes(1);
  });

  it('should not send dimensions to an openai-compatible host for a non text-embedding-3 model', async () => {
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([
      makeProvider({ slug: 'together' }),
    ] as never);
    const { getDefaultModelForTask } = await import('@/lib/orchestration/llm/settings-resolver');
    vi.mocked(getDefaultModelForTask).mockResolvedValue('bge-large-en');
    const embedMany = installEmbedMany();

    await embedText('hello');

    // Paired with proof the path ran: the configured model reached embedMany.
    expect(embedMany).toHaveBeenCalledTimes(1);
    expect(embedMany).toHaveBeenCalledWith(['hello'], { model: 'bge-large-en' });
    expect(embedMany.mock.calls[0][1]).not.toHaveProperty('dimensions');
  });

  it('should throw a NoProviderConfiguredError that says the key alone no longer enables embeddings when only OPENAI_API_KEY is set', async () => {
    // The retired bare-key arm: no provider row, but the env key is present.
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([] as never);
    vi.mocked(isApiKeyEnvVarSet).mockReturnValue(true);

    const err = await embedText('hello').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(NoProviderConfiguredError);
    expect((err as Error).message).toMatch(/OPENAI_API_KEY is set/);
    expect((err as Error).message).toMatch(/key alone no longer enables embeddings/);
    // It asked about exactly the OpenAI key, and never went near a vendor.
    expect(isApiKeyEnvVarSet).toHaveBeenCalledWith('OPENAI_API_KEY');
    expect(getProvider).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('key alone no longer enables embeddings'),
      {}
    );
  });

  it('throws the plain "No embedding provider configured" when there is no row and no key', async () => {
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([] as never);
    vi.mocked(isApiKeyEnvVarSet).mockReturnValue(false);

    const err = await embedText('hello').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(NoProviderConfiguredError);
    expect((err as Error).message).toMatch(/No embedding provider configured/);
    // The plain message must not claim a key is present, and must not warn.
    expect((err as Error).message).not.toMatch(/OPENAI_API_KEY/);
    expect(isApiKeyEnvVarSet).toHaveBeenCalledWith('OPENAI_API_KEY');
    expect(logger.warn).not.toHaveBeenCalled();
    expect(getProvider).not.toHaveBeenCalled();
  });
});

describe('embedText', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Default: no operator-picked active embedding model. Tests that
    // exercise the active-model path override this explicitly.
    vi.mocked(prisma.aiOrchestrationSettings.findFirst).mockResolvedValue(null);
  });

  it('should send the text and model to embedMany, and return the vector with provenance', async () => {
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([
      makeProvider({ slug: 'together', isLocal: false }),
    ] as never);
    const vec = [0.25, 0.5, 0.75];
    const embedMany = installEmbedMany(async () => ({ embeddings: [vec], inputTokens: 11 }));

    const result = await embedText('my test text');

    expect(getProvider).toHaveBeenCalledWith('together', CHAIN_PICK);
    expect(embedMany).toHaveBeenCalledWith(['my test text'], {
      model: 'text-embedding-3-small',
      dimensions: 1536,
    });
    expect(result).toMatchObject({
      embedding: vec,
      model: 'text-embedding-3-small',
      provider: 'openai-compatible',
      dimensions: 1536,
      inputTokens: 11,
    });
  });

  it('should send dimensions for non-local text-embedding-3-small', async () => {
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([
      makeProvider({ isLocal: false }),
    ] as never);
    const embedMany = installEmbedMany();

    await embedText('test');

    expect(embedMany.mock.calls[0][1]).toEqual({
      model: 'text-embedding-3-small',
      dimensions: 1536,
    });
  });

  it('should omit dimensions for local providers', async () => {
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([
      makeProvider({ isLocal: true }),
    ] as never);
    const embedMany = installEmbedMany();

    await embedText('test');

    // Paired with proof the local path ran: the local model was requested.
    expect(embedMany).toHaveBeenCalledTimes(1);
    expect(embedMany.mock.calls[0][1]).toEqual({ model: 'nomic-embed-text' });
    expect(embedMany.mock.calls[0][1]).not.toHaveProperty('dimensions');
  });

  it('should forward inputType to embedMany when given, and omit it when not', async () => {
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([makeProvider()] as never);
    const embedMany = installEmbedMany();

    await embedText('a query', 'query');
    await embedText('a document');

    expect(embedMany.mock.calls[0][1]).toMatchObject({ inputType: 'query' });
    expect(embedMany.mock.calls[1][1]).toEqual({
      model: 'text-embedding-3-small',
      dimensions: 1536,
    });
    expect(embedMany.mock.calls[1][1]).not.toHaveProperty('inputType');
  });

  it('should estimate tokens as ceil(chars / 4) when the provider reports none', async () => {
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([makeProvider()] as never);
    installEmbedMany(async (texts) => ({ embeddings: texts.map(() => zeroVec) }));

    // 10 chars -> ceil(10 / 4) = 3
    const result = await embedText('0123456789');

    expect(result.inputTokens).toBe(3);
  });

  it('should keep a reported zero token count rather than estimating', async () => {
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([makeProvider()] as never);
    installEmbedMany(async (texts) => ({ embeddings: texts.map(() => zeroVec), inputTokens: 0 }));

    // Zero is a real count; only `undefined` means "unknown".
    const result = await embedText('0123456789');

    expect(result.inputTokens).toBe(0);
  });

  it('should reject with code embedding_unsupported when the provider has no embedMany', async () => {
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([
      makeProvider({ slug: 'legacy-class' }),
    ] as never);
    vi.mocked(getProvider).mockResolvedValue(fakeProvider(undefined));

    const err = await embedText('test').catch((e: unknown) => e);

    expect(err).toMatchObject({ code: 'embedding_unsupported', retriable: false });
    expect((err as Error).message).toContain('"legacy-class"');
    expect((err as Error).message).toContain('embedMany');
  });

  it('should reject when embedMany returns a different number of vectors than texts', async () => {
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([makeProvider()] as never);
    installEmbedMany(async () => ({ embeddings: [zeroVec, zeroVec], inputTokens: 1 }));

    await expect(embedText('one text')).rejects.toThrow(
      'Embedding API returned 2 embeddings for 1 texts'
    );
  });

  it('should propagate an embedMany failure to the caller', async () => {
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([makeProvider()] as never);
    installEmbedMany(async () => {
      throw new Error('vendor said no');
    });

    await expect(embedText('test')).rejects.toThrow('vendor said no');
  });
});

describe('embedBatch', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Default: no operator-picked active embedding model. Tests that
    // exercise the active-model path override this explicitly.
    vi.mocked(prisma.aiOrchestrationSettings.findFirst).mockResolvedValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should return an empty array and make no provider calls for empty input', async () => {
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([makeProvider()] as never);
    const embedMany = installEmbedMany();

    const result = await embedBatch([]);

    expect(result.embeddings).toEqual([]);
    expect(embedMany).not.toHaveBeenCalled();
    // Provenance is still resolved, which proves the resolver ran before the no-op loop.
    expect(result.provenance.model).toBe('text-embedding-3-small');
  });

  it('should split 250 texts into 3 batches of 100/100/50 with default batch size', async () => {
    vi.useFakeTimers();
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([makeProvider()] as never);
    // Tag each vector with the text it came from so order across batches is checkable.
    const embedMany = installEmbedMany(async (texts) => ({
      embeddings: texts.map((t) => [Number(t.split('-')[1])]),
      inputTokens: texts.length,
    }));

    const texts = Array.from({ length: 250 }, (_, i) => `text-${i}`);
    const promise = embedBatch(texts);
    await vi.advanceTimersByTimeAsync(1000);
    const result = await promise;

    expect(embedMany).toHaveBeenCalledTimes(3);
    expect(embedMany.mock.calls.map((c) => c[0].length)).toEqual([100, 100, 50]);
    expect(embedMany.mock.calls[1][0][0]).toBe('text-100');
    expect(embedMany.mock.calls[2][0][0]).toBe('text-200');
    expect(result.embeddings).toHaveLength(250);
    expect(result.embeddings[0]).toEqual([0]);
    expect(result.embeddings[249]).toEqual([249]);
  });

  it('should pause 200ms between batches but not after the last batch', async () => {
    vi.useFakeTimers();
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([makeProvider()] as never);
    const embedMany = installEmbedMany();

    // batchSize=1 gives 3 batches -> 2 delays
    const promise = embedBatch(['t0', 't1', 't2'], 1);

    await vi.advanceTimersByTimeAsync(0);
    expect(embedMany).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(199);
    expect(embedMany).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(embedMany).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(200);
    // The third call is the last; nothing further is scheduled after it.
    const result = await promise;

    expect(embedMany).toHaveBeenCalledTimes(3);
    expect(result.embeddings).toHaveLength(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('should concatenate batch results in input order and report provenance', async () => {
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([makeProvider()] as never);
    const vec0 = [10, 20];
    const vec1 = [30, 40];
    const vec2 = [50, 60];
    const byText: Record<string, number[]> = { a: vec0, b: vec1, c: vec2 };
    installEmbedMany(async (texts) => ({ embeddings: texts.map((t) => byText[t]) }));

    const result = await embedBatch(['a', 'b', 'c'], 10);

    expect(result.embeddings).toEqual([vec0, vec1, vec2]);
    expect(result.provenance.model).toBe('text-embedding-3-small');
    expect(result.provenance.provider).toBe('openai-compatible');
    expect(result.provenance.dimensions).toBe(1536);
    expect(result.provenance.embeddedAt).toBeInstanceOf(Date);
  });

  it('should reject when a mid-batch embedMany call fails', async () => {
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([makeProvider()] as never);
    vi.useFakeTimers();

    // First batch succeeds, second rejects
    const embedMany = installEmbedMany();
    embedMany
      .mockResolvedValueOnce({ embeddings: [zeroVec], inputTokens: 1 })
      .mockRejectedValueOnce(new Error('Network error on batch 2'));

    const assertion = expect(embedBatch(['text-0', 'text-1'], 1)).rejects.toThrow(
      'Network error on batch 2'
    );
    await vi.advanceTimersByTimeAsync(200);
    await assertion;

    expect(embedMany).toHaveBeenCalledTimes(2);
  });

  it('should reject when one batch returns the wrong number of vectors', async () => {
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([makeProvider()] as never);
    installEmbedMany(async () => ({ embeddings: [zeroVec], inputTokens: 1 }));

    await expect(embedBatch(['a', 'b', 'c'], 10)).rejects.toThrow(
      'Embedding API returned 1 embeddings for 3 texts'
    );
  });

  it('should reject with code embedding_unsupported when the provider has no embedMany', async () => {
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([
      makeProvider({ slug: 'legacy-class' }),
    ] as never);
    vi.mocked(getProvider).mockResolvedValue(fakeProvider(undefined));

    await expect(embedBatch(['a'])).rejects.toMatchObject({ code: 'embedding_unsupported' });
  });
});

// ---------------------------------------------------------------------------
// Helper: build a minimal AiProviderModel stub for active-embedding-model tests
// ---------------------------------------------------------------------------

function makeModelRow(overrides: Record<string, unknown> = {}) {
  return {
    modelId: 'text-embedding-3-small',
    dimensions: 1536,
    capabilities: ['embedding'],
    isActive: true,
    providerSlug: 'openai',
    schemaCompatible: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// getActiveEmbeddingModelSummary
// ---------------------------------------------------------------------------

describe('getActiveEmbeddingModelSummary', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(prisma.aiOrchestrationSettings.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.aiProviderModel.findUnique).mockResolvedValue(null);
  });

  it('returns null when no AiOrchestrationSettings row exists', async () => {
    // Arrange: findFirst returns null (default from beforeEach)

    // Act
    const result = await getActiveEmbeddingModelSummary();

    // Assert: no settings → no active model id → null
    expect(result).toBeNull();
  });

  it('returns null when the settings row has a null activeEmbeddingModelId', async () => {
    // Arrange: settings row exists but activeEmbeddingModelId is null
    vi.mocked(prisma.aiOrchestrationSettings.findFirst).mockResolvedValue({
      activeEmbeddingModelId: null,
    } as never);

    // Act
    const result = await getActiveEmbeddingModelSummary();

    // Assert: id is falsy → null without querying the model
    expect(result).toBeNull();
    expect(prisma.aiProviderModel.findUnique).not.toHaveBeenCalled();
  });

  it('returns null when AiProviderModel.findUnique returns null', async () => {
    // Arrange: settings points at a model id that no longer exists
    vi.mocked(prisma.aiOrchestrationSettings.findFirst).mockResolvedValue({
      activeEmbeddingModelId: 'model-gone',
    } as never);
    vi.mocked(prisma.aiProviderModel.findUnique).mockResolvedValue(null);

    // Act
    const result = await getActiveEmbeddingModelSummary();

    // Assert: model missing → null
    expect(result).toBeNull();
  });

  it('returns null when the referenced model is inactive', async () => {
    // Arrange: model exists but isActive is false
    vi.mocked(prisma.aiOrchestrationSettings.findFirst).mockResolvedValue({
      activeEmbeddingModelId: 'model-1',
    } as never);
    vi.mocked(prisma.aiProviderModel.findUnique).mockResolvedValue(
      makeModelRow({ isActive: false }) as never
    );

    // Act
    const result = await getActiveEmbeddingModelSummary();

    // Assert: inactive model is unusable → null
    expect(result).toBeNull();
  });

  it("returns null when the model's capabilities do not include 'embedding'", async () => {
    // Arrange: model is a chat-only model
    vi.mocked(prisma.aiOrchestrationSettings.findFirst).mockResolvedValue({
      activeEmbeddingModelId: 'model-1',
    } as never);
    vi.mocked(prisma.aiProviderModel.findUnique).mockResolvedValue(
      makeModelRow({ capabilities: ['chat'] }) as never
    );

    // Act
    const result = await getActiveEmbeddingModelSummary();

    // Assert: no embedding capability → null
    expect(result).toBeNull();
  });

  it('returns null when the model has null dimensions', async () => {
    // Arrange: model hasn't had dimensions populated yet
    vi.mocked(prisma.aiOrchestrationSettings.findFirst).mockResolvedValue({
      activeEmbeddingModelId: 'model-1',
    } as never);
    vi.mocked(prisma.aiProviderModel.findUnique).mockResolvedValue(
      makeModelRow({ dimensions: null }) as never
    );

    // Act
    const result = await getActiveEmbeddingModelSummary();

    // Assert: dim-less model can't be used for drift detection → null
    expect(result).toBeNull();
  });

  it('returns null when the model has zero dimensions', async () => {
    // Arrange: dimensions is explicitly 0 (invalid)
    vi.mocked(prisma.aiOrchestrationSettings.findFirst).mockResolvedValue({
      activeEmbeddingModelId: 'model-1',
    } as never);
    vi.mocked(prisma.aiProviderModel.findUnique).mockResolvedValue(
      makeModelRow({ dimensions: 0 }) as never
    );

    // Act
    const result = await getActiveEmbeddingModelSummary();

    // Assert: 0 is ≤ 0, which the validity gate rejects
    expect(result).toBeNull();
  });

  it('returns { modelId, dimensions } when all validity gates pass', async () => {
    // Arrange: settings + fully-valid model row
    vi.mocked(prisma.aiOrchestrationSettings.findFirst).mockResolvedValue({
      activeEmbeddingModelId: 'model-1',
    } as never);
    vi.mocked(prisma.aiProviderModel.findUnique).mockResolvedValue(
      makeModelRow({ modelId: 'text-embedding-3-large', dimensions: 3072 }) as never
    );

    // Act
    const result = await getActiveEmbeddingModelSummary();

    // Assert: all gates pass → summary returned with values from the DB row (not hardcoded)
    expect(result).toEqual({ modelId: 'text-embedding-3-large', dimensions: 3072 });
  });
});

// ---------------------------------------------------------------------------
// resolveActiveEmbeddingConfig (exercised via embedText / embedBatch)
// ---------------------------------------------------------------------------

describe('resolveActiveEmbeddingConfig (via embedText)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Default fallback chain: one openai-compatible provider so tests that
    // verify "falls back to provider-priority" get a determinate result.
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([
      makeProvider({
        id: 'fallback-1',
        slug: 'fallback',
        providerType: 'openai-compatible',
        baseUrl: 'https://fallback.example.com/v1',
        apiKeyEnvVar: null,
      }),
    ] as never);
    // Default: no active-model override
    vi.mocked(prisma.aiOrchestrationSettings.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.aiProviderModel.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.aiProviderConfig.findFirst).mockResolvedValue(null);
  });

  /** Assert the chain's default row served the call, and embedMany ran with the chain's model. */
  function expectFellBackToChain(embedMany: ReturnType<typeof installEmbedMany>) {
    expect(getProvider).toHaveBeenCalledTimes(1);
    expect(getProvider).toHaveBeenCalledWith('fallback', CHAIN_PICK);
    expect(embedMany).toHaveBeenCalledWith(['hello'], {
      model: 'text-embedding-3-small',
      dimensions: 1536,
    });
  }

  it('falls through to provider-priority when activeEmbeddingModelId is null', async () => {
    // Arrange: settings row explicitly returns null activeEmbeddingModelId
    vi.mocked(prisma.aiOrchestrationSettings.findFirst).mockResolvedValue({
      activeEmbeddingModelId: null,
    } as never);
    const embedMany = installEmbedMany();

    // Act
    await embedText('hello');

    // Assert: provider-priority path hit the fallback openai-compatible provider
    expectFellBackToChain(embedMany);
    expect(prisma.aiProviderModel.findUnique).not.toHaveBeenCalled();
  });

  it('falls back with a warn log when the picked model is inactive', async () => {
    vi.mocked(prisma.aiOrchestrationSettings.findFirst).mockResolvedValue({
      activeEmbeddingModelId: 'inactive-model',
    } as never);
    vi.mocked(prisma.aiProviderModel.findUnique).mockResolvedValue(
      makeModelRow({ isActive: false }) as never
    );
    const embedMany = installEmbedMany();

    await embedText('hello');

    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.stringContaining('missing or inactive'),
      expect.objectContaining({ activeEmbeddingModelId: 'inactive-model' })
    );
    expectFellBackToChain(embedMany);
  });

  it('falls back with a warn log when the picked model is missing', async () => {
    // The "missing or inactive" gate is one `if`; this is its other half.
    vi.mocked(prisma.aiOrchestrationSettings.findFirst).mockResolvedValue({
      activeEmbeddingModelId: 'deleted-model',
    } as never);
    vi.mocked(prisma.aiProviderModel.findUnique).mockResolvedValue(null);
    const embedMany = installEmbedMany();

    await embedText('hello');

    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.stringContaining('missing or inactive'),
      expect.objectContaining({ activeEmbeddingModelId: 'deleted-model' })
    );
    expectFellBackToChain(embedMany);
  });

  it("falls back with a warn log when the picked model lacks the 'embedding' capability", async () => {
    vi.mocked(prisma.aiOrchestrationSettings.findFirst).mockResolvedValue({
      activeEmbeddingModelId: 'chat-only-model',
    } as never);
    vi.mocked(prisma.aiProviderModel.findUnique).mockResolvedValue(
      makeModelRow({ capabilities: ['chat'] }) as never
    );
    const embedMany = installEmbedMany();

    await embedText('hello');

    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.stringContaining('embedding capability'),
      expect.objectContaining({ activeEmbeddingModelId: 'chat-only-model' })
    );
    expectFellBackToChain(embedMany);
  });

  it('falls back with a warn log when the picked model has no dimensions', async () => {
    vi.mocked(prisma.aiOrchestrationSettings.findFirst).mockResolvedValue({
      activeEmbeddingModelId: 'dim-less-model',
    } as never);
    vi.mocked(prisma.aiProviderModel.findUnique).mockResolvedValue(
      makeModelRow({ dimensions: null }) as never
    );
    const embedMany = installEmbedMany();

    await embedText('hello');

    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.stringContaining('no dimensions'),
      expect.objectContaining({ activeEmbeddingModelId: 'dim-less-model' })
    );
    expectFellBackToChain(embedMany);
  });

  it('falls back with a warn log when no matching AiProviderConfig exists for the active model', async () => {
    vi.mocked(prisma.aiOrchestrationSettings.findFirst).mockResolvedValue({
      activeEmbeddingModelId: 'valid-model',
    } as never);
    vi.mocked(prisma.aiProviderModel.findUnique).mockResolvedValue(
      makeModelRow({ providerSlug: 'missing-provider' }) as never
    );
    vi.mocked(prisma.aiProviderConfig.findFirst).mockResolvedValue(null);
    const embedMany = installEmbedMany();

    await embedText('hello');

    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.stringContaining('no matching active provider'),
      expect.objectContaining({ providerSlug: 'missing-provider' })
    );
    // The lookup was for the pinned model's provider slug, active rows only.
    expect(prisma.aiProviderConfig.findFirst).toHaveBeenCalledWith({
      where: { slug: 'missing-provider', isActive: true },
    });
    expectFellBackToChain(embedMany);
  });

  it('falls back with a warn log when provider has no baseUrl and is not Voyage', async () => {
    vi.mocked(prisma.aiOrchestrationSettings.findFirst).mockResolvedValue({
      activeEmbeddingModelId: 'valid-model',
    } as never);
    vi.mocked(prisma.aiProviderModel.findUnique).mockResolvedValue(
      makeModelRow({ providerSlug: 'custom-provider' }) as never
    );
    vi.mocked(prisma.aiProviderConfig.findFirst).mockResolvedValue(
      makeProvider({
        slug: 'custom-provider',
        providerType: 'openai-compatible',
        baseUrl: null,
      }) as never
    );
    const embedMany = installEmbedMany();

    await embedText('hello');

    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.stringContaining('no baseUrl'),
      expect.objectContaining({ providerSlug: 'custom-provider' })
    );
    // The pinned slug was never fetched; the chain's row served the call.
    expect(getProvider).not.toHaveBeenCalledWith('custom-provider');
    expectFellBackToChain(embedMany);
  });

  it('active-model path: sends dimensions (schemaCompatible: true) and uses the registry model', async () => {
    vi.mocked(prisma.aiOrchestrationSettings.findFirst).mockResolvedValue({
      activeEmbeddingModelId: 'active-model-1',
    } as never);
    vi.mocked(prisma.aiProviderModel.findUnique).mockResolvedValue(
      makeModelRow({
        modelId: 'text-embedding-3-large',
        dimensions: 3072,
        providerSlug: 'openai-custom',
        schemaCompatible: true,
      }) as never
    );
    vi.mocked(prisma.aiProviderConfig.findFirst).mockResolvedValue(
      makeProvider({
        slug: 'openai-custom',
        providerType: 'openai-compatible',
        baseUrl: 'https://active.example.com/v1',
      }) as never
    );
    const embedMany = installEmbedMany();

    const result = await embedText('hello');

    // The pinned row was used, not the fallback row.
    expect(getProvider).toHaveBeenCalledTimes(1);
    expect(getProvider).toHaveBeenCalledWith('openai-custom', OPERATOR_PIN);
    // Model and width come from the registry row, and dimensions are sent.
    expect(embedMany).toHaveBeenCalledWith(['hello'], {
      model: 'text-embedding-3-large',
      dimensions: 3072,
    });
    expect(result).toMatchObject({ model: 'text-embedding-3-large', dimensions: 3072 });
  });

  it('active-model path: omits dimensions when schemaCompatible is false', async () => {
    vi.mocked(prisma.aiOrchestrationSettings.findFirst).mockResolvedValue({
      activeEmbeddingModelId: 'local-active-model',
    } as never);
    vi.mocked(prisma.aiProviderModel.findUnique).mockResolvedValue(
      makeModelRow({
        modelId: 'nomic-embed-text',
        dimensions: 768,
        providerSlug: 'local-ollama',
        schemaCompatible: false,
      }) as never
    );
    vi.mocked(prisma.aiProviderConfig.findFirst).mockResolvedValue(
      makeProvider({
        slug: 'local-ollama',
        providerType: 'openai-compatible',
        baseUrl: 'http://ollama.local/v1',
        isLocal: true,
      }) as never
    );
    const embedMany = installEmbedMany();

    const result = await embedText('hello');

    expect(getProvider).toHaveBeenCalledWith('local-ollama', OPERATOR_PIN);
    // The registry model reached embedMany (the path ran) and no width was requested.
    expect(embedMany).toHaveBeenCalledTimes(1);
    expect(embedMany.mock.calls[0][1]).toEqual({ model: 'nomic-embed-text' });
    expect(embedMany.mock.calls[0][1]).not.toHaveProperty('dimensions');
    // The recorded width is still the registry's, even though it was not sent.
    expect(result.dimensions).toBe(768);
  });

  it('falls back gracefully when AiOrchestrationSettings.findFirst rejects (catch path)', async () => {
    vi.mocked(prisma.aiOrchestrationSettings.findFirst).mockRejectedValue(
      new Error('DB connection lost')
    );
    const embedMany = installEmbedMany();

    await embedText('hello');

    expectFellBackToChain(embedMany);
  });

  it('falls back gracefully when AiProviderModel.findUnique rejects inside resolveActiveEmbeddingConfig', async () => {
    vi.mocked(prisma.aiOrchestrationSettings.findFirst).mockResolvedValue({
      activeEmbeddingModelId: 'model-db-error',
    } as never);
    vi.mocked(prisma.aiProviderModel.findUnique).mockRejectedValue(new Error('timeout'));
    const embedMany = installEmbedMany();

    await embedText('hello');

    expectFellBackToChain(embedMany);
  });

  it('falls back gracefully when AiProviderConfig.findFirst rejects inside resolveActiveEmbeddingConfig', async () => {
    vi.mocked(prisma.aiOrchestrationSettings.findFirst).mockResolvedValue({
      activeEmbeddingModelId: 'config-db-error',
    } as never);
    vi.mocked(prisma.aiProviderModel.findUnique).mockResolvedValue(
      makeModelRow({ providerSlug: 'broken-provider' }) as never
    );
    vi.mocked(prisma.aiProviderConfig.findFirst).mockRejectedValue(
      new Error('provider config DB error')
    );
    const embedMany = installEmbedMany();

    await embedText('hello');

    expectFellBackToChain(embedMany);
  });

  it('active Voyage model: sends dimensions and inputType to embedMany, never the vendor field names', async () => {
    vi.mocked(prisma.aiOrchestrationSettings.findFirst).mockResolvedValue({
      activeEmbeddingModelId: 'voyage-active',
    } as never);
    vi.mocked(prisma.aiProviderModel.findUnique).mockResolvedValue(
      makeModelRow({
        modelId: 'voyage-3-large',
        dimensions: 1024,
        providerSlug: 'voyage-custom',
        // Voyage always takes a dimension, whatever the flag says.
        schemaCompatible: false,
      }) as never
    );
    vi.mocked(prisma.aiProviderConfig.findFirst).mockResolvedValue(
      makeProvider({
        slug: 'voyage-custom',
        providerType: 'voyage',
        baseUrl: null, // null baseUrl is fine for Voyage
      }) as never
    );
    const embedMany = installEmbedMany();

    const result = await embedText('hello', 'query');

    expect(getProvider).toHaveBeenCalledWith('voyage-custom', OPERATOR_PIN);
    expect(embedMany).toHaveBeenCalledWith(['hello'], {
      model: 'voyage-3-large',
      dimensions: 1024,
      inputType: 'query',
    });
    // Provenance records the provider TYPE, not the slug.
    expect(result.provider).toBe('voyage');
  });

  it('active-model path: a null schemaCompatible on a non-Voyage row sends no dimensions', async () => {
    vi.mocked(prisma.aiOrchestrationSettings.findFirst).mockResolvedValue({
      activeEmbeddingModelId: 'unflagged',
    } as never);
    vi.mocked(prisma.aiProviderModel.findUnique).mockResolvedValue(
      makeModelRow({ providerSlug: 'plain-host', schemaCompatible: null }) as never
    );
    vi.mocked(prisma.aiProviderConfig.findFirst).mockResolvedValue(
      makeProvider({ slug: 'plain-host' }) as never
    );
    const embedMany = installEmbedMany();

    await embedText('hello');

    expect(getProvider).toHaveBeenCalledWith('plain-host', OPERATOR_PIN);
    expect(embedMany).toHaveBeenCalledTimes(1);
    expect(embedMany.mock.calls[0][1]).toEqual({ model: 'text-embedding-3-small' });
  });
});
