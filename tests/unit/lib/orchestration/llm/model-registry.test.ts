/**
 * Tests for the dynamic model registry.
 *
 * Covers fallback behaviour when OpenRouter is unreachable, response
 * parsing + tier classification, accessor filters, and in-flight
 * refresh deduplication.
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
