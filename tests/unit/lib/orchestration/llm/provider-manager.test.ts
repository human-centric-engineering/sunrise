/**
 * Tests for provider-manager: caching, validation, type dispatch,
 * registerProvider (in-memory config), clearCache (single-slug eviction),
 * testProvider delegation, resolveApiKey warn path, and registerProviderInstance.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiProviderConfig: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
  },
}));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Mock SDKs — vitest runs under a browser-like env in this repo and both
// SDKs refuse to instantiate there without `dangerouslyAllowBrowser`.
vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    public messages = { create: vi.fn() };
    constructor(_opts: unknown) {}
  }
  return { default: MockAnthropic };
});

vi.mock('@/lib/orchestration/webhooks/dispatcher', () => ({
  dispatchWebhookEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('openai', () => {
  class MockOpenAI {
    public chat = { completions: { create: vi.fn() } };
    public embeddings = { create: vi.fn() };
    public models = { list: vi.fn() };
    constructor(_opts: unknown) {}
  }
  return { default: MockOpenAI };
});

const { prisma } = await import('@/lib/db/client');
const { logger } = await import('@/lib/logging');
const { AnthropicProvider } = await import('@/lib/orchestration/llm/anthropic');
const { OpenAiCompatibleProvider } = await import('@/lib/orchestration/llm/openai-compatible');
const {
  getProvider,
  clearCache,
  listProviders,
  listProvidersWithStatus,
  isApiKeyEnvVarSet,
  registerProvider,
  registerProviderInstance,
  testProvider,
  getProviderWithFallbacks,
} = await import('@/lib/orchestration/llm/provider-manager');

const { getBreaker, resetAllBreakers } = await import('@/lib/orchestration/llm/circuit-breaker');

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'p1',
    name: 'Anthropic',
    slug: 'anthropic',
    providerType: 'anthropic',
    baseUrl: null,
    apiKeyEnvVar: 'ANTHROPIC_API_KEY',
    isLocal: false,
    isActive: true,
    metadata: null,
    createdAt: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  clearCache();
  resetAllBreakers();
  vi.clearAllMocks();
  process.env.ANTHROPIC_API_KEY = 'test-key';
  process.env.OPENAI_API_KEY = 'test-key';
});

describe('getProvider', () => {
  it('builds AnthropicProvider for providerType=anthropic', async () => {
    (prisma.aiProviderConfig.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(makeRow());
    const provider = await getProvider('anthropic');
    expect(provider).toBeInstanceOf(AnthropicProvider);
  });

  it('throws unsafe_base_url with retriable=false when SSRF guard rejects baseUrl (RFC1918 private range)', async () => {
    // Arrange: a DB row that passed Zod at write-time but contains a private-range
    // baseUrl — simulates a direct DB write or a PATCH that flipped isLocal without
    // re-validating the URL. Defense-in-depth re-check in buildProviderFromConfig
    // must catch it.
    (prisma.aiProviderConfig.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeRow({
        name: 'Bad OpenAI',
        slug: 'bad-openai',
        providerType: 'openai-compatible',
        baseUrl: 'http://10.0.0.1/v1',
        apiKeyEnvVar: 'OPENAI_API_KEY',
        isLocal: false,
      })
    );

    // Act + Assert
    await expect(getProvider('bad-openai')).rejects.toMatchObject({
      code: 'unsafe_base_url',
      retriable: false,
    });
    // Defense-in-depth path must also log the rejection
    expect(logger.error).toHaveBeenCalledWith(
      'Provider baseUrl rejected by SSRF guard at build time',
      expect.objectContaining({ provider: 'bad-openai' })
    );
  });

  it('throws unsafe_base_url for AWS link-local metadata endpoint (169.254.169.254)', async () => {
    // Arrange: cloud-metadata IP — always blocked regardless of isLocal flag
    (prisma.aiProviderConfig.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeRow({
        name: 'AWS Meta',
        slug: 'aws-meta',
        providerType: 'openai-compatible',
        baseUrl: 'http://169.254.169.254/v1',
        apiKeyEnvVar: 'OPENAI_API_KEY',
        isLocal: false,
      })
    );

    await expect(getProvider('aws-meta')).rejects.toMatchObject({
      code: 'unsafe_base_url',
      retriable: false,
    });
  });

  it('throws missing_api_key for openai-compatible when isLocal=false and env var is unset', async () => {
    // Arrange: safe public baseUrl, non-local, but apiKeyEnvVar not in process.env
    delete process.env.OPENAI_API_KEY;
    (prisma.aiProviderConfig.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeRow({
        name: 'OpenAI',
        slug: 'openai',
        providerType: 'openai-compatible',
        baseUrl: 'https://api.openai.com/v1',
        apiKeyEnvVar: 'OPENAI_API_KEY',
        isLocal: false,
      })
    );

    await expect(getProvider('openai')).rejects.toMatchObject({
      code: 'missing_api_key',
      retriable: false,
    });
  });

  it('throws unknown_provider_type with retriable=false for an unrecognised providerType', async () => {
    // Arrange: a row with a providerType that did not exist when this code was
    // compiled — e.g. a future migration that adds a new flavor before the
    // factory switch-chain is updated.
    (prisma.aiProviderConfig.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeRow({
        providerType: 'totally-made-up',
      })
    );

    await expect(getProvider('anthropic')).rejects.toMatchObject({
      code: 'unknown_provider_type',
      retriable: false,
    });
  });

  it('builds OpenAiCompatibleProvider for providerType=openai-compatible', async () => {
    (prisma.aiProviderConfig.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeRow({
        name: 'Ollama',
        slug: 'ollama',
        providerType: 'openai-compatible',
        baseUrl: 'http://localhost:11434/v1',
        apiKeyEnvVar: null,
        isLocal: true,
      })
    );
    const provider = await getProvider('ollama');
    expect(provider).toBeInstanceOf(OpenAiCompatibleProvider);
  });

  it('caches instances by slug across calls', async () => {
    const find = prisma.aiProviderConfig.findFirst as ReturnType<typeof vi.fn>;
    find.mockResolvedValue(makeRow());
    const a = await getProvider('anthropic');
    const b = await getProvider('anthropic');
    expect(a).toBe(b);
    expect(find).toHaveBeenCalledTimes(1);
  });

  it('re-fetches provider after cache TTL expires', async () => {
    const find = prisma.aiProviderConfig.findFirst as ReturnType<typeof vi.fn>;
    find.mockResolvedValue(makeRow());

    const a = await getProvider('anthropic');
    expect(find).toHaveBeenCalledTimes(1);

    // Advance time past the 5-minute TTL
    vi.useFakeTimers();
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);

    find.mockResolvedValue(makeRow());
    const b = await getProvider('anthropic');
    expect(find).toHaveBeenCalledTimes(2);
    // New instance since cache was stale
    expect(b).not.toBe(a);

    vi.useRealTimers();
  });

  it('throws ProviderError when not found', async () => {
    (prisma.aiProviderConfig.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    await expect(getProvider('missing')).rejects.toMatchObject({ code: 'provider_not_found' });
  });

  it('throws ProviderError when disabled', async () => {
    (prisma.aiProviderConfig.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeRow({ isActive: false })
    );
    await expect(getProvider('anthropic')).rejects.toMatchObject({ code: 'provider_disabled' });
  });

  it('throws when required env var is missing', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    (prisma.aiProviderConfig.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(makeRow());
    await expect(getProvider('anthropic')).rejects.toMatchObject({ code: 'missing_api_key' });
  });

  it('throws when openai-compatible has no baseUrl', async () => {
    (prisma.aiProviderConfig.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeRow({
        providerType: 'openai-compatible',
        baseUrl: null,
        isLocal: false,
        apiKeyEnvVar: 'OPENAI_API_KEY',
      })
    );
    await expect(getProvider('anthropic')).rejects.toMatchObject({ code: 'missing_base_url' });
  });
});

describe('listProviders', () => {
  it('returns every row with status=unknown by default', async () => {
    (prisma.aiProviderConfig.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeRow(),
      makeRow({ id: 'p2', slug: 'ollama', providerType: 'openai-compatible' }),
    ]);
    const list = await listProviders();
    expect(list).toHaveLength(2);
    // test-review:accept tobe_true — `.every()` returns a boolean; `.toBe(true)` is the only idiomatic assertion here. Using `.toEqual(true)` would be equivalent but more surprising to readers. The predicate is narrow enough that a false-positive is not a realistic concern.
    expect(list.every((p) => p.status === 'unknown')).toBe(true);
  });
});

describe('registerProvider (in-memory config)', () => {
  it('builds AnthropicProvider for type=anthropic', () => {
    // Arrange
    const config = {
      name: 'my-anthropic',
      type: 'anthropic' as const,
      apiKey: 'sk-test',
      isLocal: false,
    };

    // Act
    const provider = registerProvider(config);

    // Assert
    expect(provider).toBeInstanceOf(AnthropicProvider);
    expect(provider.name).toBe('my-anthropic');
  });

  it('builds OpenAiCompatibleProvider for type=openai using default baseUrl', () => {
    // Arrange: no baseUrl supplied — should fall back to api.openai.com
    const config = {
      name: 'my-openai',
      type: 'openai' as const,
      apiKey: 'sk-test',
      isLocal: false,
    };

    // Act
    const provider = registerProvider(config);

    // Assert: OpenAI type resolves without baseUrl
    expect(provider).toBeInstanceOf(OpenAiCompatibleProvider);
    expect(provider.name).toBe('my-openai');
  });

  it('throws missing_base_url for type=openai-compatible without baseUrl', () => {
    // Arrange
    const config = {
      name: 'bad-compat',
      type: 'openai-compatible' as const,
      isLocal: false,
    };

    // Act + Assert
    expect(() => registerProvider(config)).toThrow(
      expect.objectContaining({ code: 'missing_base_url' })
    );
  });

  it('passes timeoutMs and maxRetries through to OpenAiCompatibleProvider', () => {
    // Arrange
    const config = {
      name: 'openai-custom',
      type: 'openai' as const,
      apiKey: 'key',
      isLocal: false,
      timeoutMs: 5_000,
      maxRetries: 1,
    };

    // Act: should not throw and returns a provider
    const provider = registerProvider(config);

    // Assert: provider was created with the custom settings (we can only observe it was built)
    expect(provider).toBeInstanceOf(OpenAiCompatibleProvider);
  });

  it('omits apiKey from OpenAiCompatibleProvider config when undefined', () => {
    // Arrange: local provider with no key
    const config = {
      name: 'local-ollama',
      type: 'openai-compatible' as const,
      baseUrl: 'http://localhost:11434/v1',
      isLocal: true,
    };

    // Act: should not throw
    const provider = registerProvider(config);

    // Assert
    expect(provider).toBeInstanceOf(OpenAiCompatibleProvider);
  });

  it('caches the instance under config.name for later retrieval via getProvider', async () => {
    // Arrange
    const config = {
      name: 'cached-openai',
      type: 'openai' as const,
      apiKey: 'sk-test',
      isLocal: false,
    };

    // Act
    const registered = registerProvider(config);
    const retrieved = await getProvider('cached-openai');

    // Assert: same instance returned without DB lookup
    expect(retrieved).toBe(registered);
    expect(prisma.aiProviderConfig.findFirst).not.toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ OR: [{ slug: 'cached-openai' }] }),
      })
    );
  });
});

describe('clearCache (targeted single-slug eviction)', () => {
  it('evicts only the specified slug, leaving others intact', async () => {
    // Arrange: register two in-memory providers
    const providerA = registerProvider({
      name: 'provider-a',
      type: 'openai' as const,
      apiKey: 'key-a',
      isLocal: false,
    });
    const providerB = registerProvider({
      name: 'provider-b',
      type: 'openai' as const,
      apiKey: 'key-b',
      isLocal: false,
    });

    // Verify both are cached
    expect(await getProvider('provider-a')).toBe(providerA);
    expect(await getProvider('provider-b')).toBe(providerB);

    // Act: evict only provider-a
    clearCache('provider-a');

    // Assert: provider-b still in cache (no DB call needed)
    expect(await getProvider('provider-b')).toBe(providerB);

    // Assert: provider-a evicted — getProvider will fall through to DB
    (prisma.aiProviderConfig.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    await expect(getProvider('provider-a')).rejects.toMatchObject({ code: 'provider_not_found' });
  });
});

describe('testProvider', () => {
  it('delegates to provider.testConnection() and returns its result', async () => {
    // Arrange: register a mock provider instance
    const mockResult = { ok: true, models: ['gpt-4o'] };
    const mockInstance = {
      name: 'test-conn-provider',
      isLocal: false,
      testConnection: vi.fn().mockResolvedValue(mockResult),
      chat: vi.fn(),
      chatStream: vi.fn(),
      embed: vi.fn(),
      listModels: vi.fn(),
    };
    registerProviderInstance('test-conn-provider', mockInstance);

    // Act
    const result = await testProvider('test-conn-provider');

    // Assert: delegated to testConnection and returned the result
    expect(result).toBe(mockResult);
    expect(mockInstance.testConnection).toHaveBeenCalledTimes(1);
  });
});

describe('registerProviderInstance', () => {
  it('injects a pre-built instance retrievable via getProvider', async () => {
    // Arrange: create a minimal provider-like object
    const fakeProvider = {
      name: 'injected-provider',
      isLocal: true,
      chat: vi.fn(),
      chatStream: vi.fn(),
      embed: vi.fn(),
      listModels: vi.fn(),
      testConnection: vi.fn(),
    };

    // Act
    registerProviderInstance('injected-provider', fakeProvider);
    const retrieved = await getProvider('injected-provider');

    // Assert: exact same object, no DB lookup
    expect(retrieved).toBe(fakeProvider);
    expect(prisma.aiProviderConfig.findFirst).not.toHaveBeenCalled();
  });
});

describe('resolveApiKey warn path', () => {
  it('logs a warning and returns undefined when apiKeyEnvVar is set but env value is empty string', async () => {
    // Arrange: set env var to empty string
    process.env.EMPTY_KEY_VAR = '';
    const row = makeRow({
      apiKeyEnvVar: 'EMPTY_KEY_VAR',
      providerType: 'anthropic',
    });
    (prisma.aiProviderConfig.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(row);

    // Act: getProvider should throw missing_api_key (since resolveApiKey returns undefined for empty)
    // but the important side-effect is that logger.warn was called
    await expect(getProvider('anthropic')).rejects.toMatchObject({ code: 'missing_api_key' });

    // Assert: warned about the empty env var
    expect(logger.warn).toHaveBeenCalledWith(
      'Provider apiKeyEnvVar is set but process.env value is empty',
      expect.objectContaining({
        provider: row.slug,
        envVar: 'EMPTY_KEY_VAR',
      })
    );

    // Cleanup
    delete process.env.EMPTY_KEY_VAR;
  });
});

describe('isApiKeyEnvVarSet', () => {
  it('returns false when the env var name is null', () => {
    expect(isApiKeyEnvVarSet(null)).toBe(false);
  });

  it('returns false when the env var is unset', () => {
    delete process.env.SOME_UNSET_KEY;
    expect(isApiKeyEnvVarSet('SOME_UNSET_KEY')).toBe(false);
  });

  it('returns false when the env var is empty', () => {
    process.env.EMPTY_KEY = '';
    expect(isApiKeyEnvVarSet('EMPTY_KEY')).toBe(false);
  });

  it('returns true when the env var is set to a non-empty string', () => {
    process.env.FILLED_KEY = 'some-secret-value';
    expect(isApiKeyEnvVarSet('FILLED_KEY')).toBe(true);
  });
});

describe('getProviderWithFallbacks', () => {
  it('throws all_providers_exhausted when every candidate is unavailable', async () => {
    // Arrange: both primary and fallback are not in cache and not in DB
    (prisma.aiProviderConfig.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    // Act + Assert
    await expect(getProviderWithFallbacks('primary-slug', ['fallback-slug'])).rejects.toMatchObject(
      {
        code: 'all_providers_exhausted',
        retriable: true,
      }
    );
  });

  it('skips a provider whose circuit breaker is open and throws all_providers_exhausted when no candidates remain', async () => {
    // Arrange: trip the circuit breaker on primary by recording enough failures
    const breaker = getBreaker('cb-primary', {
      failureThreshold: 1,
      windowMs: 60_000,
      cooldownMs: 60_000,
    });
    breaker.recordFailure(); // threshold=1 → now open

    // DB is not reached for the open-breaker slot; fallback is also absent
    (prisma.aiProviderConfig.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    // Act + Assert: primary skipped (breaker open), fallback not found → exhausted
    await expect(getProviderWithFallbacks('cb-primary', ['cb-fallback'])).rejects.toMatchObject({
      code: 'all_providers_exhausted',
      retriable: true,
    });

    // The primary was never asked to resolve because the breaker was open
    expect(prisma.aiProviderConfig.findFirst).not.toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ OR: expect.arrayContaining([{ slug: 'cb-primary' }]) }),
      })
    );
  });

  it('returns the fallback provider when primary circuit breaker is open', async () => {
    // Arrange: trip the circuit breaker on primary
    const breaker = getBreaker('cb-primary-2', {
      failureThreshold: 1,
      windowMs: 60_000,
      cooldownMs: 60_000,
    });
    breaker.recordFailure(); // open

    // Register a working fallback in-memory (no DB needed)
    const fallbackProvider = {
      name: 'cb-fallback-2',
      isLocal: false,
      chat: vi.fn(),
      chatStream: vi.fn(),
      embed: vi.fn(),
      listModels: vi.fn(),
      testConnection: vi.fn(),
    };
    registerProviderInstance('cb-fallback-2', fallbackProvider);

    // Act
    const { provider, usedSlug } = await getProviderWithFallbacks('cb-primary-2', [
      'cb-fallback-2',
    ]);

    // Assert: fallback was used
    expect(usedSlug).toBe('cb-fallback-2');
    expect(provider).toBe(fallbackProvider);
    // DB was not consulted (both providers resolved from cache/in-memory)
    expect(prisma.aiProviderConfig.findFirst).not.toHaveBeenCalled();
  });
});

describe('listProvidersWithStatus', () => {
  it('hydrates each row with apiKeyPresent and status=unknown', async () => {
    process.env.ANTHROPIC_API_KEY = 'real-key';
    delete process.env.OLLAMA_API_KEY;
    (prisma.aiProviderConfig.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeRow({ slug: 'anthropic', apiKeyEnvVar: 'ANTHROPIC_API_KEY' }),
      makeRow({
        id: 'p2',
        slug: 'ollama',
        providerType: 'openai-compatible',
        apiKeyEnvVar: 'OLLAMA_API_KEY',
        baseUrl: 'http://localhost:11434/v1',
      }),
      makeRow({ id: 'p3', slug: 'local', apiKeyEnvVar: null }),
    ]);

    const rows = await listProvidersWithStatus();
    expect(rows).toHaveLength(3);
    // test-review:accept tobe_true — structural assertion on apiKeyPresent boolean field of ProviderStatusRow
    expect(rows[0]?.apiKeyPresent).toBe(true);
    expect(rows[0]?.status).toBe('unknown');
    expect(rows[1]?.apiKeyPresent).toBe(false);
    expect(rows[2]?.apiKeyPresent).toBe(false);
  });

  it('never exposes the env var value — apiKeyPresent is a boolean, not the raw secret', async () => {
    // Arrange: env var is set to a known secret value
    process.env.SECRET_THING = 'super-secret-value-do-not-leak';
    (prisma.aiProviderConfig.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeRow({ apiKeyEnvVar: 'SECRET_THING' }),
    ]);

    // Act
    const rows = await listProvidersWithStatus();

    // Assert: the returned object carries only a boolean presence flag,
    // not the raw env-var string. Checking the concrete type and value of
    // apiKeyPresent ensures this test fails if the implementation were ever
    // changed to return the raw key (or any other truthy non-boolean).
    expect(rows).toHaveLength(1);
    expect(typeof rows[0]?.apiKeyPresent).toBe('boolean');
    // test-review:accept tobe_true — structural assertion on apiKeyPresent boolean field; test above verifies type
    expect(rows[0]?.apiKeyPresent).toBe(true);
    // Verify the raw secret does not appear anywhere in the serialized output
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain('super-secret-value-do-not-leak');

    // Cleanup
    delete process.env.SECRET_THING;
  });
});
