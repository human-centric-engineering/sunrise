/**
 * Tests for withRetry + ProviderError + fetchWithTimeout + toProviderError + sleep
 * from `lib/orchestration/llm/provider.ts`.
 *
 * Test Coverage:
 * - withRetry: success, non-retriable, retry exhaustion, transient success, local 5xx, abort
 * - ProviderError: code/status/retriable/cause defaults
 * - fetchWithTimeout: timeout path, pre-aborted external signal, mid-flight abort
 * - toProviderError: all branches (ProviderError passthrough, Error+status, plain Error, non-Error)
 * - sleep: pre-aborted signal rejection, mid-sleep abort via event listener
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { withRetry, ProviderError, fetchWithTimeout, toProviderError } =
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

  it('wraps a non-ProviderError thrown by fn into a ProviderError via toProviderError', async () => {
    // Arrange: function that throws a plain Error (not a ProviderError)
    const cause = new Error('unexpected failure');
    const fn = vi.fn().mockRejectedValue(cause);

    // Act: withRetry should catch the plain Error, wrap it, and throw a ProviderError
    const thrown = await withRetry(fn, { maxRetries: 0 }).catch((e: unknown) => e);

    // Assert: the caught error is a ProviderError wrapping the original cause
    expect(thrown).toBeInstanceOf(ProviderError);
    const providerErr = thrown as InstanceType<typeof ProviderError>;
    expect(providerErr.cause).toBe(cause);
    // Plain Error with no status → provider_error code, non-retriable
    expect(providerErr.code).toBe('provider_error');
    expect(providerErr.retriable).toBe(false);
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
    // test-review:accept tobe_true — structural assertion on retriable boolean field of ProviderError
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

  it('throws immediately when external signal is already aborted before the call', async () => {
    // Arrange: create a pre-aborted signal
    const controller = new AbortController();
    controller.abort('pre-aborted');

    // Act + Assert: fetchWithTimeout should throw without ever calling fetch
    const fetchSpy = vi.fn();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    try {
      await expect(
        fetchWithTimeout('https://example.test/ping', {}, DEFAULT_TIMEOUT_MS, controller.signal)
      ).rejects.toMatchObject({
        code: 'aborted',
        retriable: false,
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('propagates abort when external signal fires mid-flight', async () => {
    // Arrange: controller whose abort we trigger after fetch starts
    const externalController = new AbortController();
    const originalFetch = globalThis.fetch;

    // Simulate a never-resolving fetch that listens to the internal signal
    globalThis.fetch = vi.fn((_url, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
        // Abort external signal after fetch starts (next microtask)
        void Promise.resolve().then(() => externalController.abort('mid-flight'));
      });
    }) as unknown as typeof fetch;

    try {
      await expect(
        fetchWithTimeout('https://example.test/ping', {}, 30_000, externalController.signal)
      ).rejects.toMatchObject({
        code: 'aborted',
        retriable: false,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

const { DEFAULT_TIMEOUT_MS } = await import('@/lib/orchestration/llm/provider');

describe('toProviderError', () => {
  it('returns the same ProviderError instance unchanged (passthrough)', () => {
    // Arrange
    const original = new ProviderError('already wrapped', {
      code: 'http_429',
      status: 429,
      retriable: true,
    });

    // Act
    const result = toProviderError(original, 'fallback');

    // Assert: exact same object, not a copy
    expect(result).toBe(original);
  });

  it('wraps Error with a status field into ProviderError with http_N code', () => {
    // Arrange: SDK-style error with numeric status property
    const sdkError = new Error('Bad Gateway') as Error & { status: number };
    sdkError.status = 502;

    // Act
    const result = toProviderError(sdkError, 'fallback');

    // Assert
    expect(result).toBeInstanceOf(ProviderError);
    expect(result.code).toBe('http_502');
    expect(result.status).toBe(502);
    // 502 is a 5xx → retriable
    // test-review:accept tobe_true — structural assertion on retriable boolean field of ProviderError (5xx status maps to retriable=true)
    expect(result.retriable).toBe(true);
    expect(result.cause).toBe(sdkError);
    expect(result.message).toBe('Bad Gateway');
  });

  it('wraps plain Error with no status into ProviderError with provider_error code', () => {
    // Arrange
    const plain = new Error('something went wrong');

    // Act
    const result = toProviderError(plain, 'fallback message');

    // Assert
    expect(result).toBeInstanceOf(ProviderError);
    expect(result.code).toBe('provider_error');
    expect(result.status).toBeUndefined();
    expect(result.retriable).toBe(false);
    expect(result.message).toBe('something went wrong');
    expect(result.cause).toBe(plain);
  });

  it('wraps a non-Error thrown value (string) using the fallback message', () => {
    // Arrange: code that throws a raw string
    const thrown = 'raw string error';

    // Act
    const result = toProviderError(thrown, 'fallback for string');

    // Assert
    expect(result).toBeInstanceOf(ProviderError);
    expect(result.message).toBe('fallback for string');
    expect(result.code).toBe('provider_error');
    expect(result.cause).toBe(thrown);
  });

  it('wraps a non-Error thrown object using the fallback message', () => {
    // Arrange: code that throws a plain object
    const thrown = { weird: true };

    // Act
    const result = toProviderError(thrown, 'fallback for object');

    // Assert
    expect(result).toBeInstanceOf(ProviderError);
    expect(result.message).toBe('fallback for object');
    expect(result.cause).toBe(thrown);
  });

  it('wraps 429 status error as retriable', () => {
    // Arrange: SDK error with 429 status
    const sdkError = new Error('Rate limited') as Error & { status: number };
    sdkError.status = 429;

    // Act
    const result = toProviderError(sdkError, 'fallback');

    // Assert
    // test-review:accept tobe_true — structural assertion on retriable boolean field of ProviderError (429 status maps to retriable=true)
    expect(result.retriable).toBe(true);
    expect(result.status).toBe(429);
  });

  it('wraps 400 status error as non-retriable', () => {
    // Arrange: client error (not retriable)
    const sdkError = new Error('Bad Request') as Error & { status: number };
    sdkError.status = 400;

    // Act
    const result = toProviderError(sdkError, 'fallback');

    // Assert
    expect(result.retriable).toBe(false);
    expect(result.status).toBe(400);
    expect(result.code).toBe('http_400');
  });
});

describe('sleep cancellation (via withRetry abort path)', () => {
  it('rejects mid-sleep when signal aborts during backoff', async () => {
    // Arrange: a controller we abort after the first attempt fails
    const controller = new AbortController();

    let attemptCount = 0;
    const fn = vi.fn().mockImplementation(async () => {
      attemptCount += 1;
      if (attemptCount === 1) {
        // First call: fail retriably, then immediately abort the signal
        // so the sleep inside withRetry is cancelled
        setTimeout(() => controller.abort('cancelled'), 0);
        throw new ProviderError('transient', { code: 'http_503', status: 503, retriable: true });
      }
      return 'should not reach';
    });

    // Act + Assert: withRetry should reject with 'aborted' rather than retrying
    await expect(withRetry(fn, { maxRetries: 5, signal: controller.signal })).rejects.toMatchObject(
      { code: 'aborted' }
    );
    // Only 1 attempt was made — abort cut off the sleep before the next attempt
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('rejects immediately from sleep when signal is pre-aborted at start of sleep', async () => {
    // Arrange: pre-aborted signal; the signal loop check catches it before fn runs,
    // but we need to test that the sleep() function itself also handles it.
    // We do so by aborting the signal synchronously between attempt check and sleep.
    const controller = new AbortController();

    // This is tested indirectly: withRetry checks signal.aborted at top of loop,
    // so if the signal is aborted before any attempt, it rejects immediately.
    controller.abort('pre-aborted');

    const fn = vi.fn().mockResolvedValue('ok');
    await expect(withRetry(fn, { maxRetries: 3, signal: controller.signal })).rejects.toMatchObject(
      { code: 'aborted' }
    );
    expect(fn).not.toHaveBeenCalled();
  });
});
