/**
 * Error Handler Tests
 *
 * Tests for error handler functions in lib/errors/handler.ts
 *
 * Test Coverage:
 * - normalizeError: Error normalization for all input types
 * - handleClientError: Client-side error handling, logging, tracking, deduplication, scrubbing
 * - initGlobalErrorHandler: Global error handler initialization and cleanup
 *
 * @see lib/errors/handler.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { normalizeError, handleClientError, initGlobalErrorHandler } from '@/lib/errors/handler';
import { logger } from '@/lib/logging';
import { trackError, ErrorSeverity } from '@/lib/errors/sentry';

// Mock dependencies to avoid side effects
vi.mock('@/lib/logging', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@/lib/errors/sentry', () => ({
  trackError: vi.fn(),
  ErrorSeverity: {
    Error: 'error',
    Warning: 'warning',
    Info: 'info',
  },
}));

describe('normalizeError', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Case 1: Error instances', () => {
    it('should extract message, error, and metadata from Error instance', () => {
      const error = new Error('test error message');
      const result = normalizeError(error);

      expect(result.message).toBe('test error message');
      expect(result.error).toBe(error);
      expect(result.metadata).toMatchObject({
        name: 'Error',
        stack: expect.any(String),
      });
    });

    it('should include stack trace in metadata', () => {
      const error = new Error('with stack');
      const result = normalizeError(error);

      expect(result.metadata.stack).toBeDefined();
      expect(typeof result.metadata.stack).toBe('string');
      expect(result.metadata.stack).toContain('with stack');
    });

    it('should include additional properties in metadata', () => {
      const error = new Error('error with extra properties') as Error & {
        code: string;
        statusCode: number;
      };
      error.code = 'ERR_001';
      error.statusCode = 500;

      const result = normalizeError(error);

      expect(result.message).toBe('error with extra properties');
      expect(result.error).toBe(error);
      expect(result.metadata).toMatchObject({
        name: 'Error',
        stack: expect.any(String),
        code: 'ERR_001',
        statusCode: 500,
      });
    });

    it('should not include message, name, or stack as extra properties', () => {
      const error = new Error('standard error');
      const result = normalizeError(error);

      // Only name and stack should be in metadata (message is in the message field)
      const metadataKeys = Object.keys(result.metadata);
      expect(metadataKeys).toContain('name');
      expect(metadataKeys).toContain('stack');
      expect(metadataKeys).not.toContain('message');
    });

    it('should handle custom Error subclasses', () => {
      class CustomError extends Error {
        constructor(
          message: string,
          public customField: string
        ) {
          super(message);
          this.name = 'CustomError';
        }
      }

      const error = new CustomError('custom error', 'custom value');
      const result = normalizeError(error);

      expect(result.message).toBe('custom error');
      expect(result.error).toBe(error);
      expect(result.metadata).toMatchObject({
        name: 'CustomError',
        stack: expect.any(String),
        customField: 'custom value',
      });
    });
  });

  describe('Case 2: String errors', () => {
    it('should wrap string in Error and use as message', () => {
      const result = normalizeError('something failed');

      expect(result.message).toBe('something failed');
      expect(result.error).toBeInstanceOf(Error);
      expect(result.error.message).toBe('something failed');
      expect(result.metadata).toEqual({});
    });

    it('should handle empty string', () => {
      const result = normalizeError('');

      expect(result.message).toBe('');
      expect(result.error).toBeInstanceOf(Error);
      expect(result.error.message).toBe('');
      expect(result.metadata).toEqual({});
    });

    it('should handle multi-line string', () => {
      const multiLineError = 'Error occurred:\nLine 2\nLine 3';
      const result = normalizeError(multiLineError);

      expect(result.message).toBe(multiLineError);
      expect(result.error.message).toBe(multiLineError);
      expect(result.metadata).toEqual({});
    });
  });

  describe('Case 3: Objects with message property', () => {
    it('should use message property and include full object as metadata', () => {
      const errorObj = { message: 'hello', code: 123 };
      const result = normalizeError(errorObj);

      expect(result.message).toBe('hello');
      expect(result.error).toBeInstanceOf(Error);
      expect(result.error.message).toBe('hello');
      expect(result.metadata).toEqual({ message: 'hello', code: 123 });
    });

    it('should handle object with only message property', () => {
      const errorObj = { message: 'only message' };
      const result = normalizeError(errorObj);

      expect(result.message).toBe('only message');
      expect(result.error).toBeInstanceOf(Error);
      expect(result.error.message).toBe('only message');
      expect(result.metadata).toEqual({ message: 'only message' });
    });

    it('should handle object with message and multiple additional properties', () => {
      const errorObj = {
        message: 'validation failed',
        field: 'email',
        code: 'VALIDATION_ERROR',
        statusCode: 400,
      };
      const result = normalizeError(errorObj);

      expect(result.message).toBe('validation failed');
      expect(result.error).toBeInstanceOf(Error);
      expect(result.metadata).toEqual(errorObj);
    });

    it('should handle object with empty string message', () => {
      const errorObj = { message: '', code: 'EMPTY' };
      const result = normalizeError(errorObj);

      expect(result.message).toBe('');
      expect(result.error.message).toBe('');
      expect(result.metadata).toEqual({ message: '', code: 'EMPTY' });
    });

    it('should not match object with non-string message property', () => {
      const errorObj = { message: 123, code: 'BAD' };
      const result = normalizeError(errorObj);

      // Should fall to Case 4 (no string message)
      expect(result.message).toBe('Unknown error occurred');
      expect(result.error.message).toBe('Unknown error occurred');
      expect(result.metadata).toEqual({ message: 123, code: 'BAD' });
    });
  });

  describe('Case 4: Other objects (without message property)', () => {
    it('should use default message and object as metadata', () => {
      const errorObj = { code: 123 };
      const result = normalizeError(errorObj);

      expect(result.message).toBe('Unknown error occurred');
      expect(result.error).toBeInstanceOf(Error);
      expect(result.error.message).toBe('Unknown error occurred');
      expect(result.metadata).toEqual({ code: 123 });
    });

    it('should handle object with multiple properties but no message', () => {
      const errorObj = { code: 'ERR_001', statusCode: 500, details: 'Something bad' };
      const result = normalizeError(errorObj);

      expect(result.message).toBe('Unknown error occurred');
      expect(result.error).toBeInstanceOf(Error);
      expect(result.metadata).toEqual(errorObj);
    });

    it('should handle empty object', () => {
      const errorObj = {};
      const result = normalizeError(errorObj);

      expect(result.message).toBe('Unknown error occurred');
      expect(result.error).toBeInstanceOf(Error);
      expect(result.metadata).toEqual({});
    });

    it('should handle object with nested properties', () => {
      const errorObj = {
        code: 'NESTED',
        details: {
          field: 'email',
          reason: 'invalid format',
        },
      };
      const result = normalizeError(errorObj);

      expect(result.message).toBe('Unknown error occurred');
      expect(result.metadata).toEqual(errorObj);
    });
  });

  describe('Case 5: Primitives and other types', () => {
    it('should convert null to string', () => {
      const result = normalizeError(null);

      expect(result.message).toBe('null');
      expect(result.error).toBeInstanceOf(Error);
      expect(result.error.message).toBe('null');
      expect(result.metadata).toEqual({ originalValue: null });
    });

    it('should convert undefined to string', () => {
      const result = normalizeError(undefined);

      expect(result.message).toBe('undefined');
      expect(result.error).toBeInstanceOf(Error);
      expect(result.error.message).toBe('undefined');
      expect(result.metadata).toEqual({ originalValue: undefined });
    });

    it('should convert number to string', () => {
      const result = normalizeError(42);

      expect(result.message).toBe('42');
      expect(result.error).toBeInstanceOf(Error);
      expect(result.error.message).toBe('42');
      expect(result.metadata).toEqual({ originalValue: 42 });
    });

    it('should convert boolean to string', () => {
      const result = normalizeError(true);

      expect(result.message).toBe('true');
      expect(result.error).toBeInstanceOf(Error);
      expect(result.metadata).toEqual({ originalValue: true });
    });

    it('should convert zero to string', () => {
      const result = normalizeError(0);

      expect(result.message).toBe('0');
      expect(result.error).toBeInstanceOf(Error);
      expect(result.metadata).toEqual({ originalValue: 0 });
    });

    it('should convert negative number to string', () => {
      const result = normalizeError(-123);

      expect(result.message).toBe('-123');
      expect(result.error).toBeInstanceOf(Error);
      expect(result.metadata).toEqual({ originalValue: -123 });
    });

    it('should handle BigInt primitive', () => {
      const bigIntValue = BigInt(9007199254740991);
      const result = normalizeError(bigIntValue);

      expect(result.message).toBe('9007199254740991');
      expect(result.error).toBeInstanceOf(Error);
      expect(result.metadata).toEqual({ originalValue: bigIntValue });
    });

    it('should handle Symbol primitive', () => {
      const symbolValue = Symbol('test');
      const result = normalizeError(symbolValue);

      expect(result.message).toBe('Symbol(test)');
      expect(result.error).toBeInstanceOf(Error);
      expect(result.metadata).toEqual({ originalValue: symbolValue });
    });
  });

  describe('Edge cases with arrays', () => {
    it('should treat arrays as primitives (not objects)', () => {
      const arrayError = ['error1', 'error2'];
      const result = normalizeError(arrayError);

      // Arrays are not caught by isRecord(), so they fall through to Case 5
      expect(result.message).toBe('error1,error2');
      expect(result.error).toBeInstanceOf(Error);
      expect(result.metadata).toEqual({ originalValue: arrayError });
    });

    it('should handle empty array', () => {
      const result = normalizeError([]);

      expect(result.message).toBe('');
      expect(result.error).toBeInstanceOf(Error);
      expect(result.metadata).toEqual({ originalValue: [] });
    });
  });

  describe('Return type consistency', () => {
    it('should always return an object with message, error, and metadata', () => {
      const testCases = [
        new Error('test'),
        'string error',
        { message: 'object with message' },
        { code: 123 },
        null,
        undefined,
        42,
      ];

      for (const testCase of testCases) {
        const result = normalizeError(testCase);

        expect(result).toHaveProperty('message');
        expect(result).toHaveProperty('error');
        expect(result).toHaveProperty('metadata');

        expect(typeof result.message).toBe('string');
        expect(result.error).toBeInstanceOf(Error);
        expect(typeof result.metadata).toBe('object');
      }
    });

    it('should ensure error.message matches returned message for non-Error inputs', () => {
      const testCases = [
        { input: 'string error', expectedMessage: 'string error' },
        { input: { message: 'object message' }, expectedMessage: 'object message' },
        { input: { code: 123 }, expectedMessage: 'Unknown error occurred' },
        { input: 42, expectedMessage: '42' },
      ];

      for (const { input, expectedMessage } of testCases) {
        const result = normalizeError(input);

        expect(result.message).toBe(expectedMessage);
        expect(result.error.message).toBe(expectedMessage);
      }
    });
  });
});

describe('handleClientError', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Clear the processedErrors Set via reflection
    // Since it's module-level state, we need to clear it between tests
    // We do this by calling handleClientError with unique errors
    // The Set cleanup happens automatically at MAX_PROCESSED_ERRORS (100)
  });

  describe('Error logging and tracking', () => {
    it('should call logger.error with normalized error and context', () => {
      const error = new Error('test error');
      const context = { component: 'TestComponent', action: 'testAction' };

      handleClientError(error, context);

      expect(logger.error).toHaveBeenCalledWith(
        'Unhandled client error',
        error,
        expect.objectContaining({
          component: 'TestComponent',
          action: 'testAction',
          errorType: 'unhandled',
        })
      );
    });

    it('should call trackError with normalized error and options', () => {
      const error = new Error('test error');
      const context = { userId: '123' };

      handleClientError(error, context);

      expect(trackError).toHaveBeenCalledWith(
        error,
        expect.objectContaining({
          tags: {
            errorType: 'unhandled',
            source: 'globalHandler',
          },
          extra: expect.objectContaining({
            userId: '123',
          }),
          level: ErrorSeverity.Error,
        })
      );
    });

    it('should handle errors without context', () => {
      const error = new Error('test error');

      handleClientError(error);

      expect(logger.error).toHaveBeenCalledWith(
        'Unhandled client error',
        error,
        expect.objectContaining({
          errorType: 'unhandled',
        })
      );
    });
  });

  describe('Sensitive data scrubbing', () => {
    it('should scrub password from context', () => {
      const error = new Error('test error');
      const context = { username: 'john', password: 'secret123' };

      handleClientError(error, context);

      expect(logger.error).toHaveBeenCalledWith(
        'Unhandled client error',
        error,
        expect.objectContaining({
          username: 'john',
          password: '[REDACTED]',
        })
      );
    });

    it('should scrub token from context', () => {
      const error = new Error('test error');
      const context = { authToken: 'bearer-token-123', userId: '123' };

      handleClientError(error, context);

      expect(trackError).toHaveBeenCalledWith(
        error,
        expect.objectContaining({
          extra: expect.objectContaining({
            authToken: '[REDACTED]',
            userId: '123',
          }),
        })
      );
    });

    it('should scrub apiKey from context', () => {
      const error = new Error('test error');
      const context = { apiKey: 'sk_live_123', action: 'payment' };

      handleClientError(error, context);

      expect(logger.error).toHaveBeenCalledWith(
        'Unhandled client error',
        error,
        expect.objectContaining({
          apiKey: '[REDACTED]',
          action: 'payment',
        })
      );
    });

    it('should scrub secret from context', () => {
      const error = new Error('test error');
      const context = { clientSecret: 'cs_test_123' };

      handleClientError(error, context);

      expect(logger.error).toHaveBeenCalledWith(
        'Unhandled client error',
        error,
        expect.objectContaining({
          clientSecret: '[REDACTED]',
        })
      );
    });

    it('should scrub creditCard from context', () => {
      const error = new Error('test error');
      const context = { creditCard: '4111111111111111' };

      handleClientError(error, context);

      expect(logger.error).toHaveBeenCalledWith(
        'Unhandled client error',
        error,
        expect.objectContaining({
          creditCard: '[REDACTED]',
        })
      );
    });

    it('should scrub ssn from context', () => {
      const error = new Error('test error');
      const context = { ssn: '123-45-6789' };

      handleClientError(error, context);

      expect(logger.error).toHaveBeenCalledWith(
        'Unhandled client error',
        error,
        expect.objectContaining({
          ssn: '[REDACTED]',
        })
      );
    });

    it('should scrub authorization from context', () => {
      const error = new Error('test error');
      const context = { authorization: 'Bearer token123' };

      handleClientError(error, context);

      expect(logger.error).toHaveBeenCalledWith(
        'Unhandled client error',
        error,
        expect.objectContaining({
          authorization: '[REDACTED]',
        })
      );
    });

    it('should scrub sessionToken from context', () => {
      const error = new Error('test error');
      const context = { sessionToken: 'session-abc-123' };

      handleClientError(error, context);

      expect(logger.error).toHaveBeenCalledWith(
        'Unhandled client error',
        error,
        expect.objectContaining({
          sessionToken: '[REDACTED]',
        })
      );
    });

    it('should scrub refreshToken from context', () => {
      const error = new Error('test error');
      const context = { refreshToken: 'refresh-xyz-789' };

      handleClientError(error, context);

      expect(logger.error).toHaveBeenCalledWith(
        'Unhandled client error',
        error,
        expect.objectContaining({
          refreshToken: '[REDACTED]',
        })
      );
    });

    it('should scrub accessToken from context', () => {
      const error = new Error('test error');
      const context = { accessToken: 'access-token-456' };

      handleClientError(error, context);

      expect(logger.error).toHaveBeenCalledWith(
        'Unhandled client error',
        error,
        expect.objectContaining({
          accessToken: '[REDACTED]',
        })
      );
    });

    it('should scrub sensitive data recursively in nested objects', () => {
      const error = new Error('test error');
      const context = {
        user: {
          name: 'John',
          credentials: {
            password: 'secret123',
            apiKey: 'sk_test_123',
          },
        },
        metadata: {
          token: 'bearer-token',
        },
      };

      handleClientError(error, context);

      expect(logger.error).toHaveBeenCalledWith(
        'Unhandled client error',
        error,
        expect.objectContaining({
          user: {
            name: 'John',
            credentials: {
              password: '[REDACTED]',
              apiKey: '[REDACTED]',
            },
          },
          metadata: {
            token: '[REDACTED]',
          },
        })
      );
    });

    it('should scrub sensitive data from metadata', () => {
      const error = new Error('test error') as Error & { apiKey: string; userId: string };
      error.apiKey = 'sk_live_123';
      error.userId = 'user-123';

      handleClientError(error);

      expect(logger.error).toHaveBeenCalledWith(
        'Unhandled client error',
        error,
        expect.objectContaining({
          apiKey: '[REDACTED]',
          userId: 'user-123',
        })
      );
    });

    it('should handle arrays with sensitive data', () => {
      const error = new Error('test error');
      const context = {
        users: [
          { name: 'John', password: 'secret1' },
          { name: 'Jane', password: 'secret2' },
        ],
      };

      handleClientError(error, context);

      expect(logger.error).toHaveBeenCalledWith(
        'Unhandled client error',
        error,
        expect.objectContaining({
          users: [
            { name: 'John', password: '[REDACTED]' },
            { name: 'Jane', password: '[REDACTED]' },
          ],
        })
      );
    });
  });

  describe('Browser context (userAgent and url)', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('should include userAgent when navigator is available', () => {
      const mockNavigator = {
        userAgent: 'Mozilla/5.0 (Test Browser)',
      };
      vi.stubGlobal('navigator', mockNavigator);

      const error = new Error('test error');
      handleClientError(error);

      expect(logger.error).toHaveBeenCalledWith(
        'Unhandled client error',
        error,
        expect.objectContaining({
          userAgent: 'Mozilla/5.0 (Test Browser)',
        })
      );
    });

    it('should include url when window is available', () => {
      const mockWindow = {
        location: {
          href: 'https://example.com/test',
        },
      };
      vi.stubGlobal('window', mockWindow);

      const error = new Error('test error');
      handleClientError(error);

      expect(logger.error).toHaveBeenCalledWith(
        'Unhandled client error',
        error,
        expect.objectContaining({
          url: 'https://example.com/test',
        })
      );
    });

    it('should include both userAgent and url when both are available', () => {
      const mockNavigator = {
        userAgent: 'Mozilla/5.0 (Test Browser)',
      };
      const mockWindow = {
        location: {
          href: 'https://example.com/test',
        },
      };
      vi.stubGlobal('navigator', mockNavigator);
      vi.stubGlobal('window', mockWindow);

      const error = new Error('test error');
      handleClientError(error);

      expect(trackError).toHaveBeenCalledWith(
        error,
        expect.objectContaining({
          extra: expect.objectContaining({
            userAgent: 'Mozilla/5.0 (Test Browser)',
            url: 'https://example.com/test',
          }),
        })
      );
    });

    it('should handle missing navigator gracefully', () => {
      vi.stubGlobal('navigator', undefined);

      const error = new Error('test error');
      handleClientError(error);

      expect(logger.error).toHaveBeenCalledWith(
        'Unhandled client error',
        error,
        expect.objectContaining({
          userAgent: undefined,
        })
      );
    });

    it('should handle missing window gracefully', () => {
      vi.stubGlobal('window', undefined);

      const error = new Error('test error');
      handleClientError(error);

      expect(logger.error).toHaveBeenCalledWith(
        'Unhandled client error',
        error,
        expect.objectContaining({
          url: undefined,
        })
      );
    });
  });

  describe('Error deduplication', () => {
    it('should not process the same error twice', () => {
      const error = new Error('duplicate error');

      handleClientError(error);
      handleClientError(error);

      // Should only be called once
      expect(logger.error).toHaveBeenCalledTimes(1);
    });

    it('should process different errors separately', () => {
      const error1 = new Error('error 1');
      const error2 = new Error('error 2');

      handleClientError(error1);
      handleClientError(error2);

      // Should be called twice
      expect(logger.error).toHaveBeenCalledTimes(2);
    });

    it('should use error message and stack for fingerprinting', () => {
      const error1 = new Error('same message');
      const error2 = new Error('same message');
      // Different stack traces make them unique

      // Clear mocks to get fresh count
      vi.clearAllMocks();

      handleClientError(error1);
      handleClientError(error2);

      // Both should be processed because they have different stacks
      // (created at different times/lines)
      expect(logger.error).toHaveBeenCalledTimes(2);
    });

    it('should cleanup old errors when exceeding MAX_PROCESSED_ERRORS (100)', () => {
      // Clear mocks
      vi.clearAllMocks();

      // Generate 101 unique errors to trigger cleanup
      for (let i = 0; i < 101; i++) {
        const error = new Error(`unique error ${i}`);
        handleClientError(error);
      }

      // All 101 should be processed
      expect(logger.error).toHaveBeenCalledTimes(101);

      // Now the first error should be removed from the Set, so it can be processed again
      const firstError = new Error('unique error 0');
      handleClientError(firstError);

      // Should be processed (102 total calls now)
      expect(logger.error).toHaveBeenCalledTimes(102);
    });
  });
});

describe('initGlobalErrorHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('SSR safety', () => {
    it('should return undefined when window is undefined (SSR)', () => {
      vi.stubGlobal('window', undefined);

      const cleanup = initGlobalErrorHandler();

      expect(cleanup).toBeUndefined();
    });

    it('should not initialize when running on server', () => {
      vi.stubGlobal('window', undefined);

      initGlobalErrorHandler();

      expect(logger.debug).not.toHaveBeenCalled();
    });
  });

  describe('Initialization', () => {
    it('should add event listeners to window', () => {
      const mockWindow = {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      };
      vi.stubGlobal('window', mockWindow);

      initGlobalErrorHandler();

      expect(mockWindow.addEventListener).toHaveBeenCalledWith(
        'unhandledrejection',
        expect.any(Function)
      );
      expect(mockWindow.addEventListener).toHaveBeenCalledWith('error', expect.any(Function));
    });

    it('should log initialization message', () => {
      const mockWindow = {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      };
      vi.stubGlobal('window', mockWindow);

      initGlobalErrorHandler();

      expect(logger.debug).toHaveBeenCalledWith('Global error handler initialized');
    });

    it('should set __errorHandlerInitialized flag on window', () => {
      const mockWindow = {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      };
      vi.stubGlobal('window', mockWindow);

      initGlobalErrorHandler();

      expect(
        (mockWindow as { __errorHandlerInitialized?: boolean }).__errorHandlerInitialized
      ).toBe(true);
    });

    it('should return cleanup function', () => {
      const mockWindow = {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      };
      vi.stubGlobal('window', mockWindow);

      const cleanup = initGlobalErrorHandler();

      expect(cleanup).toBeInstanceOf(Function);
    });
  });

  describe('Double initialization prevention', () => {
    it('should not initialize twice if already initialized', () => {
      const mockWindow = {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        __errorHandlerInitialized: true,
      };
      vi.stubGlobal('window', mockWindow);

      const cleanup = initGlobalErrorHandler();

      expect(cleanup).toBeUndefined();
      expect(mockWindow.addEventListener).not.toHaveBeenCalled();
    });

    it('should allow re-initialization after cleanup', () => {
      const mockWindow = {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      };
      vi.stubGlobal('window', mockWindow);

      const cleanup = initGlobalErrorHandler();
      expect(cleanup).toBeInstanceOf(Function);

      // Call cleanup
      cleanup!();

      // Should be able to initialize again
      vi.clearAllMocks();
      const cleanup2 = initGlobalErrorHandler();

      expect(cleanup2).toBeInstanceOf(Function);
      expect(mockWindow.addEventListener).toHaveBeenCalledTimes(2);
    });
  });

  describe('Cleanup function', () => {
    it('should remove event listeners when called', () => {
      const mockWindow = {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      };
      vi.stubGlobal('window', mockWindow);

      const cleanup = initGlobalErrorHandler();
      cleanup!();

      expect(mockWindow.removeEventListener).toHaveBeenCalledWith(
        'unhandledrejection',
        expect.any(Function)
      );
      expect(mockWindow.removeEventListener).toHaveBeenCalledWith('error', expect.any(Function));
    });

    it('should reset __errorHandlerInitialized flag', () => {
      const mockWindow = {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      };
      vi.stubGlobal('window', mockWindow);

      const cleanup = initGlobalErrorHandler();
      expect(
        (mockWindow as { __errorHandlerInitialized?: boolean }).__errorHandlerInitialized
      ).toBe(true);

      cleanup!();

      expect(
        (mockWindow as { __errorHandlerInitialized?: boolean }).__errorHandlerInitialized
      ).toBe(false);
    });
  });

  describe('Event handling', () => {
    it('should handle unhandledrejection events', () => {
      const mockWindow = {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        location: {
          href: 'https://example.com',
        },
      };
      vi.stubGlobal('window', mockWindow);

      initGlobalErrorHandler();

      // Get the handler that was registered
      const unhandledRejectionHandler = mockWindow.addEventListener.mock.calls.find(
        (call) => call[0] === 'unhandledrejection'
      )?.[1] as (event: PromiseRejectionEvent) => void;

      expect(unhandledRejectionHandler).toBeDefined();

      // Clear mocks to test handler behavior
      vi.clearAllMocks();

      // Simulate unhandledrejection event
      const mockEvent = {
        reason: new Error('Unhandled promise rejection'),
      } as PromiseRejectionEvent;

      unhandledRejectionHandler(mockEvent);

      // Should call logger.error with errorType: 'unhandled' (hardcoded in handleClientError)
      // The context.errorType is passed but then overridden by the hardcoded value
      expect(logger.error).toHaveBeenCalledWith(
        'Unhandled client error',
        expect.any(Error),
        expect.objectContaining({
          errorType: 'unhandled',
        })
      );
    });

    it('should handle error events', () => {
      const mockWindow = {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        location: {
          href: 'https://example.com',
        },
      };
      vi.stubGlobal('window', mockWindow);

      initGlobalErrorHandler();

      // Get the handler that was registered
      const errorHandler = mockWindow.addEventListener.mock.calls.find(
        (call) => call[0] === 'error'
      )?.[1] as (event: ErrorEvent) => void;

      expect(errorHandler).toBeDefined();

      // Clear mocks to test handler behavior
      vi.clearAllMocks();

      // Simulate error event
      const mockEvent = {
        error: new Error('Uncaught error'),
        message: 'Uncaught error',
        filename: 'test.js',
        lineno: 42,
        colno: 15,
      } as ErrorEvent;

      errorHandler(mockEvent);

      // Should call logger.error with errorType: 'unhandled' (hardcoded in handleClientError) and location info
      expect(logger.error).toHaveBeenCalledWith(
        'Unhandled client error',
        expect.any(Error),
        expect.objectContaining({
          errorType: 'unhandled',
          filename: 'test.js',
          lineno: 42,
          colno: 15,
        })
      );
    });

    it('should handle error events without error object (fallback to message)', () => {
      const mockWindow = {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        location: {
          href: 'https://example.com',
        },
      };
      vi.stubGlobal('window', mockWindow);

      initGlobalErrorHandler();

      // Get the handler that was registered
      const errorHandler = mockWindow.addEventListener.mock.calls.find(
        (call) => call[0] === 'error'
      )?.[1] as (event: ErrorEvent) => void;

      // Clear mocks to test handler behavior
      vi.clearAllMocks();

      // Simulate error event without error object
      const mockEvent = {
        error: null,
        message: 'Script error',
        filename: 'unknown',
        lineno: 0,
        colno: 0,
      } as ErrorEvent;

      errorHandler(mockEvent);

      // Should still be called with the message and errorType: 'unhandled'
      expect(logger.error).toHaveBeenCalledWith(
        'Unhandled client error',
        expect.any(Error),
        expect.objectContaining({
          errorType: 'unhandled',
        })
      );
    });
  });
});
