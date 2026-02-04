/**
 * Error Handler Tests
 *
 * Tests for normalizeError function in lib/errors/handler.ts
 *
 * Test Coverage:
 * - Case 1: Error instances (standard Error, Error with extra properties)
 * - Case 2: String errors
 * - Case 3: Objects with message property
 * - Case 4: Objects without message property
 * - Case 5: Primitives (null, undefined, numbers)
 *
 * Note: This test file focuses on the pure normalizeError function.
 * handleClientError and initGlobalErrorHandler are not tested here as they
 * depend on browser globals (window, navigator) and Sentry integration.
 *
 * @see lib/errors/handler.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { normalizeError } from '@/lib/errors/handler';

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
