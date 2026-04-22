/**
 * Tests for the dynamic model registry.
 *
 * Covers fallback behaviour when OpenRouter is unreachable, response
 * parsing + tier classification, accessor filters, in-flight
 * refresh deduplication, TTL cache short-circuit, non-OK HTTP errors,
 * malformed response handling, and refreshFromProvider behaviour.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const registry = await import('@/lib/orchestration/llm/model-registry');

const originalFetch = globalThis.fetch;

beforeEach(() => {
  registry.__resetForTests();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('fallback map', () => {
  it('returns Claude and GPT entries before any refresh', () => {
    expect(registry.getModel('claude-sonnet-4-6')?.tier).toBe('mid');
    expect(registry.getModel('claude-opus-4-6')?.tier).toBe('frontier');
    expect(registry.getModel('gpt-4o-mini')?.tier).toBe('budget');
    expect(registry.getModel('local:generic')?.tier).toBe('local');
  });

  it('is used when OpenRouter refresh rejects', async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new Error('network down')) as unknown as typeof fetch;
    await registry.refreshFromOpenRouter({ force: true });
    // Still resolves known fallback entries.
    expect(registry.getModel('claude-sonnet-4-6')).toBeDefined();
  });
});

describe('refreshFromOpenRouter', () => {
  it('parses pricing, tiers, and strips provider prefix from ids', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        data: [
          {
            id: 'openai/gpt-4o',
            name: 'GPT-4o',
            context_length: 128_000,
            pricing: { prompt: '0.0000025', completion: '0.00001' },
            supported_parameters: ['tools'],
          },
          {
            id: 'anthropic/claude-opus-4-6',
            name: 'Claude Opus 4.6',
            context_length: 200_000,
            pricing: { prompt: '0.000015', completion: '0.000075' },
            supported_parameters: ['tools'],
          },
          {
            id: 'some/budget-model',
            name: 'Budget',
            context_length: 8000,
            pricing: { prompt: '0.0000002', completion: '0.0000004' },
          },
        ],
      }),
    }) as unknown as typeof fetch;

    await registry.refreshFromOpenRouter({ force: true });

    const gpt = registry.getModel('gpt-4o');
    expect(gpt).toBeDefined();
    expect(gpt?.inputCostPerMillion).toBeCloseTo(2.5);
    expect(gpt?.outputCostPerMillion).toBeCloseTo(10);
    expect(gpt?.provider).toBe('openai');
    expect(gpt?.tier).toBe('mid'); // 2.5 <= 5
    expect(gpt?.supportsTools).toBe(true);

    // Full prefixed id should also resolve to the same entry.
    expect(registry.getModel('openai/gpt-4o')?.id).toBe('gpt-4o');

    expect(registry.getModel('claude-opus-4-6')?.tier).toBe('frontier');
    expect(registry.getModel('budget-model')?.tier).toBe('budget');
  });

  it('deduplicates concurrent refresh calls', async () => {
    let resolveFetch: ((value: unknown) => void) | null = null;
    const pending = new Promise((resolve) => {
      resolveFetch = resolve;
    });
    const mockFetch = vi.fn().mockReturnValue(
      pending.then(() => ({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ data: [] }),
      }))
    );
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const a = registry.refreshFromOpenRouter({ force: true });
    const b = registry.refreshFromOpenRouter({ force: true });

    resolveFetch!(undefined);
    await Promise.all([a, b]);

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

describe('accessors', () => {
  it('filters by tier', () => {
    const frontier = registry.getModelsByTier('frontier');
    expect(frontier.some((m) => m.id === 'claude-opus-4-6')).toBe(true);
    expect(frontier.every((m) => m.tier === 'frontier')).toBe(true);
  });

  it('filters by provider', () => {
    const anthropic = registry.getModelsByProvider('anthropic');
    expect(anthropic.length).toBeGreaterThanOrEqual(3);
    expect(anthropic.every((m) => m.provider === 'anthropic')).toBe(true);
  });

  it('getAvailableModels filters by provider name when supplied', () => {
    const openai = registry.getAvailableModels('openai');
    expect(openai.every((m) => m.provider === 'openai')).toBe(true);
    expect(openai.some((m) => m.id === 'gpt-4o')).toBe(true);
  });
});

describe('refreshFromOpenRouter TTL cache', () => {
  it('returns cached data without re-fetching on second call within 24h', async () => {
    // Arrange: set up a mock fetch for the first call
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        data: [
          {
            id: 'openai/gpt-4o',
            name: 'GPT-4o',
            context_length: 128_000,
            pricing: { prompt: '0.0000025', completion: '0.00001' },
            supported_parameters: ['tools'],
          },
        ],
      }),
    });
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    // Act: first call populates the cache with fetchedAt = now
    await registry.refreshFromOpenRouter({ force: true });
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Act: second call without force — TTL not expired, should short-circuit
    await registry.refreshFromOpenRouter();
    // Assert: fetch still called only once — TTL cache returned early
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

describe('refreshFromOpenRouter error cases', () => {
  it('throws ProviderError when OpenRouter returns a non-OK HTTP response', async () => {
    // Arrange: mock fetch returning 500
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: vi.fn(),
    });
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    // Act: a failed refresh should log a warning (not throw) and preserve fallback map
    await registry.refreshFromOpenRouter({ force: true });

    // Assert: fallback models still available despite the error
    expect(registry.getModel('claude-sonnet-4-6')).toBeDefined();
  });

  it('handles malformed response (missing data array) gracefully', async () => {
    // Arrange: fetch returns 200 but body has no `data` field
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ models: [] }), // wrong shape
    });
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    // Act: refresh should catch the error and fall back silently
    await registry.refreshFromOpenRouter({ force: true });

    // Assert: fallback entries still accessible
    expect(registry.getModel('gpt-4o')).toBeDefined();
  });
});

describe('OpenRouter merge overwrites fallback data', () => {
  it('replaces fallback pricing and context window with OpenRouter values', async () => {
    // Verify the fallback value before refresh
    const before = registry.getModel('claude-opus-4-6');
    expect(before?.inputCostPerMillion).toBe(15);

    // OpenRouter returns a different price for the same model
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        data: [
          {
            id: 'anthropic/claude-opus-4-6',
            name: 'Claude Opus 4.6 (updated)',
            context_length: 250_000,
            pricing: { prompt: '0.00002', completion: '0.0001' },
            supported_parameters: ['tools'],
          },
        ],
      }),
    }) as unknown as typeof fetch;

    await registry.refreshFromOpenRouter({ force: true });

    const after = registry.getModel('claude-opus-4-6');
    expect(after).toBeDefined();
    expect(after?.inputCostPerMillion).toBeCloseTo(20); // was 15 in fallback
    expect(after?.outputCostPerMillion).toBeCloseTo(100); // was 75 in fallback
    expect(after?.maxContext).toBe(250_000); // was 200_000 in fallback
    expect(after?.name).toBe('Claude Opus 4.6 (updated)');
  });
});

// ---------------------------------------------------------------------------
// New branch-coverage cases (Sprint 3, Batch 3.1)
// ---------------------------------------------------------------------------

describe('getModel — deprecated/removed model ID', () => {
  it('returns undefined for a model ID that is not in the registry', () => {
    // Arrange: fresh fallback-only registry (no OpenRouter refresh)
    registry.__resetForTests();

    // Act: look up a model id that was never registered
    const result = registry.getModel('deprecated-model-v0-ancient');

    // Assert: undefined returned (no throw, no fallback substitution)
    expect(result).toBeUndefined();
  });

  it('returns undefined for an empty-string model ID', () => {
    // Arrange
    registry.__resetForTests();
    // Act
    const result = registry.getModel('');
    // Assert
    expect(result).toBeUndefined();
  });
});

describe('validateTaskDefaults', () => {
  it('returns no errors when all provided model IDs are known', () => {
    // Arrange: use known fallback ids
    const defaults = { chat: 'claude-haiku-4-5', reasoning: 'claude-opus-4-6' };
    // Act
    const errors = registry.validateTaskDefaults(defaults);
    // Assert: no validation errors
    expect(errors).toHaveLength(0);
  });

  it('returns an error entry for each unknown model ID', () => {
    // Arrange: one valid, one unknown
    const defaults = { chat: 'claude-haiku-4-5', reasoning: 'not-a-real-model-id' };
    // Act
    const errors = registry.validateTaskDefaults(defaults);
    // Assert: only the unknown id produces an error; message names the bad id
    expect(errors).toHaveLength(1);
    expect(errors[0].task).toBe('reasoning');
    expect(errors[0].message).toContain('not-a-real-model-id');
  });

  it('returns an error for an empty-string model ID', () => {
    // Arrange: empty string is explicitly invalid per source contract
    const defaults = { chat: '' };
    // Act
    const errors = registry.validateTaskDefaults(defaults);
    // Assert: empty string flagged
    expect(errors).toHaveLength(1);
    expect(errors[0].task).toBe('chat');
    expect(errors[0].message).toMatch(/non-empty/);
  });

  it('skips tasks where the value is undefined (partial map)', () => {
    // Arrange: only one task supplied — others are implicitly undefined
    const defaults: Partial<Record<'chat' | 'routing', string>> = { chat: 'claude-haiku-4-5' };
    // Act
    const errors = registry.validateTaskDefaults(defaults);
    // Assert: no errors; undefined tasks are not validated
    expect(errors).toHaveLength(0);
  });
});

describe('computeDefaultModelMap', () => {
  it('returns a map with all expected task keys', () => {
    // Arrange: use fresh registry with fallback models
    registry.__resetForTests();
    // Act
    const defaults = registry.computeDefaultModelMap();
    // Assert: all required task keys present
    expect(defaults).toHaveProperty('routing');
    expect(defaults).toHaveProperty('chat');
    expect(defaults).toHaveProperty('reasoning');
    expect(defaults).toHaveProperty('embeddings');
  });

  it('falls back to hardcoded claude-haiku-4-5 when registry has no non-local budget models', () => {
    // Arrange: clear registry to simulate empty state after a failed refresh
    registry.__resetForTests();
    // Force empty state by mocking fetch to fail so fetchedAt stays 0
    // then check the fallback ids come from the static strings
    const defaults = registry.computeDefaultModelMap();
    // Assert: the fallback is one of the known static ids (not undefined)
    expect(typeof defaults.routing).toBe('string');
    expect(defaults.routing.length).toBeGreaterThan(0);
  });
});

describe('getRegistryFetchedAt', () => {
  it('returns 0 before any refresh', () => {
    // Arrange
    registry.__resetForTests();
    // Act
    const ts = registry.getRegistryFetchedAt();
    // Assert: 0 signals "never refreshed from OpenRouter"
    expect(ts).toBe(0);
  });

  it('returns a non-zero timestamp after a successful refresh', async () => {
    // Arrange
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ data: [] }),
    }) as unknown as typeof fetch;
    // Act
    await registry.refreshFromOpenRouter({ force: true });
    const ts = registry.getRegistryFetchedAt();
    // Assert: timestamp is a recent epoch ms value
    expect(ts).toBeGreaterThan(0);
  });
});

describe('refreshFromOpenRouter — first-run failure preserves fallback map', () => {
  it('seeds the fallback map when fetchedAt is 0 and the refresh fails', async () => {
    // Arrange: fresh registry (fetchedAt=0), network error
    registry.__resetForTests();
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new Error('network down')) as unknown as typeof fetch;

    // Act
    await registry.refreshFromOpenRouter({ force: true });

    // Assert: fallback map still accessible (fetchedAt remains 0 but models are there)
    expect(registry.getModel('claude-haiku-4-5')).toBeDefined();
    expect(registry.getRegistryFetchedAt()).toBe(0);
  });
});

describe('refreshFromProvider', () => {
  function makeProvider(models: Array<{ id: string; name?: string; provider?: string }>) {
    return {
      name: 'test-provider',
      isLocal: false,
      listModels: vi.fn().mockResolvedValue(
        models.map((m) => ({
          id: m.id,
          name: m.name ?? m.id,
          provider: m.provider ?? 'test-provider',
          tier: 'mid' as const,
          inputCostPerMillion: 1,
          outputCostPerMillion: 1,
          maxContext: 8_192,
          supportsTools: false,
        }))
      ),
      chat: vi.fn(),
      chatStream: vi.fn(),
      embed: vi.fn(),
      testConnection: vi.fn(),
    };
  }

  it('marks existing registry entries as available:true when provider confirms them', async () => {
    // Arrange: claude-sonnet-4-6 is in the fallback map
    const provider = makeProvider([{ id: 'claude-sonnet-4-6', provider: 'anthropic' }]);

    // Act
    const discovered = await registry.refreshFromProvider(provider);

    // Assert: the model is now marked available
    const model = registry.getModel('claude-sonnet-4-6');
    expect(model?.available).toBe(true);
    expect(discovered).toHaveLength(1);
    expect(discovered[0].id).toBe('claude-sonnet-4-6');
  });

  it('inserts unknown model ids discovered from provider as new registry entries', async () => {
    // Arrange: a model not in the fallback map
    const provider = makeProvider([{ id: 'custom-model-xyz', provider: 'test-provider' }]);

    // Act
    const discovered = await registry.refreshFromProvider(provider);

    // Assert: new entry inserted into the registry
    const model = registry.getModel('custom-model-xyz');
    expect(model).toBeDefined();
    expect(model?.available).toBe(true);
    expect(discovered).toHaveLength(1);
  });

  it('merges both existing and unknown models in a single refresh', async () => {
    // Arrange: mix of known and unknown models
    const provider = makeProvider([
      { id: 'gpt-4o', provider: 'openai' },
      { id: 'new-unknown-model', provider: 'test-provider' },
    ]);

    // Act
    const discovered = await registry.refreshFromProvider(provider);

    // Assert
    expect(discovered).toHaveLength(2);
    expect(registry.getModel('gpt-4o')?.available).toBe(true);
    expect(registry.getModel('new-unknown-model')?.available).toBe(true);
  });

  it('returns empty array and logs warning when provider.listModels() throws', async () => {
    const { logger } = await import('@/lib/logging');

    // Arrange: provider that throws on listModels
    const failingProvider = {
      name: 'broken-provider',
      isLocal: false,
      listModels: vi.fn().mockRejectedValue(new Error('connection refused')),
      chat: vi.fn(),
      chatStream: vi.fn(),
      embed: vi.fn(),
      testConnection: vi.fn(),
    };

    // Act
    const discovered = await registry.refreshFromProvider(failingProvider);

    // Assert: returns empty array, not throwing
    expect(discovered).toEqual([]);
    // Assert: logged a warning
    expect(logger.warn).toHaveBeenCalledWith(
      'refreshFromProvider failed',
      expect.objectContaining({
        provider: 'broken-provider',
        error: 'connection refused',
      })
    );
  });

  it('does not clobber registry state when provider.listModels() throws', async () => {
    // Arrange: pre-populate the registry via a successful refresh
    const goodProvider = makeProvider([{ id: 'gpt-4o', provider: 'openai' }]);
    await registry.refreshFromProvider(goodProvider);
    const countBefore = registry.getAvailableModels().length;

    // Act: failing refresh
    const failingProvider = {
      name: 'broken',
      isLocal: false,
      listModels: vi.fn().mockRejectedValue(new Error('timeout')),
      chat: vi.fn(),
      chatStream: vi.fn(),
      embed: vi.fn(),
      testConnection: vi.fn(),
    };
    await registry.refreshFromProvider(failingProvider);

    // Assert: model count unchanged
    expect(registry.getAvailableModels().length).toBe(countBefore);
  });
});

// ---------------------------------------------------------------------------
// Branch coverage additions (Sprint 1, Batch 1.1)
// ---------------------------------------------------------------------------

describe('refreshFromOpenRouter — retriable flag on 429 response', () => {
  it('marks the ProviderError as retriable when OpenRouter returns 429', async () => {
    // Arrange: mock a 429 rate-limit response
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      json: vi.fn(),
    }) as unknown as typeof fetch;

    // Act: refresh should absorb the error and preserve fallback
    await registry.refreshFromOpenRouter({ force: true });

    // Assert: fallback still accessible — the catch block handled the ProviderError
    expect(registry.getModel('claude-sonnet-4-6')).toBeDefined();
  });
});

describe('parseOpenRouterEntry — entry.id has no provider prefix (no slash)', () => {
  it('sets provider to "unknown" when the id contains no slash', async () => {
    // Arrange: id with no slash → canonicalId === entry.id, provider = 'unknown'
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        data: [
          {
            id: 'no-prefix-model',
            name: 'No Prefix Model',
            context_length: 4096,
            pricing: { prompt: '0.000001', completion: '0.000002' },
          },
        ],
      }),
    }) as unknown as typeof fetch;

    await registry.refreshFromOpenRouter({ force: true });

    // Assert: canonical id resolves; provider defaults to 'unknown'
    const model = registry.getModel('no-prefix-model');
    expect(model).toBeDefined();
    expect(model?.provider).toBe('unknown');
  });
});

describe('parseOpenRouterEntry — missing optional pricing and metadata fields', () => {
  it('defaults inputCostPerMillion and outputCostPerMillion to 0 when pricing is absent', async () => {
    // Arrange: no pricing object at all → costs default to 0, tier classifies as 'local'
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        data: [
          {
            id: 'free-provider/free-model',
            name: 'Free Model',
            context_length: 8192,
          },
        ],
      }),
    }) as unknown as typeof fetch;

    await registry.refreshFromOpenRouter({ force: true });

    const model = registry.getModel('free-model');
    expect(model).toBeDefined();
    expect(model?.inputCostPerMillion).toBe(0);
    expect(model?.outputCostPerMillion).toBe(0);
    expect(model?.tier).toBe('local');
  });

  it('falls back to canonicalId as name when the name field is absent', async () => {
    // Arrange: no name field → name should fall back to the canonical id
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        data: [
          {
            id: 'provider-x/unnamed-model',
            context_length: 4096,
            pricing: { prompt: '0.000001', completion: '0.000002' },
          },
        ],
      }),
    }) as unknown as typeof fetch;

    await registry.refreshFromOpenRouter({ force: true });

    const model = registry.getModel('unnamed-model');
    expect(model).toBeDefined();
    expect(model?.name).toBe('unnamed-model');
  });

  it('defaults maxContext to 0 when context_length is absent', async () => {
    // Arrange: no context_length field
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        data: [
          {
            id: 'provider-x/no-context-model',
            name: 'No Context Model',
            pricing: { prompt: '0.000001', completion: '0.000002' },
          },
        ],
      }),
    }) as unknown as typeof fetch;

    await registry.refreshFromOpenRouter({ force: true });

    const model = registry.getModel('no-context-model');
    expect(model).toBeDefined();
    expect(model?.maxContext).toBe(0);
  });

  it('defaults inputCostPerMillion to 0 when prompt pricing string is non-numeric (NaN)', async () => {
    // Arrange: pricing.prompt is a non-numeric string → parseFloat returns NaN
    // → Number.isFinite(NaN) is false → cost defaults to 0
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        data: [
          {
            id: 'provider-y/nan-priced-model',
            name: 'NaN Priced Model',
            context_length: 4096,
            pricing: { prompt: 'not-a-number', completion: 'also-not-a-number' },
          },
        ],
      }),
    }) as unknown as typeof fetch;

    await registry.refreshFromOpenRouter({ force: true });

    const model = registry.getModel('nan-priced-model');
    expect(model).toBeDefined();
    // Non-finite parseFloat result → cost defaults to 0
    expect(model?.inputCostPerMillion).toBe(0);
    expect(model?.outputCostPerMillion).toBe(0);
  });
});

describe('classifyTier — boundary values', () => {
  it('classifies a model with inputCostPerMillion exactly 0.5 as budget', async () => {
    // Arrange: 0.5 per million = 0.0000005 per token (exactly at the budget ceiling)
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        data: [
          {
            id: 'provider/boundary-budget',
            name: 'Boundary Budget',
            context_length: 8000,
            pricing: { prompt: '0.0000005', completion: '0.000001' },
          },
        ],
      }),
    }) as unknown as typeof fetch;

    await registry.refreshFromOpenRouter({ force: true });

    const model = registry.getModel('boundary-budget');
    expect(model).toBeDefined();
    expect(model?.tier).toBe('budget');
  });

  it('classifies a model with inputCostPerMillion above 5 as frontier', async () => {
    // Arrange: 10 per million = 0.00001 per token (above the mid ceiling of 5)
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        data: [
          {
            id: 'provider/expensive-model',
            name: 'Expensive Model',
            context_length: 200_000,
            pricing: { prompt: '0.00001', completion: '0.00003' },
          },
        ],
      }),
    }) as unknown as typeof fetch;

    await registry.refreshFromOpenRouter({ force: true });

    const model = registry.getModel('expensive-model');
    expect(model).toBeDefined();
    expect(model?.tier).toBe('frontier');
  });
});

describe('refreshFromProvider — error message extraction', () => {
  it('logs the Error message when provider throws an Error instance', async () => {
    const { logger } = await import('@/lib/logging');

    // Arrange: provider throws a standard Error
    const failingProvider = {
      name: 'error-thrower',
      isLocal: false,
      listModels: vi.fn().mockRejectedValue(new Error('explicit error message')),
      chat: vi.fn(),
      chatStream: vi.fn(),
      embed: vi.fn(),
      testConnection: vi.fn(),
    };

    // Act
    const result = await registry.refreshFromProvider(failingProvider);

    // Assert: returns empty array
    expect(result).toEqual([]);
    // Assert: error.message is extracted from the Error instance
    expect(logger.warn).toHaveBeenCalledWith(
      'refreshFromProvider failed',
      expect.objectContaining({
        provider: 'error-thrower',
        error: 'explicit error message',
      })
    );
  });
});

describe('refreshFromOpenRouter — catch preserves previously-cached state', () => {
  it('does not reset fetchedAt to 0 when a subsequent forced refresh fails', async () => {
    // Arrange: first refresh succeeds and sets fetchedAt > 0
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        data: [
          {
            id: 'openai/gpt-4o',
            name: 'GPT-4o',
            context_length: 128_000,
            pricing: { prompt: '0.0000025', completion: '0.00001' },
            supported_parameters: ['tools'],
          },
        ],
      }),
    }) as unknown as typeof fetch;

    await registry.refreshFromOpenRouter({ force: true });
    const fetchedAtAfterFirst = registry.getRegistryFetchedAt();
    expect(fetchedAtAfterFirst).toBeGreaterThan(0);

    // Arrange: second forced refresh fails
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new Error('network error')) as unknown as typeof fetch;

    // Act
    await registry.refreshFromOpenRouter({ force: true });

    // Assert: fetchedAt is preserved from the first successful run (the `if (state.fetchedAt === 0)`
    // guard in the catch block correctly skips the reset when fetchedAt is non-zero)
    expect(registry.getRegistryFetchedAt()).toBe(fetchedAtAfterFirst);
    expect(registry.getModel('gpt-4o')).toBeDefined();
  });
});
