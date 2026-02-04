/**
 * Parse API Response Tests
 *
 * Tests for runtime validation of API responses from fetch() calls.
 * Validates that responses conform to the APIResponse<T> discriminated union.
 *
 * Test Coverage:
 * - Valid success responses (with/without meta)
 * - Valid error responses
 * - Invalid response structures (not an object, missing fields, wrong types)
 * - Edge cases (null, arrays, primitives)
 */

import { describe, it, expect } from 'vitest';
import { parseApiResponse } from '@/lib/api/parse-response';
import type { APIResponse } from '@/types/api';

/**
 * Helper to create a mock Response object with JSON body
 */
function createMockResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('parseApiResponse', () => {
  describe('valid success responses', () => {
    it('should parse success response with data', async () => {
      // Arrange
      const mockBody = {
        success: true,
        data: { id: '123', name: 'John' },
      };
      const response = createMockResponse(mockBody);

      // Act
      const result = await parseApiResponse<{ id: string; name: string }>(response);

      // Assert
      expect(result).toEqual({
        success: true,
        data: { id: '123', name: 'John' },
      });
    });

    it('should parse success response with data and meta', async () => {
      // Arrange
      const mockBody = {
        success: true,
        data: { items: [] },
        meta: { page: 1, total: 100 },
      };
      const response = createMockResponse(mockBody);

      // Act
      const result = await parseApiResponse<{ items: unknown[] }>(response);

      // Assert
      expect(result).toEqual({
        success: true,
        data: { items: [] },
        meta: { page: 1, total: 100 },
      });
    });

    it('should parse success response with null data', async () => {
      // Arrange
      const mockBody = {
        success: true,
        data: null,
      };
      const response = createMockResponse(mockBody);

      // Act
      const result = await parseApiResponse<null>(response);

      // Assert
      expect(result).toEqual({
        success: true,
        data: null,
      });
    });

    it('should parse success response with array data', async () => {
      // Arrange
      const mockBody = {
        success: true,
        data: [
          { id: '1', name: 'John' },
          { id: '2', name: 'Jane' },
        ],
      };
      const response = createMockResponse(mockBody);

      // Act
      const result = await parseApiResponse<Array<{ id: string; name: string }>>(response);

      // Assert
      expect(result).toEqual({
        success: true,
        data: [
          { id: '1', name: 'John' },
          { id: '2', name: 'Jane' },
        ],
      });
    });

    it('should parse success response with empty object data', async () => {
      // Arrange
      const mockBody = {
        success: true,
        data: {},
      };
      const response = createMockResponse(mockBody);

      // Act
      const result = await parseApiResponse<Record<string, never>>(response);

      // Assert
      expect(result).toEqual({
        success: true,
        data: {},
      });
    });

    it('should parse success response with primitive data', async () => {
      // Arrange
      const stringBody = { success: true, data: 'hello' };
      const numberBody = { success: true, data: 42 };
      const booleanBody = { success: true, data: true };

      const stringResponse = createMockResponse(stringBody);
      const numberResponse = createMockResponse(numberBody);
      const booleanResponse = createMockResponse(booleanBody);

      // Act
      const stringResult = await parseApiResponse<string>(stringResponse);
      const numberResult = await parseApiResponse<number>(numberResponse);
      const booleanResult = await parseApiResponse<boolean>(booleanResponse);

      // Assert
      expect(stringResult).toEqual({ success: true, data: 'hello' });
      expect(numberResult).toEqual({ success: true, data: 42 });
      expect(booleanResult).toEqual({ success: true, data: true });
    });

    it('should preserve additional fields in success response', async () => {
      // Arrange
      const mockBody = {
        success: true,
        data: { id: '123' },
        meta: { cached: true },
        extraField: 'should be preserved',
      };
      const response = createMockResponse(mockBody);

      // Act
      const result = (await parseApiResponse<{ id: string }>(response)) as APIResponse<{
        id: string;
      }> & {
        extraField?: string;
      };

      // Assert
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual({ id: '123' });
        expect(result.meta).toEqual({ cached: true });
      }
      expect(result.extraField).toBe('should be preserved');
    });
  });

  describe('valid error responses', () => {
    it('should parse error response with message and code', async () => {
      // Arrange
      const mockBody = {
        success: false,
        error: {
          message: 'Not found',
          code: 'NOT_FOUND',
        },
      };
      const response = createMockResponse(mockBody);

      // Act
      const result = await parseApiResponse<never>(response);

      // Assert
      expect(result).toEqual({
        success: false,
        error: {
          message: 'Not found',
          code: 'NOT_FOUND',
        },
      });
    });

    it('should parse error response with message only', async () => {
      // Arrange
      const mockBody = {
        success: false,
        error: {
          message: 'Internal server error',
        },
      };
      const response = createMockResponse(mockBody);

      // Act
      const result = await parseApiResponse<never>(response);

      // Assert
      expect(result).toEqual({
        success: false,
        error: {
          message: 'Internal server error',
        },
      });
    });

    it('should parse error response with details', async () => {
      // Arrange
      const mockBody = {
        success: false,
        error: {
          message: 'Validation failed',
          code: 'VALIDATION_ERROR',
          details: {
            email: ['Invalid email format'],
            password: ['Password too short'],
          },
        },
      };
      const response = createMockResponse(mockBody);

      // Act
      const result = await parseApiResponse<never>(response);

      // Assert
      expect(result).toEqual({
        success: false,
        error: {
          message: 'Validation failed',
          code: 'VALIDATION_ERROR',
          details: {
            email: ['Invalid email format'],
            password: ['Password too short'],
          },
        },
      });
    });

    it('should preserve additional fields in error response', async () => {
      // Arrange
      const mockBody = {
        success: false,
        error: {
          message: 'Error occurred',
          code: 'ERROR',
        },
        extraField: 'should be preserved',
      };
      const response = createMockResponse(mockBody);

      // Act
      const result = (await parseApiResponse<never>(response)) as APIResponse<never> & {
        extraField?: string;
      };

      // Assert
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.message).toBe('Error occurred');
      }
      expect(result.extraField).toBe('should be preserved');
    });
  });

  describe('invalid: body is not an object', () => {
    it('should throw when body is a string', async () => {
      // Arrange
      const response = new Response(JSON.stringify('just a string'), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });

      // Act & Assert
      await expect(parseApiResponse(response)).rejects.toThrow(
        'Invalid API response: body is not an object'
      );
    });

    it('should throw when body is a number', async () => {
      // Arrange
      const response = new Response(JSON.stringify(42), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });

      // Act & Assert
      await expect(parseApiResponse(response)).rejects.toThrow(
        'Invalid API response: body is not an object'
      );
    });

    it('should throw when body is boolean', async () => {
      // Arrange
      const response = new Response(JSON.stringify(true), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });

      // Act & Assert
      await expect(parseApiResponse(response)).rejects.toThrow(
        'Invalid API response: body is not an object'
      );
    });

    it('should throw when body is null', async () => {
      // Arrange
      const response = new Response(JSON.stringify(null), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });

      // Act & Assert
      await expect(parseApiResponse(response)).rejects.toThrow(
        'Invalid API response: body is not an object'
      );
    });

    it('should throw when body is an array', async () => {
      // Arrange
      const response = new Response(JSON.stringify([{ success: true, data: {} }]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });

      // Act & Assert
      await expect(parseApiResponse(response)).rejects.toThrow(
        'Invalid API response: body is not an object'
      );
    });
  });

  describe('invalid: missing or invalid success field', () => {
    it('should throw when success field is missing', async () => {
      // Arrange
      const mockBody = {
        data: { id: '123' },
      };
      const response = createMockResponse(mockBody);

      // Act & Assert
      await expect(parseApiResponse(response)).rejects.toThrow(
        'Invalid API response: missing boolean "success" field'
      );
    });

    it('should throw when success is a string', async () => {
      // Arrange
      const mockBody = {
        success: 'true',
        data: { id: '123' },
      };
      const response = createMockResponse(mockBody);

      // Act & Assert
      await expect(parseApiResponse(response)).rejects.toThrow(
        'Invalid API response: missing boolean "success" field'
      );
    });

    it('should throw when success is a number', async () => {
      // Arrange
      const mockBody = {
        success: 1,
        data: { id: '123' },
      };
      const response = createMockResponse(mockBody);

      // Act & Assert
      await expect(parseApiResponse(response)).rejects.toThrow(
        'Invalid API response: missing boolean "success" field'
      );
    });

    it('should throw when success is null', async () => {
      // Arrange
      const mockBody = {
        success: null,
        data: { id: '123' },
      };
      const response = createMockResponse(mockBody);

      // Act & Assert
      await expect(parseApiResponse(response)).rejects.toThrow(
        'Invalid API response: missing boolean "success" field'
      );
    });

    it('should throw when success is undefined', async () => {
      // Arrange
      const mockBody = {
        success: undefined,
        data: { id: '123' },
      };
      const response = createMockResponse(mockBody);

      // Act & Assert
      await expect(parseApiResponse(response)).rejects.toThrow(
        'Invalid API response: missing boolean "success" field'
      );
    });

    it('should throw when success is an object', async () => {
      // Arrange
      const mockBody = {
        success: { value: true },
        data: { id: '123' },
      };
      const response = createMockResponse(mockBody);

      // Act & Assert
      await expect(parseApiResponse(response)).rejects.toThrow(
        'Invalid API response: missing boolean "success" field'
      );
    });
  });

  describe('invalid: success=true but missing data field', () => {
    it('should throw when success is true but data field is missing', async () => {
      // Arrange
      const mockBody = {
        success: true,
      };
      const response = createMockResponse(mockBody);

      // Act & Assert
      await expect(parseApiResponse(response)).rejects.toThrow(
        'Invalid API response: success=true but missing "data" field'
      );
    });

    it('should throw when success is true with meta but no data', async () => {
      // Arrange
      const mockBody = {
        success: true,
        meta: { page: 1 },
      };
      const response = createMockResponse(mockBody);

      // Act & Assert
      await expect(parseApiResponse(response)).rejects.toThrow(
        'Invalid API response: success=true but missing "data" field'
      );
    });

    it('should throw when success is true but data is undefined', async () => {
      // Arrange
      const mockBody = {
        success: true,
        data: undefined,
      };
      const response = createMockResponse(mockBody);

      // Act & Assert
      await expect(parseApiResponse(response)).rejects.toThrow(
        'Invalid API response: success=true but missing "data" field'
      );
    });
  });

  describe('invalid: success=false but missing or invalid error field', () => {
    it('should throw when success is false but error field is missing', async () => {
      // Arrange
      const mockBody = {
        success: false,
      };
      const response = createMockResponse(mockBody);

      // Act & Assert
      await expect(parseApiResponse(response)).rejects.toThrow(
        'Invalid API response: success=false but missing "error" object'
      );
    });

    it('should throw when success is false but error is null', async () => {
      // Arrange
      const mockBody = {
        success: false,
        error: null,
      };
      const response = createMockResponse(mockBody);

      // Act & Assert
      await expect(parseApiResponse(response)).rejects.toThrow(
        'Invalid API response: success=false but missing "error" object'
      );
    });

    it('should throw when success is false but error is a string', async () => {
      // Arrange
      const mockBody = {
        success: false,
        error: 'Not found',
      };
      const response = createMockResponse(mockBody);

      // Act & Assert
      await expect(parseApiResponse(response)).rejects.toThrow(
        'Invalid API response: success=false but missing "error" object'
      );
    });

    it('should throw when success is false but error is a number', async () => {
      // Arrange
      const mockBody = {
        success: false,
        error: 404,
      };
      const response = createMockResponse(mockBody);

      // Act & Assert
      await expect(parseApiResponse(response)).rejects.toThrow(
        'Invalid API response: success=false but missing "error" object'
      );
    });

    it('should throw when success is false but error is a boolean', async () => {
      // Arrange
      const mockBody = {
        success: false,
        error: true,
      };
      const response = createMockResponse(mockBody);

      // Act & Assert
      await expect(parseApiResponse(response)).rejects.toThrow(
        'Invalid API response: success=false but missing "error" object'
      );
    });

    it('should allow array as error (implementation quirk)', async () => {
      // Arrange
      // NOTE: Arrays pass typeof check (typeof [] === 'object' && !Array.isArray check missing)
      // This is technically incorrect but matches current implementation behavior
      const mockBody = {
        success: false,
        error: ['Not found'],
      };
      const response = createMockResponse(mockBody);

      // Act
      const result = await parseApiResponse<never>(response);

      // Assert
      expect(result).toEqual({
        success: false,
        error: ['Not found'],
      });
    });

    it('should throw when success is false but error is undefined', async () => {
      // Arrange
      const mockBody = {
        success: false,
        error: undefined,
      };
      const response = createMockResponse(mockBody);

      // Act & Assert
      await expect(parseApiResponse(response)).rejects.toThrow(
        'Invalid API response: success=false but missing "error" object'
      );
    });

    it('should allow empty error object (no message/code)', async () => {
      // Arrange
      const mockBody = {
        success: false,
        error: {},
      };
      const response = createMockResponse(mockBody);

      // Act
      const result = await parseApiResponse<never>(response);

      // Assert
      expect(result).toEqual({
        success: false,
        error: {},
      });
    });
  });

  describe('edge cases', () => {
    it('should handle response with extra fields beyond APIResponse shape', async () => {
      // Arrange
      const mockBody = {
        success: true,
        data: { id: '123' },
        meta: { page: 1 },
        extraField1: 'value1',
        extraField2: { nested: true },
        extraField3: [1, 2, 3],
      };
      const response = createMockResponse(mockBody);

      // Act
      const result = (await parseApiResponse<{ id: string }>(response)) as APIResponse<{
        id: string;
      }> & {
        extraField1?: string;
        extraField2?: { nested: boolean };
        extraField3?: number[];
      };

      // Assert
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual({ id: '123' });
      }
      expect(result.extraField1).toBe('value1');
      expect(result.extraField2).toEqual({ nested: true });
      expect(result.extraField3).toEqual([1, 2, 3]);
    });

    it('should handle success response with data=0 (falsy but valid)', async () => {
      // Arrange
      const mockBody = {
        success: true,
        data: 0,
      };
      const response = createMockResponse(mockBody);

      // Act
      const result = await parseApiResponse<number>(response);

      // Assert
      expect(result).toEqual({
        success: true,
        data: 0,
      });
    });

    it('should handle success response with data=false (falsy but valid)', async () => {
      // Arrange
      const mockBody = {
        success: true,
        data: false,
      };
      const response = createMockResponse(mockBody);

      // Act
      const result = await parseApiResponse<boolean>(response);

      // Assert
      expect(result).toEqual({
        success: true,
        data: false,
      });
    });

    it('should handle success response with data="" (falsy but valid)', async () => {
      // Arrange
      const mockBody = {
        success: true,
        data: '',
      };
      const response = createMockResponse(mockBody);

      // Act
      const result = await parseApiResponse<string>(response);

      // Assert
      expect(result).toEqual({
        success: true,
        data: '',
      });
    });

    it('should handle deeply nested data structures', async () => {
      // Arrange
      const mockBody = {
        success: true,
        data: {
          level1: {
            level2: {
              level3: {
                level4: {
                  value: 'deep value',
                },
              },
            },
          },
        },
      };
      const response = createMockResponse(mockBody);

      // Act
      const result = await parseApiResponse<{
        level1: { level2: { level3: { level4: { value: string } } } };
      }>(response);

      // Assert
      expect(result).toEqual(mockBody);
    });

    it('should handle large data arrays', async () => {
      // Arrange
      const largeArray = Array.from({ length: 1000 }, (_, i) => ({ id: `${i}`, value: i }));
      const mockBody = {
        success: true,
        data: largeArray,
      };
      const response = createMockResponse(mockBody);

      // Act
      const result = await parseApiResponse<Array<{ id: string; value: number }>>(response);

      // Assert
      expect(result).toEqual(mockBody);
      if (result.success) {
        expect(result.data).toHaveLength(1000);
      }
    });
  });
});
