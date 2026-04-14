/**
 * Provider Manager — Voyage Provider Branch Tests
 *
 * Focused tests for the new 'voyage' providerType branches added to:
 *   - buildProviderFromConfig() — creates VoyageProvider from AiProviderConfig row
 *   - buildProviderFromInMemoryConfig() — creates VoyageProvider from in-memory config
 *
 * These tests augment the main provider-manager.test.ts suite and follow
 * the same mock patterns.
 *
 * @see lib/orchestration/llm/provider-manager.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock dependencies — identical setup to provider-manager.test.ts
// ---------------------------------------------------------------------------

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

// Anthropic and OpenAI SDKs refuse to instantiate in the vitest browser-like
// environment without dangerouslyAllowBrowser. Stub them out.
vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    public messages = { create: vi.fn() };
    constructor(_opts: unknown) {}
  }
  return { default: MockAnthropic };
});

vi.mock('openai', () => {
  class MockOpenAI {
    public chat = { completions: { create: vi.fn() } };
    public embeddings = { create: vi.fn() };
    public models = { list: vi.fn() };
    constructor(_opts: unknown) {}
  }
  return { default: MockOpenAI };
});

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

const { prisma } = await import('@/lib/db/client');
const { VoyageProvider } = await import('@/lib/orchestration/llm/voyage');
const { getProvider, clearCache, registerProvider } =
  await import('@/lib/orchestration/llm/provider-manager');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'p1',
    name: 'Voyage AI',
    slug: 'voyage',
    providerType: 'voyage',
    baseUrl: null,
    apiKeyEnvVar: 'VOYAGE_API_KEY',
    isLocal: false,
    isActive: true,
    metadata: null,
    createdAt: new Date(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildProviderFromConfig — voyage branch
// ---------------------------------------------------------------------------

describe('buildProviderFromConfig() — voyage providerType', () => {
  beforeEach(() => {
    clearCache();
    vi.clearAllMocks();
    process.env['VOYAGE_API_KEY'] = 'voy-test-key';
  });

  it('should build a VoyageProvider when providerType is "voyage"', async () => {
    // Arrange
    vi.mocked(prisma.aiProviderConfig.findFirst).mockResolvedValue(makeRow() as never);

    // Act
    const provider = await getProvider('voyage');

    // Assert
    expect(provider).toBeInstanceOf(VoyageProvider);
  });

  it('should set the provider name from the config row', async () => {
    // Arrange
    vi.mocked(prisma.aiProviderConfig.findFirst).mockResolvedValue(
      makeRow({ name: 'My Voyage Instance' }) as never
    );

    // Act
    const provider = await getProvider('voyage');

    // Assert
    expect(provider.name).toBe('My Voyage Instance');
  });

  it('should throw ProviderError with code missing_api_key when apiKeyEnvVar env value is absent', async () => {
    // Arrange: ensure the env var is not set
    delete process.env['VOYAGE_API_KEY'];
    vi.mocked(prisma.aiProviderConfig.findFirst).mockResolvedValue(makeRow() as never);

    // Act + Assert
    await expect(getProvider('voyage')).rejects.toMatchObject({
      code: 'missing_api_key',
    });
  });

  it('should cache the VoyageProvider instance after first build', async () => {
    // Arrange
    const findFirst = vi.mocked(prisma.aiProviderConfig.findFirst);
    findFirst.mockResolvedValue(makeRow() as never);

    // Act
    const a = await getProvider('voyage');
    const b = await getProvider('voyage');

    // Assert: same instance, DB queried only once
    expect(a).toBe(b);
    expect(findFirst).toHaveBeenCalledTimes(1);
  });

  it('should pass the custom baseUrl to VoyageProvider when set in the config', async () => {
    // Arrange: Voyage with a custom endpoint
    vi.mocked(prisma.aiProviderConfig.findFirst).mockResolvedValue(
      makeRow({ baseUrl: 'https://custom.voyageai.com/v1' }) as never
    );

    // Act: just verify it does not throw and produces a VoyageProvider
    const provider = await getProvider('voyage');

    // Assert
    expect(provider).toBeInstanceOf(VoyageProvider);
  });

  it('should remain isLocal: false for Voyage providers', async () => {
    // Arrange
    vi.mocked(prisma.aiProviderConfig.findFirst).mockResolvedValue(makeRow() as never);

    // Act
    const provider = await getProvider('voyage');

    // Assert: Voyage is always a cloud provider
    expect(provider.isLocal).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildProviderFromInMemoryConfig — voyage branch
// ---------------------------------------------------------------------------

describe('buildProviderFromInMemoryConfig() — type voyage', () => {
  beforeEach(() => {
    clearCache();
    vi.clearAllMocks();
  });

  it('should build a VoyageProvider for type="voyage"', () => {
    // Arrange
    const config = {
      name: 'voyage-in-memory',
      type: 'voyage' as const,
      apiKey: 'voy-test-key',
      isLocal: false,
    };

    // Act
    const provider = registerProvider(config);

    // Assert
    expect(provider).toBeInstanceOf(VoyageProvider);
  });

  it('should set provider name from in-memory config', () => {
    // Arrange
    const config = {
      name: 'my-voyage',
      type: 'voyage' as const,
      apiKey: 'voy-key',
      isLocal: false,
    };

    // Act
    const provider = registerProvider(config);

    // Assert
    expect(provider.name).toBe('my-voyage');
  });

  it('should throw ProviderError with missing_api_key when apiKey is absent', () => {
    // Arrange: no apiKey
    const config = {
      name: 'voyage-no-key',
      type: 'voyage' as const,
      isLocal: false,
    };

    // Act + Assert
    expect(() => registerProvider(config)).toThrow(
      expect.objectContaining({ code: 'missing_api_key' })
    );
  });

  it('should cache the VoyageProvider under config.name for later retrieval', async () => {
    // Arrange
    const config = {
      name: 'cached-voyage',
      type: 'voyage' as const,
      apiKey: 'voy-key',
      isLocal: false,
    };

    // Act
    const registered = registerProvider(config);
    const retrieved = await getProvider('cached-voyage');

    // Assert: same instance, no DB lookup needed
    expect(retrieved).toBe(registered);
    expect(prisma.aiProviderConfig.findFirst).not.toHaveBeenCalled();
  });

  it('should produce a provider with isLocal: false', () => {
    // Arrange
    const config = {
      name: 'voyage-cloud',
      type: 'voyage' as const,
      apiKey: 'voy-key',
      isLocal: false,
    };

    // Act
    const provider = registerProvider(config);

    // Assert
    expect(provider.isLocal).toBe(false);
  });

  it('should accept optional baseUrl in in-memory config without throwing', () => {
    // Arrange
    const config = {
      name: 'voyage-custom-url',
      type: 'voyage' as const,
      apiKey: 'voy-key',
      baseUrl: 'https://custom.voyageai.com/v1',
      isLocal: false,
    };

    // Act + Assert: should not throw
    expect(() => registerProvider(config)).not.toThrow();
    const provider = registerProvider(config);
    expect(provider).toBeInstanceOf(VoyageProvider);
  });
});
