/**
 * Pricing History — unit tests
 *
 * Tests the data fetcher, parser, timeline lookup, and serialization.
 * Network calls are mocked via vi.stubGlobal('fetch').
 *
 * @see lib/orchestration/llm/pricing-history.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getPricingHistory,
  getModelTimeline,
  serialisePricingHistory,
  deserialisePricingHistory,
  __resetCacheForTests,
  type PricingHistoryData,
} from '@/lib/orchestration/llm/pricing-history';

// ─── Mocks ──────────────────────────────────────────────────────────────────────

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const MOCK_RESPONSE = {
  prices: [
    {
      id: 'claude-3-opus',
      vendor: 'anthropic',
      name: 'Claude 3 Opus',
      input: 15,
      output: 75,
      input_cached: null,
      from_date: '2024-03-04',
      to_date: '2025-02-24',
    },
    {
      id: 'claude-3-opus',
      vendor: 'anthropic',
      name: 'Claude 3 Opus',
      input: 15,
      output: 75,
      input_cached: 7.5,
      from_date: '2025-02-24',
      to_date: null,
    },
    {
      id: 'gpt-4o',
      vendor: 'openai',
      name: 'GPT-4o',
      input: 5,
      output: 15,
      input_cached: null,
      from_date: '2024-05-13',
      to_date: '2024-10-01',
    },
    {
      id: 'gpt-4o',
      vendor: 'openai',
      name: 'GPT-4o',
      input: 2.5,
      output: 10,
      input_cached: 1.25,
      from_date: '2024-10-01',
      to_date: null,
    },
  ],
};

function mockFetchSuccess() {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(MOCK_RESPONSE),
    })
  );
}

function mockFetchFailure() {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));
}

function mockFetch503() {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: () => Promise.resolve({}),
    })
  );
}

// ─── Tests ──────────────────────────────────────────────────────────────────────

describe('pricing-history', () => {
  beforeEach(() => {
    __resetCacheForTests();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('getPricingHistory', () => {
    it('fetches and parses data successfully', async () => {
      mockFetchSuccess();
      const result = await getPricingHistory({ force: true });

      expect(result.source).toBe('live');
      expect(result.fetchedAt).toBeGreaterThan(0);
      expect(result.timelines.size).toBe(2); // claude-3-opus + gpt-4o
    });

    it('returns fallback data on network failure', async () => {
      mockFetchFailure();
      const result = await getPricingHistory({ force: true });

      expect(result.source).toBe('fallback');
      expect(result.timelines.size).toBe(0);
    });

    it('returns fallback data on non-200 response', async () => {
      mockFetch503();
      const result = await getPricingHistory({ force: true });

      expect(result.source).toBe('fallback');
      expect(result.timelines.size).toBe(0);
    });

    it('uses cached data on subsequent calls', async () => {
      mockFetchSuccess();
      const first = await getPricingHistory({ force: true });
      const second = await getPricingHistory();

      expect(first).toBe(second);
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('re-fetches when force=true', async () => {
      mockFetchSuccess();
      await getPricingHistory({ force: true });
      await getPricingHistory({ force: true });

      expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('handles malformed response gracefully', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({ notPrices: [] }),
        })
      );
      const result = await getPricingHistory({ force: true });

      expect(result.source).toBe('fallback');
      expect(result.timelines.size).toBe(0);
    });
  });

  describe('timeline parsing', () => {
    it('groups entries by vendor/id', async () => {
      mockFetchSuccess();
      const result = await getPricingHistory({ force: true });

      expect(result.timelines.has('anthropic/claude-3-opus')).toBe(true);
      expect(result.timelines.has('openai/gpt-4o')).toBe(true);
    });

    it('sorts periods by fromDate ascending', async () => {
      mockFetchSuccess();
      const result = await getPricingHistory({ force: true });
      const opus = result.timelines.get('anthropic/claude-3-opus')!;

      expect(opus.periods[0].fromDate).toBe('2024-03-04');
      expect(opus.periods[1].fromDate).toBe('2025-02-24');
    });

    it('preserves all pricing fields', async () => {
      mockFetchSuccess();
      const result = await getPricingHistory({ force: true });
      const gpt4o = result.timelines.get('openai/gpt-4o')!;

      // First period
      expect(gpt4o.periods[0].input).toBe(5);
      expect(gpt4o.periods[0].output).toBe(15);
      expect(gpt4o.periods[0].inputCached).toBeNull();

      // Second period (price drop)
      expect(gpt4o.periods[1].input).toBe(2.5);
      expect(gpt4o.periods[1].output).toBe(10);
      expect(gpt4o.periods[1].inputCached).toBe(1.25);
    });
  });

  describe('getModelTimeline', () => {
    let data: PricingHistoryData;

    beforeEach(async () => {
      mockFetchSuccess();
      data = await getPricingHistory({ force: true });
    });

    it('finds by exact vendor/id', () => {
      const result = getModelTimeline(data, 'claude-3-opus', 'anthropic');
      expect(result).not.toBeNull();
      expect(result!.id).toBe('claude-3-opus');
    });

    it('finds by id-only without vendor', () => {
      const result = getModelTimeline(data, 'gpt-4o');
      expect(result).not.toBeNull();
      expect(result!.vendor).toBe('openai');
    });

    it('returns null for unknown model', () => {
      const result = getModelTimeline(data, 'nonexistent-model');
      expect(result).toBeNull();
    });

    it('returns null when data is empty (fallback)', () => {
      const emptyData: PricingHistoryData = {
        timelines: new Map(),
        fetchedAt: 0,
        source: 'fallback',
      };
      const result = getModelTimeline(emptyData, 'gpt-4o');
      expect(result).toBeNull();
    });

    it('finds family match for newer model version not in dataset', () => {
      // claude-opus-4-6 not in data, but claude-3-opus is (same family "claude-opus")
      const result = getModelTimeline(data, 'claude-opus-4-6', 'anthropic');
      expect(result).not.toBeNull();
      expect(result!.vendor).toBe('anthropic');
    });

    it('prefers exact match over family match', () => {
      const result = getModelTimeline(data, 'gpt-4o', 'openai');
      expect(result).not.toBeNull();
      expect(result!.id).toBe('gpt-4o');
    });
  });

  describe('serialise / deserialise', () => {
    it('round-trips correctly', async () => {
      mockFetchSuccess();
      const original = await getPricingHistory({ force: true });
      const serialized = serialisePricingHistory(original);
      const restored = deserialisePricingHistory(serialized);

      expect(restored.source).toBe(original.source);
      expect(restored.fetchedAt).toBe(original.fetchedAt);
      expect(restored.timelines.size).toBe(original.timelines.size);

      const opusOriginal = original.timelines.get('anthropic/claude-3-opus')!;
      const opusRestored = restored.timelines.get('anthropic/claude-3-opus')!;
      expect(opusRestored.periods).toEqual(opusOriginal.periods);
    });

    it('serializes to JSON-safe structure (no Maps)', async () => {
      mockFetchSuccess();
      const original = await getPricingHistory({ force: true });
      const serialized = serialisePricingHistory(original);

      // Should not throw when JSON.stringify'd
      const json = JSON.stringify(serialized);
      expect(json).toContain('claude-3-opus');
      expect(Array.isArray(serialized.timelines)).toBe(true);
    });
  });
});
