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
  buildRequestOptions,
  toProviderError,
  toProviderErrorWithUsage,
  isRequestFault,
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

describe('isRequestFault', () => {
  it('identifies a truncation as a request fault', () => {
    expect(isRequestFault(new ProviderError('cut off', { code: 'truncated_no_output' }))).toBe(
      true
    );
  });

  it('does NOT treat a status-less transport failure as one', () => {
    // The regression this predicate exists to prevent. `toProviderError` can
    // only set `retriable` when it reads a retriable HTTP status, so a
    // connection reset or read timeout — no status — arrives as
    // `provider_error` with `retriable: false`. Gating retry on that flag
    // would stop a workflow step retrying an ordinary network blip, since
    // `withRetry` also declines to retry it. Only the CODE may gate.
    const connectionReset = toProviderError(
      new Error('Connection error.'),
      'OpenAI-compatible chat request failed'
    );
    expect(connectionReset.retriable).toBe(false);
    expect(connectionReset.code).toBe('provider_error');
    expect(isRequestFault(connectionReset)).toBe(false);
  });

  it('does NOT treat an auth failure as one — failing over is the point', () => {
    const unauthorized = new ProviderError('bad key', {
      code: 'http_401',
      status: 401,
      retriable: false,
    });
    expect(isRequestFault(unauthorized)).toBe(false);
  });

  it('ignores non-ProviderError values', () => {
    for (const v of [
      new Error('truncated_no_output'),
      'truncated_no_output',
      null,
      undefined,
      {},
    ]) {
      expect(isRequestFault(v)).toBe(false);
    }
  });
});

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
    globalThis.fetch = fetchMock;
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
    globalThis.fetch = fetchMock;

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

// ---------------------------------------------------------------------------
// buildRequestOptions
// ---------------------------------------------------------------------------

describe('buildRequestOptions', () => {
  it('returns undefined when the caller sets neither timeoutMs nor signal', () => {
    // The distinction matters: passing `{}` to the SDK is harmless, but
    // undefined keeps "caller said nothing" readable at the call site and
    // leaves the client's construction-time timeout in charge.
    expect(buildRequestOptions({ model: 'gpt-4o' })).toBeUndefined();
  });

  it('maps timeoutMs to the SDK timeout field', () => {
    expect(buildRequestOptions({ model: 'gpt-4o', timeoutMs: 600_000 })).toEqual({
      timeout: 600_000,
    });
  });

  it('passes the caller signal through', () => {
    const controller = new AbortController();

    expect(buildRequestOptions({ model: 'gpt-4o', signal: controller.signal })).toEqual({
      signal: controller.signal,
    });
  });

  it('includes both when both are supplied', () => {
    const controller = new AbortController();

    expect(
      buildRequestOptions({ model: 'gpt-4o', timeoutMs: 1_000, signal: controller.signal })
    ).toEqual({ timeout: 1_000, signal: controller.signal });
  });

  it('honours a zero timeout rather than treating it as unset', () => {
    // 0 is falsy; an `if (options.timeoutMs)` guard would silently drop it.
    expect(buildRequestOptions({ model: 'gpt-4o', timeoutMs: 0 })).toEqual({ timeout: 0 });
  });
});

describe('toProviderErrorWithUsage', () => {
  // The half of #592 that survived #593: an adapter knows what a dying stream
  // has already been billed for, and the plain `toProviderError` path drops it,
  // leaving the streaming handler with nothing to write to `AiCostLog`.

  it('attaches usage the provider had already reported', () => {
    const err = toProviderErrorWithUsage(new Error('socket hang up'), 'stream failed', {
      inputTokens: 400,
      outputTokens: 900,
    });

    expect(err).toBeInstanceOf(ProviderError);
    expect(err.usage).toEqual({ inputTokens: 400, outputTokens: 900 });
  });

  it('drops zeroed usage rather than reporting the turn as free', () => {
    // Zero means "the provider never told us", not "this cost nothing". An
    // OpenAI-compatible stream reports usage in a final chunk, so an error
    // before it leaves both counts at 0 — and a zeroed AiCostLog row reads as
    // a free turn on the dashboard, which is worse than no row.
    const err = toProviderErrorWithUsage(new Error('connection refused'), 'stream failed', {
      inputTokens: 0,
      outputTokens: 0,
    });

    expect(err.usage).toBeUndefined();
  });

  it('attaches a partial count when only one side is known', () => {
    const err = toProviderErrorWithUsage(new Error('reset'), 'stream failed', {
      inputTokens: 120,
      outputTokens: 0,
    });

    expect(err.usage).toEqual({ inputTokens: 120, outputTokens: 0 });
  });

  it('does not overwrite usage an error already carries', () => {
    // The truncation guards attach exactly what the provider reported, which
    // beats anything reconstructed from a partial accumulator.
    const original = new ProviderError('truncated', {
      code: 'truncated_no_output',
      usage: { inputTokens: 1, outputTokens: 2 },
    });

    const err = toProviderErrorWithUsage(original, 'stream failed', {
      inputTokens: 999,
      outputTokens: 999,
    });

    expect(err.usage).toEqual({ inputTokens: 1, outputTokens: 2 });
    expect(err).toBe(original);
  });

  it('keeps the original throw site in the stack', () => {
    // The rebuild happens in this helper, so without carrying `stack` across,
    // `log.error('Streaming chat handler crashed', err)` and the span exception
    // both point at the helper instead of the adapter loop that threw — the one
    // thing an operator opens them for.
    const original = new ProviderError('exploded in the stream loop', { code: 'http_500' });
    const originalStack = original.stack;

    const err = toProviderErrorWithUsage(original, 'stream failed', {
      inputTokens: 5,
      outputTokens: 7,
    });

    expect(err).not.toBe(original);
    expect(err.stack).toBe(originalStack);
  });

  it('preserves code, status and retriable while adding usage', () => {
    // Rebuilding the error must not quietly downgrade a retriable 503 into a
    // non-retriable `provider_error`, which would stop failover.
    const original = new ProviderError('unavailable', {
      code: 'http_503',
      status: 503,
      retriable: true,
    });

    const err = toProviderErrorWithUsage(original, 'stream failed', {
      inputTokens: 5,
      outputTokens: 7,
    });

    expect(err.code).toBe('http_503');
    expect(err.status).toBe(503);
    expect(err.retriable).toBe(true);
    expect(err.usage).toEqual({ inputTokens: 5, outputTokens: 7 });
  });
});
