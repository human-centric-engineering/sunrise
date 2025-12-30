/**
 * API Response Utilities Tests
 *
 * Tests for standardized API response helper functions:
 * - successResponse() - Success responses with data
 * - errorResponse() - Error responses with messages
 * - paginatedResponse() - Paginated data with metadata
 *
 * Test Coverage:
 * - Response structure validation
 * - Status codes and headers
 * - Metadata handling
 * - Pagination calculations
 * - JSON serialization
 */

import { describe, it, expect } from 'vitest';
import { successResponse, errorResponse, paginatedResponse } from '@/lib/api/responses';

/**
 * Type definitions for response bodies
 */
interface SuccessResponse<T = unknown> {
  success: true;
  data: T;
  meta?: Record<string, unknown>;
}

interface ErrorResponseBody {
  success: false;
  error: {
    message: string;
    code?: string;
    details?: Record<string, unknown>;
  };
}

describe('successResponse', () => {
  describe('simple success responses', () => {
    it('should return success response with data', async () => {
      // Arrange
      const data = { id: '123', name: 'John' };

      // Act
      const response = successResponse(data);
      const json = (await response.json()) as SuccessResponse;

      // Assert
      expect(response.status).toBe(200);
      expect(json).toEqual({
        success: true,
        data: { id: '123', name: 'John' },
      });
    });

    it('should set correct Content-Type header', () => {
      // Arrange
      const data = { message: 'test' };

      // Act
      const response = successResponse(data);

      // Assert
      expect(response.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
    });

    it('should handle empty object data', async () => {
      // Arrange
      const data = {};

      // Act
      const response = successResponse(data);
      const json = (await response.json()) as SuccessResponse;

      // Assert
      expect(json).toEqual({
        success: true,
        data: {},
      });
    });

    it('should handle null data', async () => {
      // Arrange
      const data = null;

      // Act
      const response = successResponse(data);
      const json = (await response.json()) as SuccessResponse;

      // Assert
      expect(json).toEqual({
        success: true,
        data: null,
      });
    });

    it('should handle array data', async () => {
      // Arrange
      const data = [
        { id: '1', name: 'John' },
        { id: '2', name: 'Jane' },
      ];

      // Act
      const response = successResponse(data);
      const json = (await response.json()) as SuccessResponse;

      // Assert
      expect(json).toEqual({
        success: true,
        data: [
          { id: '1', name: 'John' },
          { id: '2', name: 'Jane' },
        ],
      });
    });

    it('should handle primitive data types', async () => {
      // Arrange
      const stringData = 'success';
      const numberData = 42;
      const booleanData = true;

      // Act
      const stringResponse = successResponse(stringData);
      const numberResponse = successResponse(numberData);
      const booleanResponse = successResponse(booleanData);

      const stringJson = (await stringResponse.json()) as Record<string, unknown>;
      const numberJson = (await numberResponse.json()) as Record<string, unknown>;
      const booleanJson = (await booleanResponse.json()) as Record<string, unknown>;

      // Assert
      expect(stringJson.data).toBe('success');
      expect(numberJson.data).toBe(42);
      expect(booleanJson.data).toBe(true);
    });
  });

  describe('responses with metadata', () => {
    it('should include metadata object when provided', async () => {
      // Arrange
      const data = { items: [] };
      const meta = { page: 1, total: 100 };

      // Act
      const response = successResponse(data, meta);
      const json = (await response.json()) as SuccessResponse;

      // Assert
      expect(json).toEqual({
        success: true,
        data: { items: [] },
        meta: { page: 1, total: 100 },
      });
    });

    it('should handle pagination metadata', async () => {
      // Arrange
      const data = [{ id: '1' }];
      const meta = {
        page: 2,
        limit: 20,
        total: 150,
        totalPages: 8,
      };

      // Act
      const response = successResponse(data, meta);
      const json = (await response.json()) as SuccessResponse;

      // Assert
      expect(json.meta).toEqual({
        page: 2,
        limit: 20,
        total: 150,
        totalPages: 8,
      });
    });

    it('should not include meta field when undefined', async () => {
      // Arrange
      const data = { id: '123' };

      // Act
      const response = successResponse(data);
      const json = (await response.json()) as SuccessResponse;

      // Assert
      expect(json).not.toHaveProperty('meta');
      expect(json).toEqual({
        success: true,
        data: { id: '123' },
      });
    });

    it('should handle custom metadata fields', async () => {
      // Arrange
      const data = { results: [] };
      const meta = {
        cacheHit: true,
        executionTime: 45,
        version: '1.0.0',
      };

      // Act
      const response = successResponse(data, meta);
      const json = (await response.json()) as SuccessResponse;

      // Assert
      expect(json.meta).toEqual({
        cacheHit: true,
        executionTime: 45,
        version: '1.0.0',
      });
    });
  });

  describe('custom status codes', () => {
    it('should accept custom status code 201', () => {
      // Arrange
      const data = { id: '123' };

      // Act
      const response = successResponse(data, undefined, { status: 201 });

      // Assert
      expect(response.status).toBe(201);
    });

    it('should accept custom status code 204', () => {
      // Arrange
      const data = null;

      // Act
      const response = successResponse(data, undefined, { status: 204 });

      // Assert
      expect(response.status).toBe(204);
    });

    it('should default to 200 when no status provided', () => {
      // Arrange
      const data = { id: '123' };

      // Act
      const response = successResponse(data);

      // Assert
      expect(response.status).toBe(200);
    });
  });

  describe('custom headers', () => {
    it('should include custom headers', () => {
      // Arrange
      const data = { id: '123' };

      // Act
      const response = successResponse(data, undefined, {
        headers: { 'X-Custom-Header': 'custom-value' },
      });

      // Assert
      expect(response.headers.get('X-Custom-Header')).toBe('custom-value');
    });

    it('should include Location header for created resources', () => {
      // Arrange
      const data = { id: '123', name: 'New User' };

      // Act
      const response = successResponse(data, undefined, {
        status: 201,
        headers: { Location: '/api/v1/users/123' },
      });

      // Assert
      expect(response.status).toBe(201);
      expect(response.headers.get('Location')).toBe('/api/v1/users/123');
    });

    it('should merge custom headers with Content-Type', () => {
      // Arrange
      const data = { id: '123' };

      // Act
      const response = successResponse(data, undefined, {
        headers: {
          'X-Request-ID': 'abc-123',
          'X-Response-Time': '45ms',
        },
      });

      // Assert
      expect(response.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
      expect(response.headers.get('X-Request-ID')).toBe('abc-123');
      expect(response.headers.get('X-Response-Time')).toBe('45ms');
    });

    it('should handle multiple custom headers', () => {
      // Arrange
      const data = { id: '123' };

      // Act
      const response = successResponse(data, undefined, {
        headers: {
          'X-API-Version': '1.0',
          'X-Rate-Limit': '1000',
          'X-Request-ID': 'req-123',
        },
      });

      // Assert
      expect(response.headers.get('X-API-Version')).toBe('1.0');
      expect(response.headers.get('X-Rate-Limit')).toBe('1000');
      expect(response.headers.get('X-Request-ID')).toBe('req-123');
    });
  });

  describe('combined options', () => {
    it('should handle metadata, custom status, and headers together', async () => {
      // Arrange
      const data = { id: '123', name: 'John' };
      const meta = { cached: true };

      // Act
      const response = successResponse(data, meta, {
        status: 201,
        headers: { 'X-Cache': 'HIT' },
      });
      const json = (await response.json()) as SuccessResponse;

      // Assert
      expect(response.status).toBe(201);
      expect(response.headers.get('X-Cache')).toBe('HIT');
      expect(json).toEqual({
        success: true,
        data: { id: '123', name: 'John' },
        meta: { cached: true },
      });
    });
  });
});

describe('errorResponse', () => {
  describe('simple error responses', () => {
    it('should return error response with message', async () => {
      // Arrange
      const message = 'Not found';

      // Act
      const response = errorResponse(message);
      const json = (await response.json()) as ErrorResponseBody;

      // Assert
      expect(response.status).toBe(500);
      expect(json).toEqual({
        success: false,
        error: {
          message: 'Not found',
        },
      });
    });

    it('should set correct Content-Type header', () => {
      // Arrange
      const message = 'Error occurred';

      // Act
      const response = errorResponse(message);

      // Assert
      expect(response.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
    });

    it('should default to status 500', () => {
      // Arrange
      const message = 'Internal server error';

      // Act
      const response = errorResponse(message);

      // Assert
      expect(response.status).toBe(500);
    });
  });

  describe('error codes', () => {
    it('should include error code when provided', async () => {
      // Arrange
      const message = 'Not found';
      const code = 'NOT_FOUND';

      // Act
      const response = errorResponse(message, { code });
      const json = (await response.json()) as ErrorResponseBody;

      // Assert
      expect(json.error.code).toBe('NOT_FOUND');
    });

    it('should handle various error codes', async () => {
      // Arrange & Act
      const validationError = errorResponse('Validation failed', {
        code: 'VALIDATION_ERROR',
      });
      const authError = errorResponse('Unauthorized', {
        code: 'UNAUTHORIZED',
      });
      const forbiddenError = errorResponse('Forbidden', {
        code: 'FORBIDDEN',
      });

      const validationJson = (await validationError.json()) as Record<string, unknown>;
      const authJson = (await authError.json()) as Record<string, unknown>;
      const forbiddenJson = (await forbiddenError.json()) as Record<string, unknown>;

      // Assert
      expect((validationJson.error as Record<string, unknown>).code).toBe('VALIDATION_ERROR');
      expect((authJson.error as Record<string, unknown>).code).toBe('UNAUTHORIZED');
      expect((forbiddenJson.error as Record<string, unknown>).code).toBe('FORBIDDEN');
    });

    it('should not include code field when undefined', async () => {
      // Arrange
      const message = 'Error occurred';

      // Act
      const response = errorResponse(message);
      const json = (await response.json()) as ErrorResponseBody;

      // Assert
      expect(json.error).not.toHaveProperty('code');
      expect(json.error).toEqual({ message: 'Error occurred' });
    });
  });

  describe('custom status codes', () => {
    it('should accept 400 Bad Request', () => {
      // Arrange
      const message = 'Bad request';

      // Act
      const response = errorResponse(message, { status: 400 });

      // Assert
      expect(response.status).toBe(400);
    });

    it('should accept 401 Unauthorized', () => {
      // Arrange
      const message = 'Unauthorized';

      // Act
      const response = errorResponse(message, {
        code: 'UNAUTHORIZED',
        status: 401,
      });

      // Assert
      expect(response.status).toBe(401);
    });

    it('should accept 403 Forbidden', () => {
      // Arrange
      const message = 'Forbidden';

      // Act
      const response = errorResponse(message, { status: 403 });

      // Assert
      expect(response.status).toBe(403);
    });

    it('should accept 404 Not Found', () => {
      // Arrange
      const message = 'Resource not found';

      // Act
      const response = errorResponse(message, {
        code: 'NOT_FOUND',
        status: 404,
      });

      // Assert
      expect(response.status).toBe(404);
    });

    it('should accept 409 Conflict', () => {
      // Arrange
      const message = 'Resource already exists';

      // Act
      const response = errorResponse(message, { status: 409 });

      // Assert
      expect(response.status).toBe(409);
    });

    it('should accept 422 Unprocessable Entity', () => {
      // Arrange
      const message = 'Validation failed';

      // Act
      const response = errorResponse(message, { status: 422 });

      // Assert
      expect(response.status).toBe(422);
    });

    it('should accept 500 Internal Server Error', () => {
      // Arrange
      const message = 'Internal server error';

      // Act
      const response = errorResponse(message, { status: 500 });

      // Assert
      expect(response.status).toBe(500);
    });
  });

  describe('error details', () => {
    it('should include error details when provided', async () => {
      // Arrange
      const message = 'Validation failed';
      const details = {
        email: ['Invalid email format'],
        password: ['Password too short'],
      };

      // Act
      const response = errorResponse(message, { details });
      const json = (await response.json()) as ErrorResponseBody;

      // Assert
      expect(json.error.details).toEqual({
        email: ['Invalid email format'],
        password: ['Password too short'],
      });
    });

    it('should handle complex error details', async () => {
      // Arrange
      const message = 'Validation failed';
      const details = {
        fields: {
          email: { message: 'Invalid', code: 'INVALID_FORMAT' },
          age: { message: 'Too young', code: 'MIN_VALUE' },
        },
        timestamp: '2024-01-01T00:00:00Z',
      };

      // Act
      const response = errorResponse(message, { details });
      const json = (await response.json()) as ErrorResponseBody;

      // Assert
      expect(json.error.details).toEqual(details);
    });

    it('should not include details field when undefined', async () => {
      // Arrange
      const message = 'Error occurred';

      // Act
      const response = errorResponse(message, { code: 'ERROR' });
      const json = (await response.json()) as ErrorResponseBody;

      // Assert
      expect(json.error).not.toHaveProperty('details');
    });
  });

  describe('custom headers', () => {
    it('should include custom headers', () => {
      // Arrange
      const message = 'Rate limit exceeded';

      // Act
      const response = errorResponse(message, {
        status: 429,
        headers: {
          'X-RateLimit-Limit': '100',
          'X-RateLimit-Remaining': '0',
          'Retry-After': '60',
        },
      });

      // Assert
      expect(response.headers.get('X-RateLimit-Limit')).toBe('100');
      expect(response.headers.get('X-RateLimit-Remaining')).toBe('0');
      expect(response.headers.get('Retry-After')).toBe('60');
    });

    it('should merge custom headers with Content-Type', () => {
      // Arrange
      const message = 'Error';

      // Act
      const response = errorResponse(message, {
        headers: { 'X-Request-ID': 'error-123' },
      });

      // Assert
      expect(response.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
      expect(response.headers.get('X-Request-ID')).toBe('error-123');
    });
  });

  describe('combined options', () => {
    it('should handle code, status, details, and headers together', async () => {
      // Arrange
      const message = 'Validation failed';
      const options = {
        code: 'VALIDATION_ERROR',
        status: 400,
        details: { email: ['Invalid'] },
        headers: { 'X-Validation-Version': '1.0' },
      };

      // Act
      const response = errorResponse(message, options);
      const json = (await response.json()) as ErrorResponseBody;

      // Assert
      expect(response.status).toBe(400);
      expect(response.headers.get('X-Validation-Version')).toBe('1.0');
      expect(json).toEqual({
        success: false,
        error: {
          message: 'Validation failed',
          code: 'VALIDATION_ERROR',
          details: { email: ['Invalid'] },
        },
      });
    });
  });
});

describe('paginatedResponse', () => {
  describe('basic pagination', () => {
    it('should return paginated data with metadata', async () => {
      // Arrange
      const items = [
        { id: '1', name: 'Item 1' },
        { id: '2', name: 'Item 2' },
      ];
      const pagination = { page: 1, limit: 20, total: 150 };

      // Act
      const response = paginatedResponse(items, pagination);
      const json = (await response.json()) as SuccessResponse;

      // Assert
      expect(json).toEqual({
        success: true,
        data: items,
        meta: {
          page: 1,
          limit: 20,
          total: 150,
          totalPages: 8,
        },
      });
    });

    it('should have status 200 by default', () => {
      // Arrange
      const items = [{ id: '1' }];
      const pagination = { page: 1, limit: 10, total: 5 };

      // Act
      const response = paginatedResponse(items, pagination);

      // Assert
      expect(response.status).toBe(200);
    });

    it('should set correct Content-Type header', () => {
      // Arrange
      const items = [{ id: '1' }];
      const pagination = { page: 1, limit: 10, total: 5 };

      // Act
      const response = paginatedResponse(items, pagination);

      // Assert
      expect(response.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
    });
  });

  describe('total pages calculation', () => {
    it('should calculate total pages correctly for exact division', async () => {
      // Arrange
      const items: unknown[] = [];
      const pagination = { page: 1, limit: 20, total: 100 };

      // Act
      const response = paginatedResponse(items, pagination);
      const json = (await response.json()) as SuccessResponse;

      // Assert
      expect(json.meta!.totalPages).toBe(5); // 100 / 20 = 5
    });

    it('should calculate total pages correctly for remainder', async () => {
      // Arrange
      const items: unknown[] = [];
      const pagination = { page: 1, limit: 20, total: 150 };

      // Act
      const response = paginatedResponse(items, pagination);
      const json = (await response.json()) as SuccessResponse;

      // Assert
      expect(json.meta!.totalPages).toBe(8); // Math.ceil(150 / 20) = 8
    });

    it('should handle single page correctly', async () => {
      // Arrange
      const items = [{ id: '1' }, { id: '2' }];
      const pagination = { page: 1, limit: 20, total: 2 };

      // Act
      const response = paginatedResponse(items, pagination);
      const json = (await response.json()) as SuccessResponse;

      // Assert
      expect(json.meta!.totalPages).toBe(1); // Math.ceil(2 / 20) = 1
    });

    it('should handle large datasets correctly', async () => {
      // Arrange
      const items: unknown[] = [];
      const pagination = { page: 1, limit: 50, total: 12345 };

      // Act
      const response = paginatedResponse(items, pagination);
      const json = (await response.json()) as SuccessResponse;

      // Assert
      expect(json.meta!.totalPages).toBe(247); // Math.ceil(12345 / 50) = 247
    });

    it('should handle small limit correctly', async () => {
      // Arrange
      const items: unknown[] = [];
      const pagination = { page: 1, limit: 5, total: 23 };

      // Act
      const response = paginatedResponse(items, pagination);
      const json = (await response.json()) as SuccessResponse;

      // Assert
      expect(json.meta!.totalPages).toBe(5); // Math.ceil(23 / 5) = 5
    });
  });

  describe('empty results', () => {
    it('should handle empty array with zero total', async () => {
      // Arrange
      const items: unknown[] = [];
      const pagination = { page: 1, limit: 20, total: 0 };

      // Act
      const response = paginatedResponse(items, pagination);
      const json = (await response.json()) as SuccessResponse;

      // Assert
      expect(json.data).toEqual([]);
      expect(json.meta).toEqual({
        page: 1,
        limit: 20,
        total: 0,
        totalPages: 0,
      });
    });

    it('should handle page beyond available data', async () => {
      // Arrange
      const items: unknown[] = [];
      const pagination = { page: 10, limit: 20, total: 50 };

      // Act
      const response = paginatedResponse(items, pagination);
      const json = (await response.json()) as SuccessResponse;

      // Assert
      expect(json.data).toEqual([]);
      expect(json.meta!.page).toBe(10);
      expect(json.meta!.totalPages).toBe(3); // Math.ceil(50 / 20) = 3
    });
  });

  describe('different page numbers', () => {
    it('should handle first page correctly', async () => {
      // Arrange
      const items = [{ id: '1' }, { id: '2' }];
      const pagination = { page: 1, limit: 20, total: 100 };

      // Act
      const response = paginatedResponse(items, pagination);
      const json = (await response.json()) as SuccessResponse;

      // Assert
      expect(json.meta!.page).toBe(1);
    });

    it('should handle middle page correctly', async () => {
      // Arrange
      const items = [{ id: '21' }, { id: '22' }];
      const pagination = { page: 5, limit: 20, total: 200 };

      // Act
      const response = paginatedResponse(items, pagination);
      const json = (await response.json()) as SuccessResponse;

      // Assert
      expect(json.meta!.page).toBe(5);
      expect(json.meta!.totalPages).toBe(10);
    });

    it('should handle last page correctly', async () => {
      // Arrange
      const items = [{ id: '91' }]; // Last page with partial data
      const pagination = { page: 10, limit: 10, total: 91 };

      // Act
      const response = paginatedResponse(items, pagination);
      const json = (await response.json()) as SuccessResponse;

      // Assert
      expect(json.meta!.page).toBe(10);
      expect(json.meta!.totalPages).toBe(10);
    });
  });

  describe('different limit values', () => {
    it('should handle small limit (5 items per page)', async () => {
      // Arrange
      const items = [{ id: '1' }, { id: '2' }, { id: '3' }, { id: '4' }, { id: '5' }];
      const pagination = { page: 1, limit: 5, total: 50 };

      // Act
      const response = paginatedResponse(items, pagination);
      const json = (await response.json()) as SuccessResponse;

      // Assert
      expect(json.meta!.limit).toBe(5);
      expect(json.meta!.totalPages).toBe(10);
    });

    it('should handle medium limit (50 items per page)', async () => {
      // Arrange
      const items: unknown[] = new Array(50).fill(null).map((_, i) => ({ id: String(i + 1) }));
      const pagination = { page: 1, limit: 50, total: 500 };

      // Act
      const response = paginatedResponse(items, pagination);
      const json = (await response.json()) as SuccessResponse;

      // Assert
      expect(json.meta!.limit).toBe(50);
      expect(json.meta!.totalPages).toBe(10);
    });

    it('should handle large limit (100 items per page)', async () => {
      // Arrange
      const items: unknown[] = [];
      const pagination = { page: 1, limit: 100, total: 150 };

      // Act
      const response = paginatedResponse(items, pagination);
      const json = (await response.json()) as SuccessResponse;

      // Assert
      expect(json.meta!.limit).toBe(100);
      expect(json.meta!.totalPages).toBe(2);
    });
  });

  describe('custom options', () => {
    it('should accept custom status code', () => {
      // Arrange
      const items = [{ id: '1' }];
      const pagination = { page: 1, limit: 20, total: 50 };

      // Act
      const response = paginatedResponse(items, pagination, { status: 206 });

      // Assert
      expect(response.status).toBe(206); // 206 Partial Content
    });

    it('should include custom headers', () => {
      // Arrange
      const items = [{ id: '1' }];
      const pagination = { page: 1, limit: 20, total: 50 };

      // Act
      const response = paginatedResponse(items, pagination, {
        headers: {
          'X-Total-Count': '50',
          'X-Page-Count': '3',
        },
      });

      // Assert
      expect(response.headers.get('X-Total-Count')).toBe('50');
      expect(response.headers.get('X-Page-Count')).toBe('3');
    });

    it('should handle both custom status and headers', async () => {
      // Arrange
      const items = [{ id: '1' }];
      const pagination = { page: 2, limit: 10, total: 25 };

      // Act
      const response = paginatedResponse(items, pagination, {
        status: 200,
        headers: { 'X-Request-ID': 'pagination-123' },
      });
      const json = (await response.json()) as SuccessResponse;

      // Assert
      expect(response.status).toBe(200);
      expect(response.headers.get('X-Request-ID')).toBe('pagination-123');
      expect(json.meta).toEqual({
        page: 2,
        limit: 10,
        total: 25,
        totalPages: 3,
      });
    });
  });

  describe('real-world scenarios', () => {
    it('should handle typical user list pagination', async () => {
      // Arrange
      const users = [
        { id: '1', name: 'John', email: 'john@example.com' },
        { id: '2', name: 'Jane', email: 'jane@example.com' },
      ];
      const pagination = { page: 1, limit: 20, total: 150 };

      // Act
      const response = paginatedResponse(users, pagination);
      const json = (await response.json()) as SuccessResponse;

      // Assert
      expect(json.success).toBe(true);
      expect(json.data).toHaveLength(2);
      expect(json.meta!.totalPages).toBe(8);
    });

    it('should handle search results with few matches', async () => {
      // Arrange
      const searchResults = [{ id: '42', name: 'Matching User' }];
      const pagination = { page: 1, limit: 20, total: 1 };

      // Act
      const response = paginatedResponse(searchResults, pagination);
      const json = (await response.json()) as SuccessResponse;

      // Assert
      expect(json.data).toHaveLength(1);
      expect(json.meta!.totalPages).toBe(1);
    });

    it('should handle infinite scroll pagination', async () => {
      // Arrange
      const posts = new Array(10).fill(null).map((_, i) => ({
        id: String(i + 1),
        title: `Post ${i + 1}`,
      }));
      const pagination = { page: 3, limit: 10, total: 100 };

      // Act
      const response = paginatedResponse(posts, pagination);
      const json = (await response.json()) as SuccessResponse;

      // Assert
      expect(json.data).toHaveLength(10);
      expect(json.meta!.page).toBe(3);
      expect(json.meta!.totalPages).toBe(10);
    });
  });
});
