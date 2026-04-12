/**
 * Tests for provider fallback resolution and circuit breaker integration.
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

import { prisma } from '@/lib/db/client';
import { getProviderWithFallbacks, clearCache } from '@/lib/orchestration/llm/provider-manager';
import { getBreaker, resetAllBreakers } from '@/lib/orchestration/llm/circuit-breaker';

const mockFindFirst = vi.mocked(prisma.aiProviderConfig.findFirst);

function makeConfig(slug: string) {
  return {
    id: `id-${slug}`,
    slug,
    name: slug,
    providerType: 'anthropic',
    baseUrl: null,
    apiKeyEnvVar: 'ANTHROPIC_API_KEY',
    isLocal: false,
    isActive: true,
    metadata: null,
    createdBy: 'user-1',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('getProviderWithFallbacks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearCache();
    resetAllBreakers();
    // Set env var so provider construction succeeds
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });

  it('returns primary provider when healthy', async () => {
    mockFindFirst.mockResolvedValue(makeConfig('primary'));

    const { usedSlug } = await getProviderWithFallbacks('primary', ['fallback-1']);
    expect(usedSlug).toBe('primary');
  });

  it('falls back when primary circuit breaker is open', async () => {
    // Trip primary breaker
    const breaker = getBreaker('primary', {
      failureThreshold: 2,
      windowMs: 60_000,
      cooldownMs: 60_000,
    });
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.state).toBe('open');

    mockFindFirst.mockResolvedValue(makeConfig('fallback-1'));

    const { usedSlug } = await getProviderWithFallbacks('primary', ['fallback-1']);
    expect(usedSlug).toBe('fallback-1');
  });

  it('throws when all providers exhausted', async () => {
    // Trip all breakers
    const b1 = getBreaker('primary', { failureThreshold: 1, windowMs: 60_000, cooldownMs: 60_000 });
    b1.recordFailure();
    const b2 = getBreaker('fallback-1', {
      failureThreshold: 1,
      windowMs: 60_000,
      cooldownMs: 60_000,
    });
    b2.recordFailure();

    await expect(getProviderWithFallbacks('primary', ['fallback-1'])).rejects.toThrow(
      'All providers are unavailable'
    );
  });

  it('skips provider not found and tries next', async () => {
    // Primary exists but is not found in DB
    mockFindFirst
      .mockResolvedValueOnce(null) // primary not found
      .mockResolvedValue(makeConfig('fallback-1'));

    const { usedSlug } = await getProviderWithFallbacks('primary', ['fallback-1']);
    expect(usedSlug).toBe('fallback-1');
  });

  it('circuit breaker records success correctly', () => {
    const breaker = getBreaker('test-slug');
    breaker.recordFailure();
    breaker.recordSuccess();
    expect(breaker.state).toBe('closed');
  });

  it('circuit breaker records failure correctly', () => {
    const breaker = getBreaker('test-slug-2', {
      failureThreshold: 2,
      windowMs: 60_000,
      cooldownMs: 60_000,
    });
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.state).toBe('open');
    expect(breaker.canAttempt()).toBe(false);
  });
});
