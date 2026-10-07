/**
 * Sentry Error Tracking Abstraction Tests
 *
 * Tests for the error tracking abstraction layer in lib/errors/sentry.ts.
 *
 * Test Coverage:
 * - isSentryAvailable: env var present/absent
 * - initErrorTracking: no-op path and Sentry init path
 * - trackError: no-op and full Sentry path (Error, string, undefined context)
 * - trackMessage: no-op paths for all severity levels, full Sentry path
 * - setErrorTrackingUser: no-op and Sentry user path
 * - clearErrorTrackingUser: no-op and Sentry clear path
 * - scrubSentryBreadcrumb / scrubSentryEvent / scrubSentrySpan: URL scrubbing
 *   for Sentry's beforeSend / beforeBreadcrumb / beforeSendSpan (#952)
 *
 * Mocking strategy:
 * - @sentry/nextjs: The source uses dynamic require() inside getSentry() which
 *   bypasses Vitest's ESM vi.mock() registry. We inject a mock object directly
 *   into Node's require cache (Module._cache) so the require() call returns our
 *   mock instead of the real SDK.
 * - @/lib/logging: standard vi.mock() — imported via ESM, so this works fine.
 * - process.env.NEXT_PUBLIC_SENTRY_DSN: set/delete per describe block.
 *
 * @see lib/errors/sentry.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// ── Build mock Sentry API ─────────────────────────────────────────────────────
const mockCaptureException = vi.fn().mockReturnValue('sentry-event-id');
const mockCaptureMessage = vi.fn().mockReturnValue('sentry-message-id');
const mockWithScope = vi.fn();
const mockSetUser = vi.fn();
const mockAddEventProcessor = vi.fn();

const mockSentryModule = {
  captureException: mockCaptureException,
  captureMessage: mockCaptureMessage,
  withScope: mockWithScope,
  setUser: mockSetUser,
  getGlobalScope: () => ({ addEventProcessor: mockAddEventProcessor }),
};

// ── Inject the mock into Node's require cache ─────────────────────────────────
// getSentry() calls require('@sentry/nextjs') at runtime. Vitest's vi.mock()
// only intercepts ESM import statements. To intercept a dynamic require() we
// inject our stub into Module._cache under the resolved file path so the next
// require() call returns it instead of the real SDK.
const _require = createRequire(fileURLToPath(import.meta.url));
const sentryResolvedPath = _require.resolve('@sentry/nextjs');

// Overwrite the require cache entry
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Module = require('node:module');
if (Module._cache[sentryResolvedPath]) {
  Module._cache[sentryResolvedPath].exports = mockSentryModule;
} else {
  // Create a synthetic module cache entry
  Module._cache[sentryResolvedPath] = {
    id: sentryResolvedPath,
    filename: sentryResolvedPath,
    loaded: true,
    exports: mockSentryModule,
    parent: null,
    children: [],
    paths: [],
  };
}

// ── Mock logger ───────────────────────────────────────────────────────────────
vi.mock('@/lib/logging', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// ── Now safe to import the module under test ──────────────────────────────────
import {
  initErrorTracking,
  trackError,
  trackMessage,
  setErrorTrackingUser,
  clearErrorTrackingUser,
  ErrorSeverity,
  scrubSentryBreadcrumb,
  scrubSentryEvent,
  scrubSentrySpan,
} from '@/lib/errors/sentry';
import { logger } from '@/lib/logging';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Set NEXT_PUBLIC_SENTRY_DSN so getSentry() returns the Sentry module.
 */
function enableSentryDSN(): void {
  process.env.NEXT_PUBLIC_SENTRY_DSN = 'https://test@sentry.io/123';
}

/**
 * Remove NEXT_PUBLIC_SENTRY_DSN so getSentry() returns undefined.
 */
function disableSentryDSN(): void {
  delete process.env.NEXT_PUBLIC_SENTRY_DSN;
}

/**
 * Mock Sentry scope shape used by withScope callbacks.
 */
interface MockScope {
  setUser: ReturnType<typeof vi.fn>;
  setTag: ReturnType<typeof vi.fn>;
  setExtra: ReturnType<typeof vi.fn>;
  setLevel: ReturnType<typeof vi.fn>;
}

/**
 * Build a mock Sentry scope object and wire up withScope to invoke the
 * callback synchronously with it.  Returns the scope so tests can assert on
 * its methods.
 */
function makeMockScope(): MockScope {
  const scope: MockScope = {
    setUser: vi.fn(),
    setTag: vi.fn(),
    setExtra: vi.fn(),
    setLevel: vi.fn(),
  };
  mockWithScope.mockImplementation((cb: (scope: MockScope) => void) => {
    cb(scope);
  });
  return scope;
}

// =============================================================================
// Suite A — no-op mode (no Sentry DSN)
// =============================================================================

describe('Sentry error tracking — no-op mode (no DSN)', () => {
  beforeEach(() => {
    disableSentryDSN();
    vi.clearAllMocks();
  });

  afterEach(() => {
    disableSentryDSN();
  });

  // ── initErrorTracking ──────────────────────────────────────────────────────

  describe('initErrorTracking', () => {
    it('should call logger.debug with no-op message when DSN is absent', () => {
      // Arrange: DSN already deleted in beforeEach

      // Act
      initErrorTracking();

      // Assert: debug-level no-op message, no Sentry calls
      expect(vi.mocked(logger.debug)).toHaveBeenCalledWith(
        'Error tracking initialized in no-op mode (Sentry not configured)'
      );
      expect(vi.mocked(logger.info)).not.toHaveBeenCalled();
      expect(mockWithScope).not.toHaveBeenCalled();
    });
  });

  // ── trackError ────────────────────────────────────────────────────────────

  describe('trackError', () => {
    it('should call logger.error and return "logged" for Error with no context', () => {
      // Arrange
      const error = new Error('test failure');

      // Act
      const result = trackError(error);

      // Assert
      expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
        'Error tracked',
        error,
        expect.objectContaining({})
      );
      expect(result).toBe('logged');
      expect(mockCaptureException).not.toHaveBeenCalled();
    });

    it('should not crash and return "logged" when context is undefined', () => {
      // Arrange
      const error = new Error('resilience check');

      // Act
      const result = trackError(error, undefined);

      // Assert
      expect(result).toBe('logged');
      expect(vi.mocked(logger.error)).toHaveBeenCalledTimes(1);
    });
  });

  // ── trackMessage ──────────────────────────────────────────────────────────

  describe('trackMessage', () => {
    it('should call logger.info and return "logged" for Info level', () => {
      // Arrange
      const message = 'info event';

      // Act
      const result = trackMessage(message, ErrorSeverity.Info);

      // Assert
      expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
        'Message tracked',
        expect.objectContaining({ message, level: ErrorSeverity.Info })
      );
      expect(result).toBe('logged');
      expect(mockCaptureMessage).not.toHaveBeenCalled();
    });

    it('should call logger.warn and return "logged" for Warning level', () => {
      // Arrange
      const message = 'warning event';

      // Act
      const result = trackMessage(message, ErrorSeverity.Warning);

      // Assert
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        'Message tracked',
        expect.objectContaining({ message, level: ErrorSeverity.Warning })
      );
      expect(result).toBe('logged');
    });

    it('should call logger.error and return "logged" for Error level', () => {
      // Arrange
      const message = 'error event';

      // Act
      const result = trackMessage(message, ErrorSeverity.Error);

      // Assert
      expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
        'Message tracked',
        undefined,
        expect.objectContaining({ message, level: ErrorSeverity.Error })
      );
      expect(result).toBe('logged');
    });

    it('should fall through to logger.info for Debug level (default branch)', () => {
      // Arrange — Debug is not Error or Warning; the else branch calls logger.info
      const message = 'debug event';

      // Act
      const result = trackMessage(message, ErrorSeverity.Debug);

      // Assert: falls through to the default logger.info branch
      expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
        'Message tracked',
        expect.objectContaining({ message, level: ErrorSeverity.Debug })
      );
      expect(result).toBe('logged');
    });
  });

  // ── setErrorTrackingUser ──────────────────────────────────────────────────

  describe('setErrorTrackingUser', () => {
    it('should call logger.debug and not call Sentry.setUser when DSN is absent', () => {
      // Arrange
      const user = { id: 'user-1', email: 'test@example.com', name: 'Test User' };

      // Act
      setErrorTrackingUser(user);

      // Assert
      expect(vi.mocked(logger.debug)).toHaveBeenCalledWith('Error tracking user set', {
        userId: user.id,
      });
      expect(mockSetUser).not.toHaveBeenCalled();
    });
  });

  // ── clearErrorTrackingUser ────────────────────────────────────────────────

  describe('clearErrorTrackingUser', () => {
    it('should call logger.debug and not call Sentry.setUser when DSN is absent', () => {
      // Act
      clearErrorTrackingUser();

      // Assert
      expect(vi.mocked(logger.debug)).toHaveBeenCalledWith('Error tracking user cleared');
      expect(mockSetUser).not.toHaveBeenCalled();
    });
  });
});

// =============================================================================
// Suite B — Sentry active mode (DSN present)
// =============================================================================

describe('Sentry error tracking — Sentry active mode (DSN set)', () => {
  beforeEach(() => {
    enableSentryDSN();
    vi.clearAllMocks();
  });

  afterEach(() => {
    disableSentryDSN();
  });

  // ── initErrorTracking ──────────────────────────────────────────────────────

  describe('initErrorTracking', () => {
    it('should call logger.info with hasDSN:true when DSN is set', () => {
      // Act
      initErrorTracking();

      // Assert
      expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
        'Error tracking initialized with Sentry',
        { hasDSN: true }
      );
      expect(vi.mocked(logger.debug)).not.toHaveBeenCalled();
    });
  });

  // ── trackError ────────────────────────────────────────────────────────────

  describe('trackError', () => {
    it('should call withScope, set user/tags/extra/level, captureException, and return event ID', () => {
      // Arrange
      const scope = makeMockScope();
      mockCaptureException.mockReturnValue('evt-abc-123');
      const error = new Error('sentry tracked error');
      const context = {
        user: { id: 'u-1', email: 'u@example.com', name: 'U' },
        tags: { feature: 'checkout', step: 'payment' },
        extra: { orderId: '42', amount: 99.99 },
        level: ErrorSeverity.Error,
      };

      // Act
      const result = trackError(error, context);

      // Assert: scope configured correctly
      expect(mockWithScope).toHaveBeenCalledTimes(1);
      expect(scope.setUser).toHaveBeenCalledWith(context.user);
      expect(scope.setTag).toHaveBeenCalledWith('feature', 'checkout');
      expect(scope.setTag).toHaveBeenCalledWith('step', 'payment');
      expect(scope.setExtra).toHaveBeenCalledWith('orderId', '42');
      expect(scope.setExtra).toHaveBeenCalledWith('amount', 99.99);
      expect(scope.setLevel).toHaveBeenCalledWith(ErrorSeverity.Error);
      expect(mockCaptureException).toHaveBeenCalledWith(error);
      expect(result).toBe('evt-abc-123');
    });

    it('should pass raw string to captureException when error is a string', () => {
      // Arrange
      makeMockScope();
      mockCaptureException.mockReturnValue('evt-str-456');
      const rawError = 'raw string error';

      // Act
      const result = trackError(rawError);

      // Assert: captureException receives the raw string, not wrapped in Error
      expect(mockCaptureException).toHaveBeenCalledWith(rawError);
      expect(result).toBe('evt-str-456');
    });
  });

  // ── trackMessage ──────────────────────────────────────────────────────────

  describe('trackMessage', () => {
    it('should call withScope with user/tags/extra, captureMessage, and return event ID', () => {
      // Arrange
      const scope = makeMockScope();
      mockCaptureMessage.mockReturnValue('msg-event-789');
      const message = 'user completed onboarding';
      const context = {
        user: { id: 'u-2', email: 'v@example.com', name: 'V' },
        tags: { flow: 'onboarding' },
        extra: { step: 'final' },
      };

      // Act
      const result = trackMessage(message, ErrorSeverity.Info, context);

      // Assert
      expect(mockWithScope).toHaveBeenCalledTimes(1);
      expect(scope.setUser).toHaveBeenCalledWith(context.user);
      expect(scope.setTag).toHaveBeenCalledWith('flow', 'onboarding');
      expect(scope.setExtra).toHaveBeenCalledWith('step', 'final');
      expect(mockCaptureMessage).toHaveBeenCalledWith(message, ErrorSeverity.Info);
      expect(result).toBe('msg-event-789');
    });
  });

  // ── setErrorTrackingUser ──────────────────────────────────────────────────

  describe('setErrorTrackingUser', () => {
    it('should call Sentry.setUser with the full user object', () => {
      // Arrange
      const user = { id: 'user-42', email: 'sentry@example.com', name: 'Sentry User' };

      // Act
      setErrorTrackingUser(user);

      // Assert
      expect(mockSetUser).toHaveBeenCalledWith(user);
      expect(vi.mocked(logger.debug)).toHaveBeenCalledWith('Error tracking user set', {
        userId: user.id,
      });
    });
  });

  // ── clearErrorTrackingUser ────────────────────────────────────────────────

  describe('clearErrorTrackingUser', () => {
    it('should call Sentry.setUser(null) to clear user context', () => {
      // Act
      clearErrorTrackingUser();

      // Assert
      expect(mockSetUser).toHaveBeenCalledWith(null);
      expect(vi.mocked(logger.debug)).toHaveBeenCalledWith('Error tracking user cleared');
    });
  });
});

// =============================================================================
// Suite C — isSentryAvailable (env var toggle)
// =============================================================================

describe('isSentryAvailable (via observable behaviour)', () => {
  afterEach(() => {
    disableSentryDSN();
    vi.clearAllMocks();
  });

  it('should be false when NEXT_PUBLIC_SENTRY_DSN is absent (no Sentry calls)', () => {
    // Arrange
    disableSentryDSN();
    vi.clearAllMocks();

    // Act: initErrorTracking routes through isSentryAvailable
    initErrorTracking();

    // Assert: debug branch = Sentry not available
    expect(vi.mocked(logger.debug)).toHaveBeenCalled();
    expect(vi.mocked(logger.info)).not.toHaveBeenCalled();
  });

  it('should be true when NEXT_PUBLIC_SENTRY_DSN is set (Sentry is used)', () => {
    // Arrange
    enableSentryDSN();
    vi.clearAllMocks();

    // Act
    initErrorTracking();

    // Assert: info branch = Sentry available
    expect(vi.mocked(logger.info)).toHaveBeenCalled();
    expect(vi.mocked(logger.debug)).not.toHaveBeenCalled();
  });
});

// =============================================================================
// Suite D — URL scrubbing for beforeSend / beforeBreadcrumb (#952)
// =============================================================================

describe('Sentry URL scrubbing', () => {
  const token = 'Xk9fQ2mZp4LrT7vB1nWc8sYd';

  describe('scrubSentryBreadcrumb', () => {
    it('scrubs navigation from/to and fetch url data', () => {
      const breadcrumb = scrubSentryBreadcrumb({
        category: 'navigation',
        data: { from: `/s/${token}?a=1`, to: '/reset-password?token=abc', status_code: 200 },
      });
      expect(breadcrumb.data).toEqual({
        from: '/s/[param]',
        to: '/reset-password',
        status_code: 200,
      });

      const fetchCrumb = scrubSentryBreadcrumb({
        category: 'fetch',
        data: { url: `https://app.example.com/api/v1/x/${token}?email=a%40b.c` },
      });
      expect(fetchCrumb.data?.url).toBe('https://app.example.com/api/v1/x/[param]');
    });

    it('returns a copy and leaves the SDK-owned data object untouched', () => {
      const fetchData = { method: 'GET', url: `/api/v1/x/${token}?a=1` };
      const scrubbed = scrubSentryBreadcrumb({ category: 'fetch', data: fetchData });

      expect(scrubbed.data).toEqual({ method: 'GET', url: '/api/v1/x/[param]' });
      expect(fetchData.url).toBe(`/api/v1/x/${token}?a=1`);
    });

    it('scrubs a console breadcrumb message and string arguments, and drops url.query and url.fragment', () => {
      const scrubbed = scrubSentryBreadcrumb({
        category: 'console',
        message: `Error: boom at https://app.example.com/s/${token}?email=a%40b.c:3:7`,
        data: {
          arguments: [`at https://app.example.com/s/${token}#t=1`, 42],
          'url.query': 'email=a%40b.c',
          'url.fragment': `t=${token}`,
        },
      });

      expect(scrubbed).toEqual({
        category: 'console',
        message: 'Error: boom at https://app.example.com/s/[param]:3:7',
        data: { arguments: ['at https://app.example.com/s/[param]', 42] },
      });
    });

    it('returns a breadcrumb without data unchanged', () => {
      const breadcrumb = { category: 'ui.click', message: 'button' };
      expect(scrubSentryBreadcrumb(breadcrumb)).toEqual({
        category: 'ui.click',
        message: 'button',
      });
    });
  });

  describe('scrubSentryEvent', () => {
    it('scrubs the request URL, query string, raw-path transaction and breadcrumbs', () => {
      const event = scrubSentryEvent({
        request: {
          url: `https://app.example.com/s/${token}?email=a%40b.c#t=${token}`,
          query_string: 'email=a%40b.c',
          headers: { 'User-Agent': 'test' },
        },
        transaction: `/s/${token}`,
        breadcrumbs: [{ category: 'navigation', data: { to: `/s/${token}?x=1` } }],
        extra: { path: '/s/[param]' },
      });

      expect(event.request).toEqual({
        url: 'https://app.example.com/s/[param]',
        headers: { 'User-Agent': 'test' },
      });
      expect(event.transaction).toBe('/s/[param]');
      expect(event.breadcrumbs?.[0].data).toEqual({ to: '/s/[param]' });
      expect(JSON.stringify(event)).not.toContain(token);
      expect(JSON.stringify(event)).not.toContain('a%40b.c');
    });

    it('scrubs a METHOD-prefixed transaction name, trace context data and child spans', () => {
      const event = scrubSentryEvent({
        type: 'transaction',
        transaction: `middleware GET /s/${token}`,
        contexts: {
          trace: {
            trace_id: 't',
            span_id: 's',
            data: {
              'url.full': `https://app.example.com/s/${token}#t=${token}`,
              'url.path': `/s/${token}`,
              'url.fragment': `t=${token}`,
              'url.path.parameter.token': token,
              'sentry.op': 'pageload',
            },
          },
        },
        spans: [
          {
            span_id: 'c',
            trace_id: 't',
            start_timestamp: 0,
            status: 'ok',
            description: `GET https://app.example.com/api/v1/x/${token}?a=1`,
            data: { 'http.url': `https://app.example.com/api/v1/x/${token}`, 'http.query': 'a=1' },
          },
        ],
      });

      expect(event.transaction).toBe('middleware GET /s/[param]');
      expect(event.contexts?.trace?.data).toEqual({
        'url.full': 'https://app.example.com/s/[param]',
        'url.path': '/s/[param]',
        'sentry.op': 'pageload',
      });
      expect(event.spans?.[0].description).toBe('GET https://app.example.com/api/v1/x/[param]');
      expect(event.spans?.[0].data).toEqual({
        'http.url': 'https://app.example.com/api/v1/x/[param]',
      });
      expect(JSON.stringify(event)).not.toContain(token);
    });

    it('scrubs the file URL of each stack frame and keeps build-asset paths for source maps', () => {
      const event = scrubSentryEvent({
        exception: {
          values: [
            {
              type: 'Error',
              stacktrace: {
                frames: [
                  {
                    filename: `https://app.example.com/s/${token}?email=a%40b.c#t=1`,
                    abs_path: `https://app.example.com/s/${token}?email=a%40b.c#t=1`,
                  },
                  {
                    filename: 'app:///_next/static/chunks/app/s/[token]/page-0123456789abcdef.js',
                    abs_path:
                      'https://app.example.com/_next/static/chunks/app/s/[token]/page-0123456789abcdef.js?dpl=x',
                  },
                ],
              },
            },
          ],
        },
      });

      const frames = event.exception?.values?.[0].stacktrace?.frames;
      expect(frames?.[0]).toEqual({
        filename: 'https://app.example.com/s/[param]',
        abs_path: 'https://app.example.com/s/[param]',
      });
      expect(frames?.[1]).toEqual({
        filename: 'app:///_next/static/chunks/app/s/[token]/page-0123456789abcdef.js',
        abs_path:
          'https://app.example.com/_next/static/chunks/app/s/[token]/page-0123456789abcdef.js',
      });
    });

    it('scrubs URLs in any span attribute, including next.span_name and header arrays', () => {
      const event = scrubSentryEvent({
        type: 'transaction',
        spans: [
          {
            span_id: 'c',
            trace_id: 't',
            start_timestamp: 0,
            status: 'ok',
            data: {
              'next.span_name': `fetch GET https://api.vendor.example/v1/x?api_key=${token}`,
              'http.request.header.referer': [`https://app.example.com/s/${token}?a=1`],
              'sentry.op': 'http.client',
            },
          },
        ],
      });

      expect(event.spans?.[0].data).toEqual({
        'next.span_name': 'fetch GET https://api.vendor.example/v1/x',
        'http.request.header.referer': ['https://app.example.com/s/[param]'],
        'sentry.op': 'http.client',
      });
    });

    it('scrubs the message, exception values and string extra values', () => {
      const event = scrubSentryEvent({
        message: `Bad link https://app.example.com/s/${token}?email=a%40b.c`,
        exception: { values: [{ type: 'Error', value: `Bad link /s/${token}#t=1` }] },
        extra: { link: `https://app.example.com/s/${token}?x=1`, count: 2 },
      });

      expect(event.message).toBe('Bad link https://app.example.com/s/[param]');
      expect(event.exception?.values?.[0].value).toBe('Bad link /s/[param]');
      expect(event.extra).toEqual({ link: 'https://app.example.com/s/[param]', count: 2 });
    });

    it('scrubs nested objects in extra and Errors among breadcrumb arguments', () => {
      const logged = new Error(`failed /s/${token}?a=1`);
      const event = scrubSentryEvent({
        extra: { request: { url: `https://app.example.com/s/${token}?email=a%40b.c` } },
        breadcrumbs: [{ category: 'console', data: { arguments: [logged] } }],
      });

      expect(event.extra).toEqual({ request: { url: 'https://app.example.com/s/[param]' } });
      const argument: unknown = event.breadcrumbs?.[0].data?.arguments[0];
      expect(argument).toBeInstanceOf(Error);
      expect(argument).toMatchObject({ message: 'failed /s/[param]' });
    });

    it('keeps node_modules frame paths whole', () => {
      const frame = { filename: '/var/task/node_modules/@prisma/client/runtime/library.js' };
      const event = scrubSentryEvent({
        exception: { values: [{ type: 'Error', stacktrace: { frames: [{ ...frame }] } }] },
      });

      expect(event.exception?.values?.[0].stacktrace?.frames?.[0]).toEqual(frame);
    });

    it('scrubs logentry message and params, and request headers', () => {
      const event = scrubSentryEvent({
        logentry: {
          message: `bad link %s at /s/${token}?a=1`,
          params: [`https://h.example/s/${token}?e=1`],
        },
        request: { headers: { Referer: `https://h.example/s/${token}?email=a%40b.c` } },
      });

      expect(event.logentry).toEqual({
        message: 'bad link %s at /s/[param]',
        params: ['https://h.example/s/[param]'],
      });
      expect(event.request?.headers).toEqual({ Referer: 'https://h.example/s/[param]' });
    });

    it('does not throw on a child span with no data', () => {
      const span = { span_id: 'c', trace_id: 't', start_timestamp: 0, status: 'ok' };
      // A span another processor built can lack the typed-required `data`.
      const event = scrubSentryEvent({ type: 'transaction', spans: [span] } as never);
      expect(event).toEqual({ type: 'transaction', spans: [span] });
    });

    it('leaves a parameterised route name and an event with no request alone', () => {
      const event = scrubSentryEvent({ transaction: '/s/[token]', message: 'boom' });
      expect(event).toEqual({ transaction: '/s/[token]', message: 'boom' });
    });
  });

  describe('scrubSentrySpan', () => {
    it('scrubs the span name and URL attributes, raw or wrapped, and drops fragment and path parameters', () => {
      const span = {
        trace_id: 't',
        span_id: 's',
        name: `GET /s/${token}`,
        start_timestamp: 0,
        status: 'ok' as const,
        is_segment: true,
        attributes: {
          'url.full': { value: `https://app.example.com/s/${token}#x`, type: 'string' },
          'url.path': `/s/${token}`,
          'url.fragment': 'x',
          'url.query': 'email=a%40b.c',
          'url.path.parameter.token': token,
          'url.path.params.token': token,
          'params.token': token,
          'sentry.segment.name': `GET /s/${token}`,
          'sentry.op': 'pageload',
        },
      };

      const scrubbed = scrubSentrySpan({
        ...span,
        links: [
          {
            span_id: 'p',
            trace_id: 't',
            attributes: { 'url.full': `https://app.example.com/s/${token}` },
          },
        ],
      });

      expect(scrubbed.name).toBe('GET /s/[param]');
      expect(scrubbed.attributes).toEqual({
        'url.full': { value: 'https://app.example.com/s/[param]', type: 'string' },
        'url.path': '/s/[param]',
        'sentry.segment.name': 'GET /s/[param]',
        'sentry.op': 'pageload',
      });
      expect(scrubbed.links?.[0].attributes).toEqual({
        'url.full': 'https://app.example.com/s/[param]',
      });
      expect(JSON.stringify(scrubbed)).not.toContain(token);
      expect(span.attributes['url.path']).toBe(`/s/${token}`);
    });
  });
});

describe('URL scrubber registration (#952)', () => {
  beforeEach(() => {
    vi.resetModules();
    mockAddEventProcessor.mockClear();
    // The registered flag lives on globalThis (one per process, like Sentry's
    // global scope); clear it so each test starts unregistered.
    Reflect.deleteProperty(globalThis, Symbol.for('sunrise.sentry.urlScrubberRegistered'));
  });
  afterEach(() => {
    delete process.env.NEXT_PUBLIC_SENTRY_DSN;
  });

  it('registers scrubSentryEvent on the global scope once, however often Sentry is used', async () => {
    process.env.NEXT_PUBLIC_SENTRY_DSN = 'https://test@sentry.io/123';
    makeMockScope();
    const fresh = await import('@/lib/errors/sentry');

    fresh.initErrorTracking();
    fresh.trackError(new Error('one'));
    fresh.trackMessage('two', fresh.ErrorSeverity.Info);

    expect(mockAddEventProcessor).toHaveBeenCalledTimes(1);
    expect(mockAddEventProcessor).toHaveBeenCalledWith(fresh.scrubSentryEvent);
  });

  it('does not register again from a second copy of the module (HMR, another bundle)', async () => {
    process.env.NEXT_PUBLIC_SENTRY_DSN = 'https://test@sentry.io/123';
    (await import('@/lib/errors/sentry')).initErrorTracking();
    vi.resetModules();
    (await import('@/lib/errors/sentry')).initErrorTracking();

    expect(mockAddEventProcessor).toHaveBeenCalledTimes(1);
  });

  it('registers nothing when Sentry is not configured', async () => {
    delete process.env.NEXT_PUBLIC_SENTRY_DSN;
    const fresh = await import('@/lib/errors/sentry');

    fresh.initErrorTracking();
    fresh.trackError(new Error('one'));

    expect(mockAddEventProcessor).not.toHaveBeenCalled();
  });
});
