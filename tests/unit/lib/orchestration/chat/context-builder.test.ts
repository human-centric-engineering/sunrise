/**
 * Tests for the context-builder TTL cache and LOCKED CONTEXT framing.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/orchestration/knowledge/search', () => ({
  getPatternDetail: vi.fn(),
}));

const { getPatternDetail } = await import('@/lib/orchestration/knowledge/search');
const { logger } = await import('@/lib/logging');
const { buildContext, invalidateContext, clearContextCache } =
  await import('@/lib/orchestration/chat/context-builder');

const getPatternDetailMock = getPatternDetail as ReturnType<typeof vi.fn>;
const loggerWarn = logger.warn as ReturnType<typeof vi.fn>;

function patternFixture(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    patternName: 'ReAct',
    chunks: [
      {
        id: 'c1',
        content: 'Reasoning plus acting is a reflex loop.',
        section: 'overview',
      },
      {
        id: 'c2',
        content: 'Alternate thinking with environment interaction.',
        section: 'details',
      },
    ],
    totalTokens: 42,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearContextCache();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('buildContext', () => {
  it('frames the pattern body with LOCKED CONTEXT markers', async () => {
    getPatternDetailMock.mockResolvedValueOnce(patternFixture());

    const result = await buildContext('pattern', '1');

    expect(result).toContain('=== LOCKED CONTEXT ===');
    expect(result).toContain('type: pattern');
    expect(result).toContain('id: 1');
    expect(result).toContain('Pattern #1: ReAct');
    expect(result).toContain('## overview');
    expect(result).toContain('Reasoning plus acting is a reflex loop.');
    expect(result).toContain('=== END LOCKED CONTEXT ===');
  });

  it('caches subsequent calls for the same entity', async () => {
    getPatternDetailMock.mockResolvedValueOnce(patternFixture());

    const a = await buildContext('pattern', '1');
    const b = await buildContext('pattern', '1');

    expect(a).toBe(b);
    expect(getPatternDetailMock).toHaveBeenCalledTimes(1);
  });

  it('refetches once the 60s TTL expires', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    getPatternDetailMock.mockResolvedValue(patternFixture());

    await buildContext('pattern', '1');
    vi.setSystemTime(new Date('2026-01-01T00:01:01.000Z')); // 61s later
    await buildContext('pattern', '1');

    expect(getPatternDetailMock).toHaveBeenCalledTimes(2);
  });

  it('returns a placeholder for unknown context types and warns', async () => {
    const result = await buildContext('invoice', 'abc');

    expect(result).toContain("No context loader for type 'invoice'");
    expect(result).toContain('=== LOCKED CONTEXT ===');
    expect(getPatternDetailMock).not.toHaveBeenCalled();
    expect(loggerWarn).toHaveBeenCalledWith(
      'buildContext: unknown contextType',
      expect.objectContaining({ type: 'invoice' })
    );
  });

  it('returns a placeholder for a non-numeric pattern id without calling the loader', async () => {
    const result = await buildContext('pattern', 'not-a-number');

    expect(result).toContain("Pattern id 'not-a-number' is not numeric");
    expect(getPatternDetailMock).not.toHaveBeenCalled();
  });

  it('returns a "not found" placeholder when the pattern has no chunks', async () => {
    getPatternDetailMock.mockResolvedValueOnce({
      patternName: null,
      chunks: [],
      totalTokens: 0,
    });

    const result = await buildContext('pattern', '99');

    expect(result).toContain('Pattern #99 not found in knowledge base.');
  });

  it('invalidateContext drops the cache entry so the next call refetches', async () => {
    getPatternDetailMock.mockResolvedValue(patternFixture());

    await buildContext('pattern', '1');
    invalidateContext('pattern', '1');
    await buildContext('pattern', '1');

    expect(getPatternDetailMock).toHaveBeenCalledTimes(2);
  });

  it('clearContextCache wipes every entry', async () => {
    getPatternDetailMock.mockResolvedValue(patternFixture());

    await buildContext('pattern', '1');
    await buildContext('pattern', '2');
    clearContextCache();
    await buildContext('pattern', '1');
    await buildContext('pattern', '2');

    expect(getPatternDetailMock).toHaveBeenCalledTimes(4);
  });

  it('evicts oldest entry when cache exceeds 500 entries', async () => {
    getPatternDetailMock.mockResolvedValue(patternFixture());

    // Fill cache to capacity
    for (let i = 0; i < 500; i++) {
      await buildContext('pattern', String(i));
    }

    // Entry 0 should still be cached
    await buildContext('pattern', '0');
    // All 500 initial calls + 0 refetches = 500 total
    expect(getPatternDetailMock).toHaveBeenCalledTimes(500);

    // Adding entry 500 should evict entry 0 (the oldest)
    await buildContext('pattern', '500');
    expect(getPatternDetailMock).toHaveBeenCalledTimes(501);

    // Entry 0 was evicted — refetch needed
    await buildContext('pattern', '0');
    expect(getPatternDetailMock).toHaveBeenCalledTimes(502);
  });
});
