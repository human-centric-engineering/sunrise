/**
 * Tests for withRetry + ProviderError + fetchWithTimeout from
 * `lib/orchestration/llm/provider.ts`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { withRetry, ProviderError, fetchWithTimeout } =
  await import('@/lib/orchestration/llm/provider');

beforeEach(() => {
  // Make sleep delays ~immediate without mocking timers; the helper uses
  // small values (<= 10s) but with attempts scheduled in quick succession.
  vi.spyOn(Math, 'random').mockReturnValue(0);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('withRetry', () => {
  it('returns the result immediately on success', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withRetry(fn, { maxRetries: 3 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not retry non-retriable errors', async () => {
    const fn = vi
      .fn()
      .mockRejectedValue(new ProviderError('boom', { code: 'bad', retriable: false }));
    await expect(withRetry(fn, { maxRetries: 3 })).rejects.toMatchObject({ code: 'bad' });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries retriable errors up to maxRetries then throws', async () => {
    const err = new ProviderError('rate limit', {
      code: 'http_429',
      status: 429,
      retriable: true,
    });
    const fn = vi.fn().mockRejectedValue(err);
    await expect(withRetry(fn, { maxRetries: 2 })).rejects.toBe(err);
    // 1 initial + 2 retries = 3 attempts
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('returns success after transient retriable failure', async () => {
    const err = new ProviderError('transient', {
      code: 'http_503',
      status: 503,
      retriable: true,
    });
    const fn = vi
      .fn()
      .mockRejectedValueOnce(err)
      .mockRejectedValueOnce(err)
      .mockResolvedValue('done');
    const result = await withRetry(fn, { maxRetries: 3 });
    expect(result).toBe('done');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does NOT retry 5xx for local providers', async () => {
    const err = new ProviderError('oops', {
      code: 'http_500',
      status: 500,
      retriable: true,
    });
    const fn = vi.fn().mockRejectedValue(err);
    await expect(withRetry(fn, { maxRetries: 3, isLocal: true })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('still retries 429 for local providers', async () => {
    const err = new ProviderError('slow down', {
      code: 'http_429',
      status: 429,
      retriable: true,
    });
    const fn = vi.fn().mockRejectedValueOnce(err).mockResolvedValue('ok');
    const result = await withRetry(fn, { maxRetries: 2, isLocal: true });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('short-circuits when AbortSignal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const fn = vi.fn().mockResolvedValue('never');
    await expect(withRetry(fn, { signal: controller.signal })).rejects.toMatchObject({
      code: 'aborted',
    });
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('ProviderError', () => {
  it('carries code, status, retriable, and cause', () => {
    const cause = new Error('root');
    const err = new ProviderError('fail', {
      code: 'x',
      status: 418,
      retriable: true,
      cause,
    });
    expect(err.code).toBe('x');
    expect(err.status).toBe(418);
    expect(err.retriable).toBe(true);
    expect(err.cause).toBe(cause);
    expect(err.name).toBe('ProviderError');
  });

  it('defaults to retriable: false', () => {
    const err = new ProviderError('fail');
    expect(err.retriable).toBe(false);
    expect(err.code).toBe('provider_error');
  });
});

describe('fetchWithTimeout', () => {
  it('rejects with timeout ProviderError when slower than timeoutMs', async () => {
    const originalFetch = globalThis.fetch;
    // Simulate an in-flight fetch that never resolves unless aborted.
    globalThis.fetch = vi.fn((_url, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
      });
    }) as unknown as typeof fetch;

    try {
      await expect(fetchWithTimeout('https://example.test/ping', {}, 5)).rejects.toMatchObject({
        code: 'timeout',
        retriable: true,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
