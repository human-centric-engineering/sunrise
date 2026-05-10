/**
 * Provider Manager — getAudioProvider() tests
 *
 * Covers:
 * - Returns null when no audio-capable model rows exist
 * - Picks first audio-capable row when multiple are seeded
 * - Skips providers whose breaker is open
 * - Skips providers that don't implement transcribe()
 * - Surface returned tuple includes provider, modelId, providerSlug
 *
 * @see lib/orchestration/llm/provider-manager.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiProviderConfig: {
      findFirst: vi.fn(),
    },
    aiProviderModel: {
      findMany: vi.fn(),
    },
  },
}));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

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
    public audio = { transcriptions: { create: vi.fn() } };
    constructor(_opts: unknown) {}
  }
  return { default: MockOpenAI, toFile: vi.fn() };
});

import { prisma } from '@/lib/db/client';
import {
  clearCache,
  getAudioProvider,
  registerProviderInstance,
} from '@/lib/orchestration/llm/provider-manager';
import { getBreaker, resetAllBreakers } from '@/lib/orchestration/llm/circuit-breaker';

beforeEach(() => {
  vi.clearAllMocks();
  resetAllBreakers();
  clearCache();
  process.env.OPENAI_API_KEY = 'test-key';
});

// Casts to `never` keep the Prisma row factories terse — the production
// types include 20+ fields per row and this test only exercises a handful.
function makeOpenAiConfigRow(): never {
  return {
    id: 'p-openai',
    name: 'OpenAI',
    slug: 'openai',
    providerType: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    apiKeyEnvVar: 'OPENAI_API_KEY',
    isLocal: false,
    isActive: true,
    metadata: null,
    timeoutMs: null,
    maxRetries: null,
    createdBy: 'u-1',
    createdAt: new Date(),
    updatedAt: new Date(),
  } as never;
}

function makeAudioModelRow(overrides: Record<string, unknown> = {}): never {
  return {
    id: 'm-whisper',
    slug: 'openai-whisper-1',
    providerSlug: 'openai',
    modelId: 'whisper-1',
    name: 'Whisper',
    description: '',
    capabilities: ['audio'],
    tierRole: 'worker',
    reasoningDepth: 'none',
    latency: 'fast',
    costEfficiency: 'high',
    contextLength: 'n_a',
    toolUse: 'none',
    bestRole: 'Speech-to-text',
    dimensions: null,
    schemaCompatible: null,
    costPerMillionTokens: null,
    hasFreeTier: null,
    local: false,
    quality: null,
    strengths: null,
    setup: null,
    isDefault: false,
    isActive: true,
    metadata: null,
    createdBy: 'u-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as never;
}

describe('getAudioProvider', () => {
  it('returns null when no audio-capable model rows exist', async () => {
    vi.mocked(prisma.aiProviderModel.findMany).mockResolvedValue([]);

    const result = await getAudioProvider();

    expect(result).toBeNull();
  });

  it('returns provider, modelId and providerSlug for the first audio-capable row', async () => {
    vi.mocked(prisma.aiProviderModel.findMany).mockResolvedValue([makeAudioModelRow()]);
    vi.mocked(prisma.aiProviderConfig.findFirst).mockResolvedValue(makeOpenAiConfigRow());

    const result = await getAudioProvider();

    expect(result).not.toBeNull();
    expect(result?.modelId).toBe('whisper-1');
    expect(result?.providerSlug).toBe('openai');
    expect(typeof result?.provider.transcribe).toBe('function');
  });

  it('queries `capabilities` for `has: "audio"` and orders by isDefault then createdAt', async () => {
    vi.mocked(prisma.aiProviderModel.findMany).mockResolvedValue([]);

    await getAudioProvider();

    const findManyArgs = vi.mocked(prisma.aiProviderModel.findMany).mock.calls[0]?.[0];
    expect(findManyArgs?.where).toEqual({
      isActive: true,
      capabilities: { has: 'audio' },
    });
    expect(findManyArgs?.orderBy).toEqual([{ isDefault: 'desc' }, { createdAt: 'asc' }]);
  });

  it('skips a row whose providerSlug has an open breaker, falling through to the next', async () => {
    vi.mocked(prisma.aiProviderModel.findMany).mockResolvedValue([
      makeAudioModelRow({ providerSlug: 'broken-provider', modelId: 'whisper-x' }),
      makeAudioModelRow({ providerSlug: 'openai', modelId: 'whisper-1' }),
    ]);
    vi.mocked(prisma.aiProviderConfig.findFirst).mockResolvedValue(makeOpenAiConfigRow());

    // Force the first slug's breaker open by recording enough failures.
    const breaker = getBreaker('broken-provider');
    for (let i = 0; i < 10; i++) breaker.recordFailure();
    expect(breaker.canAttempt()).toBe(false);

    const result = await getAudioProvider();

    expect(result?.providerSlug).toBe('openai');
    expect(result?.modelId).toBe('whisper-1');
  });

  it('returns null when every audio-capable row has an open breaker', async () => {
    vi.mocked(prisma.aiProviderModel.findMany).mockResolvedValue([
      makeAudioModelRow({ providerSlug: 'a' }),
      makeAudioModelRow({ providerSlug: 'b' }),
    ]);

    const ba = getBreaker('a');
    const bb = getBreaker('b');
    for (let i = 0; i < 10; i++) {
      ba.recordFailure();
      bb.recordFailure();
    }

    const result = await getAudioProvider();

    expect(result).toBeNull();
  });

  it('skips a row whose provider lookup throws and falls through to the next', async () => {
    vi.mocked(prisma.aiProviderModel.findMany).mockResolvedValue([
      makeAudioModelRow({ providerSlug: 'missing' }),
      makeAudioModelRow({ providerSlug: 'openai' }),
    ]);
    // First lookup returns nothing → ProviderError; second returns the openai config.
    vi.mocked(prisma.aiProviderConfig.findFirst)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(makeOpenAiConfigRow());

    const result = await getAudioProvider();

    expect(result?.providerSlug).toBe('openai');
  });

  it('skips a row whose provider lacks transcribe() and falls through to the next', async () => {
    vi.mocked(prisma.aiProviderModel.findMany).mockResolvedValue([
      makeAudioModelRow({ providerSlug: 'fake-no-audio' }),
      makeAudioModelRow({ providerSlug: 'openai' }),
    ]);
    vi.mocked(prisma.aiProviderConfig.findFirst).mockResolvedValue(makeOpenAiConfigRow());

    // Inject a fake provider for `fake-no-audio` that does NOT implement transcribe().
    registerProviderInstance('fake-no-audio', {
      name: 'fake-no-audio',
      isLocal: false,
      // Cast so we don't have to fill the entire interface — only `transcribe` matters here.
      chat: vi.fn(),
      chatStream: vi.fn(),
      embed: vi.fn(),
      listModels: vi.fn(),
      testConnection: vi.fn(),
    } as never);

    const result = await getAudioProvider();

    expect(result?.providerSlug).toBe('openai');
  });
});
