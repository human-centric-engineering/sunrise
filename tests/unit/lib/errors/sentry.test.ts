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

const mockSentryModule = {
  captureException: mockCaptureException,
  captureMessage: mockCaptureMessage,
  withScope: mockWithScope,
  setUser: mockSetUser,
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
