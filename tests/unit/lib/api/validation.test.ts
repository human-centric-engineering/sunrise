/**
 * API Request Validation Tests
 *
 * Tests for validation utilities in lib/api/validation.ts
 * - validateRequestBody() - Request body parsing and validation
 * - validateQueryParams() - Query parameter validation
 * - parsePaginationParams() - Pagination parameter parsing with defaults
 */

import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { NextRequest } from 'next/server';
import {
  validateRequestBody,
  validateQueryParams,
  parsePaginationParams,
} from '@/lib/api/validation';
import { ValidationError } from '@/lib/api/errors';

describe('validateRequestBody()', () => {
  describe('valid JSON body', () => {
    it('should parse and validate correct data', async () => {
      // Arrange: Create a test schema and mock request
      const testSchema = z.object({
        name: z.string(),
        email: z.string().email(),
      });

      const validData = { name: 'John Doe', email: 'john@example.com' };
      const mockJsonFn = vi.fn().mockResolvedValue(validData);
      const mockRequest = {
        json: mockJsonFn,
      } as unknown as NextRequest;

      // Act: Validate the request body
      const result = await validateRequestBody(mockRequest, testSchema);

      // Assert: Returns parsed data matching schema
      expect(result).toEqual(validData);
      expect(result.name).toBe('John Doe');
      expect(result.email).toBe('john@example.com');
      expect(mockJsonFn).toHaveBeenCalledTimes(1);
    });

    it('should return type-safe data based on schema', async () => {
      // Arrange: Schema with specific types
      const testSchema = z.object({
        count: z.number(),
        active: z.boolean(),
      });

      const validData = { count: 42, active: true };
      const mockRequest = {
        json: vi.fn().mockResolvedValue(validData),
      } as unknown as NextRequest;

      // Act
      const result = await validateRequestBody(mockRequest, testSchema);

      // Assert: Type-safe access to properties
      expect(result.count).toBe(42);
      expect(result.active).toBe(true);
      expect(typeof result.count).toBe('number');
      expect(typeof result.active).toBe('boolean');
    });

    it('should handle nested objects in schema', async () => {
      // Arrange: Schema with nested structure
      const testSchema = z.object({
        user: z.object({
          name: z.string(),
          age: z.number(),
        }),
      });

      const validData = { user: { name: 'Jane', age: 30 } };
      const mockRequest = {
        json: vi.fn().mockResolvedValue(validData),
      } as unknown as NextRequest;

      // Act
      const result = await validateRequestBody(mockRequest, testSchema);

      // Assert
      expect(result.user.name).toBe('Jane');
      expect(result.user.age).toBe(30);
    });
  });

  describe('invalid data', () => {
    it('should throw ValidationError for invalid data', async () => {
      // Arrange: Schema expects email, but gets invalid format
      const testSchema = z.object({
        email: z.string().email(),
      });

      const invalidData = { email: 'not-an-email' };
      const mockRequest = {
        json: vi.fn().mockResolvedValue(invalidData),
      } as unknown as NextRequest;

      // Act & Assert: Throws ValidationError
      await expect(validateRequestBody(mockRequest, testSchema)).rejects.toThrow(ValidationError);
    });

    it('should format error details correctly', async () => {
      // Arrange: Schema with multiple validation rules
      const testSchema = z.object({
        name: z.string().min(3),
        email: z.string().email(),
      });

      const invalidData = { name: 'Jo', email: 'bad-email' };
      const mockRequest = {
        json: vi.fn().mockResolvedValue(invalidData),
      } as unknown as NextRequest;

      // Act & Assert: Check error structure
      try {
        await validateRequestBody(mockRequest, testSchema);
        expect.fail('Should have thrown ValidationError');
      } catch (error) {
        expect(error).toBeInstanceOf(ValidationError);
        if (error instanceof ValidationError) {
          expect(error.message).toBe('Invalid request body');
          expect(error.code).toBe('VALIDATION_ERROR');
          expect(error.status).toBe(400);
          expect(error.details).toBeDefined();
          expect(error.details).toHaveProperty('errors');
        }
      }
    });

    it('should include field paths in error details', async () => {
      // Arrange: Schema with nested validation
      const testSchema = z.object({
        user: z.object({
          email: z.string().email(),
        }),
      });

      const invalidData = { user: { email: 'invalid' } };
      const mockRequest = {
        json: vi.fn().mockResolvedValue(invalidData),
      } as unknown as NextRequest;

      // Act & Assert: Check error path
      try {
        await validateRequestBody(mockRequest, testSchema);
        expect.fail('Should have thrown ValidationError');
      } catch (error) {
        if (error instanceof ValidationError && error.details?.errors) {
          const errors = error.details.errors as Array<{ path: string; message: string }>;
          expect(errors[0].path).toBe('user.email');
          expect(errors[0].message).toContain('Invalid email');
        }
      }
    });

    it('should handle missing required fields', async () => {
      // Arrange: Schema requires fields
      const testSchema = z.object({
        name: z.string(),
        email: z.string(),
      });

      const incompleteData = { name: 'John' }; // Missing email
      const mockRequest = {
        json: vi.fn().mockResolvedValue(incompleteData),
      } as unknown as NextRequest;

      // Act & Assert
      await expect(validateRequestBody(mockRequest, testSchema)).rejects.toThrow(ValidationError);
    });
  });

  describe('malformed JSON', () => {
    it('should throw ValidationError for invalid JSON', async () => {
      // Arrange: Mock request.json() to throw SyntaxError (malformed JSON)
      const mockRequest = {
        json: vi.fn().mockRejectedValue(new SyntaxError('Unexpected token')),
      } as unknown as NextRequest;

      const testSchema = z.object({ name: z.string() });

      // Act & Assert: Throws ValidationError with JSON error message
      try {
        await validateRequestBody(mockRequest, testSchema);
        expect.fail('Should have thrown ValidationError');
      } catch (error) {
        expect(error).toBeInstanceOf(ValidationError);
        if (error instanceof ValidationError) {
          expect(error.message).toBe('Invalid JSON in request body');
          expect(error.code).toBe('VALIDATION_ERROR');
          expect(error.status).toBe(400);
        }
      }
    });

    it('should handle JSON parsing errors gracefully', async () => {
      // Arrange: Simulate various JSON parsing errors
      const mockRequest = {
        json: vi.fn().mockRejectedValue(new Error('Unexpected end of JSON input')),
      } as unknown as NextRequest;

      const testSchema = z.object({ data: z.string() });

      // Act & Assert
      await expect(validateRequestBody(mockRequest, testSchema)).rejects.toThrow(
        'Invalid JSON in request body'
      );
    });
  });

  describe('empty body', () => {
    it('should throw ValidationError for empty body', async () => {
      // Arrange: Request with empty body
      const mockRequest = {
        json: vi.fn().mockResolvedValue(null),
      } as unknown as NextRequest;

      const testSchema = z.object({ name: z.string() });

      // Act & Assert: Throws appropriate error
      await expect(validateRequestBody(mockRequest, testSchema)).rejects.toThrow(ValidationError);
    });

    it('should throw ValidationError for undefined body', async () => {
      // Arrange
      const mockRequest = {
        json: vi.fn().mockResolvedValue(undefined),
      } as unknown as NextRequest;

      const testSchema = z.object({ name: z.string() });

      // Act & Assert
      await expect(validateRequestBody(mockRequest, testSchema)).rejects.toThrow(ValidationError);
    });

    it('should throw ValidationError for empty object when fields required', async () => {
      // Arrange
      const mockRequest = {
        json: vi.fn().mockResolvedValue({}),
      } as unknown as NextRequest;

      const testSchema = z.object({
        name: z.string(),
        email: z.string(),
      });

      // Act & Assert
      await expect(validateRequestBody(mockRequest, testSchema)).rejects.toThrow(ValidationError);
    });
  });
});

describe('validateQueryParams()', () => {
  describe('valid query params', () => {
    it('should parse URLSearchParams correctly', () => {
      // Arrange: Create URLSearchParams with page and limit
      const searchParams = new URLSearchParams('page=1&limit=20');
      const testSchema = z.object({
        page: z.string(),
        limit: z.string(),
      });

      // Act
      const result = validateQueryParams(searchParams, testSchema);

      // Assert: Returns parsed query params
      expect(result).toEqual({ page: '1', limit: '20' });
    });

    it('should handle single query parameter', () => {
      // Arrange
      const searchParams = new URLSearchParams('search=test');
      const testSchema = z.object({
        search: z.string(),
      });

      // Act
      const result = validateQueryParams(searchParams, testSchema);

      // Assert
      expect(result.search).toBe('test');
    });

    it('should coerce string to number when schema uses coercion', () => {
      // Arrange: Schema with number coercion
      const searchParams = new URLSearchParams('page=3&limit=50');
      const testSchema = z.object({
        page: z.coerce.number(),
        limit: z.coerce.number(),
      });

      // Act: Validate and coerce
      const result = validateQueryParams(searchParams, testSchema);

      // Assert: Values are coerced to numbers
      expect(result.page).toBe(3);
      expect(result.limit).toBe(50);
      expect(typeof result.page).toBe('number');
      expect(typeof result.limit).toBe('number');
    });

    it('should handle optional parameters with defaults', () => {
      // Arrange: Schema with default values
      const searchParams = new URLSearchParams(''); // Empty params
      const testSchema = z.object({
        page: z.string().default('1'),
        limit: z.string().default('20'),
      });

      // Act
      const result = validateQueryParams(searchParams, testSchema);

      // Assert: Returns default values
      expect(result.page).toBe('1');
      expect(result.limit).toBe('20');
    });

    it('should handle multiple parameters', () => {
      // Arrange
      const searchParams = new URLSearchParams('sort=name&order=asc&filter=active');
      const testSchema = z.object({
        sort: z.string(),
        order: z.string(),
        filter: z.string(),
      });

      // Act
      const result = validateQueryParams(searchParams, testSchema);

      // Assert
      expect(result.sort).toBe('name');
      expect(result.order).toBe('asc');
      expect(result.filter).toBe('active');
    });
  });

  describe('invalid params', () => {
    it('should throw ValidationError for invalid params', () => {
      // Arrange: Schema expects number, gets non-numeric string
      const searchParams = new URLSearchParams('page=abc');
      const testSchema = z.object({
        page: z.coerce.number(),
      });

      // Act & Assert: Throws ValidationError with details
      expect(() => validateQueryParams(searchParams, testSchema)).toThrow(ValidationError);
    });

    it('should format validation errors correctly', () => {
      // Arrange: Schema with validation rules
      const searchParams = new URLSearchParams('email=invalid');
      const testSchema = z.object({
        email: z.string().email(),
      });

      // Act & Assert: Check error structure
      try {
        validateQueryParams(searchParams, testSchema);
        expect.fail('Should have thrown ValidationError');
      } catch (error) {
        expect(error).toBeInstanceOf(ValidationError);
        if (error instanceof ValidationError) {
          expect(error.message).toBe('Invalid query parameters');
          expect(error.code).toBe('VALIDATION_ERROR');
          expect(error.status).toBe(400);
          expect(error.details).toBeDefined();
        }
      }
    });

    it('should handle missing required parameters', () => {
      // Arrange: Schema requires parameter, but not provided
      const searchParams = new URLSearchParams('');
      const testSchema = z.object({
        required: z.string(),
      });

      // Act & Assert
      expect(() => validateQueryParams(searchParams, testSchema)).toThrow(ValidationError);
    });

    it('should validate enum values', () => {
      // Arrange: Schema with enum constraint
      const searchParams = new URLSearchParams('status=invalid');
      const testSchema = z.object({
        status: z.enum(['active', 'inactive', 'pending']),
      });

      // Act & Assert
      expect(() => validateQueryParams(searchParams, testSchema)).toThrow(ValidationError);
    });
  });

  describe('missing params', () => {
    it('should use defaults from schema when params missing', () => {
      // Arrange: Empty URLSearchParams with schema defaults
      const searchParams = new URLSearchParams('');
      const testSchema = z.object({
        page: z.coerce.number().default(1),
        limit: z.coerce.number().default(20),
      });

      // Act
      const result = validateQueryParams(searchParams, testSchema);

      // Assert: Returns default values
      expect(result.page).toBe(1);
      expect(result.limit).toBe(20);
    });

    it('should make optional parameters truly optional', () => {
      // Arrange: Schema with optional fields
      const searchParams = new URLSearchParams('name=John');
      const testSchema = z.object({
        name: z.string(),
        age: z.coerce.number().optional(),
      });

      // Act
      const result = validateQueryParams(searchParams, testSchema);

      // Assert
      expect(result.name).toBe('John');
      expect(result.age).toBeUndefined();
    });
  });
});

describe('parsePaginationParams()', () => {
  describe('default values', () => {
    it('should return defaults when not provided', () => {
      // Arrange: Empty URLSearchParams
      const searchParams = new URLSearchParams('');

      // Act
      const result = parsePaginationParams(searchParams);

      // Assert: Returns { page: 1, limit: 20, skip: 0 }
      expect(result).toEqual({
        page: 1,
        limit: 20,
        skip: 0,
      });
    });

    it('should return default page when only limit provided', () => {
      // Arrange
      const searchParams = new URLSearchParams('limit=50');

      // Act
      const result = parsePaginationParams(searchParams);

      // Assert
      expect(result.page).toBe(1);
      expect(result.limit).toBe(50);
      expect(result.skip).toBe(0);
    });

    it('should return default limit when only page provided', () => {
      // Arrange
      const searchParams = new URLSearchParams('page=2');

      // Act
      const result = parsePaginationParams(searchParams);

      // Assert
      expect(result.page).toBe(2);
      expect(result.limit).toBe(20);
      expect(result.skip).toBe(20); // (2-1) * 20
    });
  });

  describe('custom values', () => {
    it('should parse custom page and limit', () => {
      // Arrange: Custom pagination params
      const searchParams = new URLSearchParams('page=3&limit=50');

      // Act
      const result = parsePaginationParams(searchParams);

      // Assert: Returns { page: 3, limit: 50, skip: 100 }
      expect(result).toEqual({
        page: 3,
        limit: 50,
        skip: 100, // (3-1) * 50
      });
    });

    it('should handle page=1 with custom limit', () => {
      // Arrange
      const searchParams = new URLSearchParams('page=1&limit=10');

      // Act
      const result = parsePaginationParams(searchParams);

      // Assert
      expect(result.page).toBe(1);
      expect(result.limit).toBe(10);
      expect(result.skip).toBe(0);
    });

    it('should handle large page numbers', () => {
      // Arrange
      const searchParams = new URLSearchParams('page=100&limit=25');

      // Act
      const result = parsePaginationParams(searchParams);

      // Assert
      expect(result.page).toBe(100);
      expect(result.limit).toBe(25);
      expect(result.skip).toBe(2475); // (100-1) * 25
    });
  });

  describe('skip calculation', () => {
    it('should correctly calculate skip = (page - 1) * limit', () => {
      // Arrange: Various page/limit combinations
      const testCases = [
        { page: 1, limit: 20, expectedSkip: 0 },
        { page: 2, limit: 20, expectedSkip: 20 },
        { page: 3, limit: 20, expectedSkip: 40 },
        { page: 1, limit: 50, expectedSkip: 0 },
        { page: 5, limit: 10, expectedSkip: 40 },
        { page: 10, limit: 100, expectedSkip: 900 },
      ];

      testCases.forEach(({ page, limit, expectedSkip }) => {
        // Arrange
        const searchParams = new URLSearchParams(`page=${page}&limit=${limit}`);

        // Act
        const result = parsePaginationParams(searchParams);

        // Assert
        expect(result.skip).toBe(expectedSkip);
      });
    });

    it('should calculate skip correctly for first page', () => {
      // Arrange
      const searchParams = new URLSearchParams('page=1&limit=100');

      // Act
      const result = parsePaginationParams(searchParams);

      // Assert: First page should have skip = 0
      expect(result.skip).toBe(0);
    });

    it('should calculate skip correctly for large offsets', () => {
      // Arrange
      const searchParams = new URLSearchParams('page=1000&limit=50');

      // Act
      const result = parsePaginationParams(searchParams);

      // Assert
      expect(result.skip).toBe(49950); // (1000-1) * 50
    });
  });

  describe('min page enforcement', () => {
    it('should enforce minimum page of 1', () => {
      // Arrange: page=0 should be corrected to 1
      const searchParams = new URLSearchParams('page=0');

      // Act
      const result = parsePaginationParams(searchParams);

      // Assert: page = 1
      expect(result.page).toBe(1);
      expect(result.skip).toBe(0);
    });

    it('should enforce minimum for negative page values', () => {
      // Arrange: page=-5 should be corrected to 1
      const searchParams = new URLSearchParams('page=-5');

      // Act
      const result = parsePaginationParams(searchParams);

      // Assert: page = 1
      expect(result.page).toBe(1);
      expect(result.skip).toBe(0);
    });

    it('should enforce minimum for very negative page values', () => {
      // Arrange
      const searchParams = new URLSearchParams('page=-999');

      // Act
      const result = parsePaginationParams(searchParams);

      // Assert
      expect(result.page).toBe(1);
    });
  });

  describe('max limit enforcement', () => {
    it('should cap limit at 100', () => {
      // Arrange: limit=500 should be capped to 100
      const searchParams = new URLSearchParams('limit=500');

      // Act
      const result = parsePaginationParams(searchParams);

      // Assert: limit = 100
      expect(result.limit).toBe(100);
    });

    it('should cap very large limits', () => {
      // Arrange
      const searchParams = new URLSearchParams('limit=9999');

      // Act
      const result = parsePaginationParams(searchParams);

      // Assert
      expect(result.limit).toBe(100);
    });

    it('should accept limit at maximum (100)', () => {
      // Arrange
      const searchParams = new URLSearchParams('limit=100');

      // Act
      const result = parsePaginationParams(searchParams);

      // Assert
      expect(result.limit).toBe(100);
    });
  });

  describe('min limit enforcement', () => {
    it('should enforce minimum limit of 1', () => {
      // Arrange: limit=0 should be corrected to 1
      const searchParams = new URLSearchParams('limit=0');

      // Act
      const result = parsePaginationParams(searchParams);

      // Assert: limit = 1
      expect(result.limit).toBe(1);
    });

    it('should enforce minimum for negative limit values', () => {
      // Arrange: limit=-10 should be corrected to 1
      const searchParams = new URLSearchParams('limit=-10');

      // Act
      const result = parsePaginationParams(searchParams);

      // Assert: limit = 1
      expect(result.limit).toBe(1);
    });

    it('should accept limit at minimum (1)', () => {
      // Arrange
      const searchParams = new URLSearchParams('limit=1');

      // Act
      const result = parsePaginationParams(searchParams);

      // Assert
      expect(result.limit).toBe(1);
    });
  });

  describe('invalid number', () => {
    it('should throw ValidationError for NaN page', () => {
      // Arrange: page=abc is not a number
      const searchParams = new URLSearchParams('page=abc');

      // Act & Assert: Throws ValidationError
      expect(() => parsePaginationParams(searchParams)).toThrow(ValidationError);
    });

    it('should throw ValidationError for NaN limit', () => {
      // Arrange: limit=xyz is not a number
      const searchParams = new URLSearchParams('limit=xyz');

      // Act & Assert
      expect(() => parsePaginationParams(searchParams)).toThrow(ValidationError);
    });

    it('should throw ValidationError with correct details for invalid page', () => {
      // Arrange
      const searchParams = new URLSearchParams('page=invalid');

      // Act & Assert: Check error structure
      try {
        parsePaginationParams(searchParams);
        expect.fail('Should have thrown ValidationError');
      } catch (error) {
        expect(error).toBeInstanceOf(ValidationError);
        if (error instanceof ValidationError) {
          expect(error.message).toBe('Invalid pagination parameters');
          expect(error.code).toBe('VALIDATION_ERROR');
          expect(error.status).toBe(400);
          expect(error.details).toBeDefined();
          expect(error.details?.page).toEqual(['Must be a valid number']);
        }
      }
    });

    it('should throw ValidationError with correct details for invalid limit', () => {
      // Arrange
      const searchParams = new URLSearchParams('limit=notanumber');

      // Act & Assert
      try {
        parsePaginationParams(searchParams);
        expect.fail('Should have thrown ValidationError');
      } catch (error) {
        if (error instanceof ValidationError) {
          expect(error.details?.limit).toEqual(['Must be a valid number']);
        }
      }
    });

    it('should throw ValidationError when both page and limit are invalid', () => {
      // Arrange
      const searchParams = new URLSearchParams('page=abc&limit=xyz');

      // Act & Assert
      try {
        parsePaginationParams(searchParams);
        expect.fail('Should have thrown ValidationError');
      } catch (error) {
        if (error instanceof ValidationError) {
          expect(error.details?.page).toBeDefined();
          expect(error.details?.limit).toBeDefined();
        }
      }
    });

    it('should handle special numeric strings', () => {
      // Arrange: Decimal values (should be parsed as integers)
      const searchParams = new URLSearchParams('page=2.5&limit=10.9');

      // Act
      const result = parsePaginationParams(searchParams);

      // Assert: parseInt truncates decimals
      expect(result.page).toBe(2);
      expect(result.limit).toBe(10);
    });

    it('should handle numeric strings with whitespace', () => {
      // Arrange: Numbers with leading/trailing spaces (parseInt handles this)
      const searchParams = new URLSearchParams('page= 3 &limit= 20 ');

      // Act
      const result = parsePaginationParams(searchParams);

      // Assert: Should parse correctly
      expect(result.page).toBe(3);
      expect(result.limit).toBe(20);
    });
  });
});
