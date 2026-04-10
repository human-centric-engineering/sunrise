/**
 * Tests for provider-manager: caching, validation, and type dispatch.
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
const { AnthropicProvider } = await import('@/lib/orchestration/llm/anthropic');
const { OpenAiCompatibleProvider } = await import('@/lib/orchestration/llm/openai-compatible');
const { getProvider, clearCache, listProviders } =
  await import('@/lib/orchestration/llm/provider-manager');

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
    expect(list.every((p) => p.status === 'unknown')).toBe(true);
  });
});
