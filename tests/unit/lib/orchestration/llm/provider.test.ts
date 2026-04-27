/**
 * Unit tests for lib/orchestration/llm/provider.ts
 *
 * Tests: ProviderError class, toProviderError helper, fetchWithTimeout wrapper,
 * and withRetry retry logic, plus constants.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock logger before importing the module under test
vi.mock('@/lib/logging', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { logger } from '@/lib/logging';
import {
  ProviderError,
  toProviderError,
  fetchWithTimeout,
  withRetry,
  DEFAULT_TIMEOUT_MS,
  LOCAL_TIMEOUT_MS,
  DEFAULT_MAX_RETRIES,
} from '@/lib/orchestration/llm/provider';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('constants', () => {
  it('exports DEFAULT_TIMEOUT_MS as a positive number', () => {
    expect(DEFAULT_TIMEOUT_MS).toBeGreaterThan(0);
    expect(typeof DEFAULT_TIMEOUT_MS).toBe('number');
  });

  it('exports LOCAL_TIMEOUT_MS as a positive number', () => {
    expect(LOCAL_TIMEOUT_MS).toBeGreaterThan(0);
    expect(typeof LOCAL_TIMEOUT_MS).toBe('number');
  });

  it('exports DEFAULT_MAX_RETRIES as a non-negative integer', () => {
    expect(DEFAULT_MAX_RETRIES).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(DEFAULT_MAX_RETRIES)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ProviderError
// ---------------------------------------------------------------------------

describe('ProviderError', () => {
  it('sets the message on the error', () => {
    // Arrange & Act
    const err = new ProviderError('something went wrong');

    // Assert
    expect(err.message).toBe('something went wrong');
  });

  it('has name "ProviderError"', () => {
    // Arrange & Act
    const err = new ProviderError('oops');

    // Assert
    expect(err.name).toBe('ProviderError');
  });

  it('defaults code to "provider_error" when not specified', () => {
    // Arrange & Act
    const err = new ProviderError('oops');

    // Assert
    expect(err.code).toBe('provider_error');
  });

  it('defaults retriable to false when not specified', () => {
    // Arrange & Act
    const err = new ProviderError('oops');

    // Assert
    expect(err.retriable).toBe(false);
  });

  it('sets code from options', () => {
    // Arrange & Act
    const err = new ProviderError('timeout', { code: 'timeout' });

    // Assert
    expect(err.code).toBe('timeout');
  });

  it('sets status from options', () => {
    // Arrange & Act
    const err = new ProviderError('rate limited', { status: 429 });

    // Assert
    expect(err.status).toBe(429);
  });

  it('sets retriable from options', () => {
    // Arrange & Act
    const err = new ProviderError('rate limited', { retriable: true });

    // Assert
    expect(err.retriable).toBe(true);
  });

  it('sets cause from options', () => {
    // Arrange
    const cause = new Error('original cause');

    // Act
    const err = new ProviderError('wrapped', { cause });

    // Assert
    expect(err.cause).toBe(cause);
  });

  it('leaves status undefined when not provided', () => {
    // Arrange & Act
    const err = new ProviderError('oops');

    // Assert
    expect(err.status).toBeUndefined();
  });

  it('leaves cause undefined when not provided', () => {
    // Arrange & Act
    const err = new ProviderError('oops');

    // Assert
    expect(err.cause).toBeUndefined();
  });

  it('is an instance of Error', () => {
    // Arrange & Act
    const err = new ProviderError('oops');

    // Assert
    expect(err).toBeInstanceOf(Error);
  });
});

// ---------------------------------------------------------------------------
// toProviderError
// ---------------------------------------------------------------------------

describe('toProviderError', () => {
  it('returns the same ProviderError instance unchanged', () => {
    // Arrange
    const original = new ProviderError('already a provider error', { code: 'timeout' });

    // Act
    const result = toProviderError(original, 'fallback message');

    // Assert
    expect(result).toBe(original);
  });

  it('wraps a plain Error using its message', () => {
    // Arrange
    const err = new Error('plain error message');

    // Act
    const result = toProviderError(err, 'fallback');

    // Assert
    expect(result).toBeInstanceOf(ProviderError);
    expect(result.message).toBe('plain error message');
  });

  it('wraps an Error that has a .status property and extracts it', () => {
    // Arrange
    const err = Object.assign(new Error('http error'), { status: 503 });

    // Act
    const result = toProviderError(err, 'fallback');

    // Assert
    expect(result.status).toBe(503);
    expect(result.code).toBe('http_503');
  });

  it('marks retriable=true when status is 429', () => {
    // Arrange
    const err = Object.assign(new Error('rate limited'), { status: 429 });

    // Act
    const result = toProviderError(err, 'fallback');

    // Assert
    expect(result.retriable).toBe(true);
  });

  it('marks retriable=true when status is 500', () => {
    // Arrange
    const err = Object.assign(new Error('server error'), { status: 500 });

    // Act
    const result = toProviderError(err, 'fallback');

    // Assert
    expect(result.retriable).toBe(true);
  });

  it('marks retriable=false when status is 400', () => {
    // Arrange
    const err = Object.assign(new Error('bad request'), { status: 400 });

    // Act
    const result = toProviderError(err, 'fallback');

    // Assert
    expect(result.retriable).toBe(false);
  });

  it('uses fallback message when wrapping a non-Error value', () => {
    // Arrange — a string throw
    const nonError = 'something string-ish';

    // Act
    const result = toProviderError(nonError, 'fallback message');

    // Assert
    expect(result).toBeInstanceOf(ProviderError);
    expect(result.message).toBe('fallback message');
  });

  it('attaches the original error as cause for plain Errors', () => {
    // Arrange
    const err = new Error('original');

    // Act
    const result = toProviderError(err, 'fallback');

    // Assert
    expect(result.cause).toBe(err);
  });
});

// ---------------------------------------------------------------------------
// fetchWithTimeout
// ---------------------------------------------------------------------------

describe('fetchWithTimeout', () => {
  // Use real timers for fetchWithTimeout tests to avoid happy-dom AbortSignal
  // / PromiseRejectionHandledWarning issues that arise with fake timers.
  // Use a very small timeoutMs (5ms) so the timeout fires naturally.

  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('returns the response on success', async () => {
    // Arrange
    const mockResponse = new Response(JSON.stringify({ ok: true }), { status: 200 });
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse) as typeof fetch;

    // Act
    const result = await fetchWithTimeout('https://example.com/api', {}, 5000);

    // Assert
    expect(result).toBe(mockResponse);
    expect(globalThis.fetch).toHaveBeenCalledOnce();
  });

  it('passes the request init options to fetch', async () => {
    // Arrange
    const mockResponse = new Response('', { status: 200 });
    const fetchMock = vi.fn().mockResolvedValue(mockResponse);
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const init = { method: 'POST', headers: { 'Content-Type': 'application/json' } };

    // Act
    await fetchWithTimeout('https://example.com/api', init, 5000);

    // Assert
    const [calledUrl, calledInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe('https://example.com/api');
    expect((calledInit as Record<string, unknown>).method).toBe('POST');
  });

  it('throws ProviderError with code "timeout" and retriable=true when the request times out', async () => {
    // Arrange — fetch blocks on the internal abort signal and rejects when it fires.
    // Using real timers with a 5ms timeout so the test stays fast.
    globalThis.fetch = vi.fn((_url, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
      });
    }) as unknown as typeof fetch;

    // Act & Assert
    await expect(fetchWithTimeout('https://example.com/api', {}, 5)).rejects.toSatisfy(
      (err: unknown) => {
        return err instanceof ProviderError && err.code === 'timeout' && err.retriable === true;
      }
    );
  });

  it('throws ProviderError with code "aborted" when signal is already aborted before the call', async () => {
    // Arrange
    const controller = new AbortController();
    controller.abort();
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    // Act & Assert — should throw synchronously/immediately without calling fetch
    await expect(
      fetchWithTimeout('https://example.com/api', {}, 5000, controller.signal)
    ).rejects.toSatisfy((err: unknown) => {
      return err instanceof ProviderError && err.code === 'aborted';
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws ProviderError with code "aborted" when external signal is aborted mid-request', async () => {
    // Arrange — fetch aborts after an external controller is triggered inside the mock
    const externalController = new AbortController();
    globalThis.fetch = vi.fn((_url, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
        // Trigger the external abort on the next microtask (after fetch has started)
        void Promise.resolve().then(() => externalController.abort('mid-flight'));
      });
    }) as unknown as typeof fetch;

    // Act & Assert
    await expect(
      fetchWithTimeout('https://example.com/api', {}, 5000, externalController.signal)
    ).rejects.toSatisfy((err: unknown) => {
      return err instanceof ProviderError && err.code === 'aborted';
    });
  });
});

// ---------------------------------------------------------------------------
// withRetry
// ---------------------------------------------------------------------------

describe('withRetry', () => {
  // Use real timers. Mock Math.random → 0 so jitter is 0 and delay formula
  // resolves to RETRY_BASE_DELAY_MS * 2^attempt (500ms, 1000ms, ...).
  // We pass maxRetries: 0 for "no retry" cases and mock the fn to fail once
  // then succeed, relying on the real event loop for small delays.

  beforeEach(() => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the result on first attempt without retrying', async () => {
    // Arrange
    const fn = vi.fn().mockResolvedValue('success');

    // Act
    const result = await withRetry(fn, { maxRetries: 3 });

    // Assert
    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on retriable ProviderError then returns result on second attempt', async () => {
    // Arrange — Math.random = 0 means jitter = 0; delay = 500ms * 2^0 = 500ms.
    // Use vi.useFakeTimers only for this test to skip the sleep quickly.
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);

    const retriableError = new ProviderError('rate limited', { retriable: true, status: 429 });
    const fn = vi
      .fn()
      .mockRejectedValueOnce(retriableError)
      .mockResolvedValue('success after retry');

    // Act — start the retry, advance past the 500ms backoff
    const resultPromise = withRetry(fn, { maxRetries: 3, operation: 'test op' });
    await vi.advanceTimersByTimeAsync(1000);
    const result = await resultPromise;

    vi.useRealTimers();

    // Assert
    expect(result).toBe('success after retry');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      'LLM request retriable failure, backing off',
      expect.objectContaining({ attempt: 1, code: 'provider_error' })
    );
  });

  it('does not retry non-retriable errors and throws immediately', async () => {
    // Arrange
    const nonRetriable = new ProviderError('bad request', { retriable: false, status: 400 });
    const fn = vi.fn().mockRejectedValue(nonRetriable);

    // Act & Assert
    await expect(withRetry(fn, { maxRetries: 3 })).rejects.toSatisfy((err: unknown) => {
      return err instanceof ProviderError && !err.retriable;
    });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not retry 5xx for local providers and throws immediately', async () => {
    // Arrange
    const serverError = new ProviderError('server error', {
      retriable: true,
      status: 503,
    });
    const fn = vi.fn().mockRejectedValue(serverError);

    // Act & Assert — isLocal: true should suppress retry of 5xx
    await expect(withRetry(fn, { maxRetries: 3, isLocal: true })).rejects.toSatisfy(
      (err: unknown) => {
        return err instanceof ProviderError && err.status === 503;
      }
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('exhausts max retries and throws after maxRetries+1 total attempts', async () => {
    // Arrange — use fake timers to skip the real backoff delays
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);

    const retriableError = new ProviderError('always fails', { retriable: true, status: 429 });
    const fn = vi.fn().mockRejectedValue(retriableError);
    const maxRetries = 2;

    const resultPromise = withRetry(fn, { maxRetries });

    // Attach rejection assertion BEFORE advancing timers so the promise always
    // has a handler and Node never marks it as an unhandled rejection.
    const assertionPromise = expect(resultPromise).rejects.toBeInstanceOf(ProviderError);

    // Advance past all backoff sleeps (500ms + 1000ms + buffer)
    for (let i = 0; i < maxRetries + 2; i++) {
      await vi.advanceTimersByTimeAsync(15_000);
    }

    // Await the pre-attached assertion
    await assertionPromise;

    vi.useRealTimers();

    // 1 initial attempt + maxRetries retry attempts
    expect(fn).toHaveBeenCalledTimes(maxRetries + 1);
  });

  it('wraps non-ProviderError thrown by fn as ProviderError', async () => {
    // Arrange — fn throws a plain Error (non-retriable by default from toProviderError)
    const plainError = new Error('unexpected failure');
    const fn = vi.fn().mockRejectedValue(plainError);

    // Act & Assert
    await expect(withRetry(fn, { maxRetries: 3 })).rejects.toBeInstanceOf(ProviderError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('respects AbortSignal — throws ProviderError with code "aborted" when signal is pre-aborted', async () => {
    // Arrange
    const controller = new AbortController();
    controller.abort();
    const fn = vi.fn().mockResolvedValue('never reached');

    // Act & Assert
    await expect(withRetry(fn, { signal: controller.signal })).rejects.toSatisfy(
      (err: unknown) => err instanceof ProviderError && err.code === 'aborted'
    );
    expect(fn).not.toHaveBeenCalled();
  });
});
