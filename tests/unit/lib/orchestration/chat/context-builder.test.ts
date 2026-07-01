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

vi.mock('@/lib/app/context-contributors', () => ({
  initAppContextContributors: vi.fn(),
}));

const { getPatternDetail } = await import('@/lib/orchestration/knowledge/search');
const { logger } = await import('@/lib/logging');
const { initAppContextContributors } = await import('@/lib/app/context-contributors');
const {
  buildContext,
  invalidateContext,
  clearContextCache,
  registerContextContributor,
  __resetContextContributorsForTests,
} = await import('@/lib/orchestration/chat/context-builder');

const getPatternDetailMock = getPatternDetail as ReturnType<typeof vi.fn>;
const loggerWarn = logger.warn as ReturnType<typeof vi.fn>;
const loggerError = logger.error as ReturnType<typeof vi.fn>;
const initAppContextContributorsMock = initAppContextContributors as ReturnType<typeof vi.fn>;

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
  __resetContextContributorsForTests();
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

describe('registerContextContributor', () => {
  it('invokes a registered contributor for its type and frames the body', async () => {
    registerContextContributor('invoice', async (id) => `Invoice ${id} total: $42`);

    const result = await buildContext('invoice', 'INV-7');

    expect(result).toContain('=== LOCKED CONTEXT ===');
    expect(result).toContain('type: invoice');
    expect(result).toContain('id: INV-7');
    expect(result).toContain('Invoice INV-7 total: $42');
    // A handled type must not fall through to the warn+placeholder path.
    expect(loggerWarn).not.toHaveBeenCalled();
    expect(getPatternDetailMock).not.toHaveBeenCalled();
  });

  it('returns the benign placeholder for a type with no built-in and no contributor', async () => {
    registerContextContributor('invoice', async () => 'unused');

    const result = await buildContext('shipment', 'S-1');

    expect(result).toContain("No context loader for type 'shipment'");
    expect(loggerWarn).toHaveBeenCalledWith(
      'buildContext: unknown contextType',
      expect.objectContaining({ type: 'shipment' })
    );
  });

  it('lets a built-in case take precedence over a same-type contributor', async () => {
    getPatternDetailMock.mockResolvedValueOnce(patternFixture());
    const contributor = vi.fn(async () => 'should not run');
    registerContextContributor('pattern', contributor);

    const result = await buildContext('pattern', '1');

    expect(result).toContain('Pattern #1: ReAct');
    expect(contributor).not.toHaveBeenCalled();
  });

  it('re-registering a type replaces the prior loader', async () => {
    registerContextContributor('invoice', async () => 'first');
    registerContextContributor('invoice', async () => 'second');

    const result = await buildContext('invoice', 'X');

    expect(result).toContain('second');
    expect(result).not.toContain('first');
  });

  it('auto-wires the fork init exactly once across lookups', async () => {
    registerContextContributor('invoice', async () => 'body');

    await buildContext('invoice', 'A');
    await buildContext('invoice', 'B');

    expect(initAppContextContributorsMock).toHaveBeenCalledTimes(1);
  });

  it('degrades to the placeholder (and logs) when a contributor throws — does not fail the turn', async () => {
    registerContextContributor('invoice', async () => {
      throw new Error('loader boom');
    });

    const result = await buildContext('invoice', 'INV-9');

    expect(result).toContain("No context loader for type 'invoice'");
    expect(loggerError).toHaveBeenCalledWith(
      'buildContext: context contributor threw',
      expect.objectContaining({ type: 'invoice', error: 'loader boom' })
    );
  });

  it('does not cache a contributor error, so a recovered loader takes effect on the next turn', async () => {
    let calls = 0;
    registerContextContributor('invoice', async () => {
      calls += 1;
      if (calls === 1) throw new Error('transient');
      return 'recovered body';
    });

    const first = await buildContext('invoice', 'INV-9');
    const second = await buildContext('invoice', 'INV-9');

    expect(first).toContain("No context loader for type 'invoice'");
    expect(second).toContain('recovered body');
    expect(calls).toBe(2);
  });

  it('does not cache the unknown-type placeholder, so a late-registered contributor takes effect next turn', async () => {
    const first = await buildContext('invoice', 'INV-9');
    expect(first).toContain("No context loader for type 'invoice'");

    registerContextContributor('invoice', async () => 'now available');
    const second = await buildContext('invoice', 'INV-9');

    expect(second).toContain('now available');
  });

  it('retries the fork init on the next lookup when it throws (flag set only after success)', async () => {
    initAppContextContributorsMock.mockImplementationOnce(() => {
      throw new Error('init boom');
    });

    // First lookup: init throws and propagates; the flag must NOT latch.
    await expect(buildContext('invoice', 'A')).rejects.toThrow('init boom');
    // Second lookup: init is retried and succeeds.
    await expect(buildContext('invoice', 'B')).resolves.toContain('No context loader');
    expect(initAppContextContributorsMock).toHaveBeenCalledTimes(2);
  });
});
