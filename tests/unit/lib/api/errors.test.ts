/**
 * API Error Handling Tests
 *
 * Week 2, Task 5: Comprehensive tests for API error classes and error handling.
 *
 * Test Coverage:
 * - Custom error classes (APIError, ValidationError, UnauthorizedError, ForbiddenError, NotFoundError)
 * - handleAPIError() function with all error types
 * - Zod error transformation
 * - Prisma error handling (P2002, P2025, P2003, validation errors)
 * - Environment-aware error details (development vs production)
 * - Error logging verification
 *
 * @see lib/api/errors.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import {
  APIError,
  ValidationError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ErrorCodes,
  handleAPIError,
} from '@/lib/api/errors';

/**
 * Mock dependencies
 */

// Mock the logger to verify error logging
vi.mock('@/lib/logging', () => ({
  logger: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    withContext: vi.fn(() => ({
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    })),
  },
}));

// Mock environment for testing dev vs prod behavior
vi.mock('@/lib/env', () => ({
  env: {
    NODE_ENV: 'development', // Default to development
  },
}));

// Import mocked modules
import { logger } from '@/lib/logging';
import { env } from '@/lib/env';

/**
 * Test Suite: Custom Error Classes
 *
 * Tests instantiation and properties of all custom error classes
 */
describe('Custom Error Classes', () => {
  describe('APIError', () => {
    it('should create APIError with all properties', () => {
      const error = new APIError('Test error', 'TEST_CODE', 500, { key: 'value' });

      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(APIError);
      expect(error.name).toBe('APIError');
      expect(error.message).toBe('Test error');
      expect(error.code).toBe('TEST_CODE');
      expect(error.status).toBe(500);
      expect(error.details).toEqual({ key: 'value' });
    });

    it('should create APIError with default status code', () => {
      const error = new APIError('Test error');

      expect(error.status).toBe(500);
      expect(error.code).toBeUndefined();
      expect(error.details).toBeUndefined();
    });

    it('should capture stack trace', () => {
      const error = new APIError('Test error');

      expect(error.stack).toBeDefined();
      expect(error.stack).toContain('APIError');
    });

    it('should create APIError with custom code but no details', () => {
      const error = new APIError('Test error', 'CUSTOM_CODE', 418);

      expect(error.message).toBe('Test error');
      expect(error.code).toBe('CUSTOM_CODE');
      expect(error.status).toBe(418);
      expect(error.details).toBeUndefined();
    });
  });

  describe('ValidationError', () => {
    it('should create ValidationError with default message', () => {
      const error = new ValidationError();

      expect(error).toBeInstanceOf(APIError);
      expect(error).toBeInstanceOf(ValidationError);
      expect(error.name).toBe('ValidationError');
      expect(error.message).toBe('Validation failed');
      expect(error.code).toBe(ErrorCodes.VALIDATION_ERROR);
      expect(error.status).toBe(400);
    });

    it('should create ValidationError with custom message and details', () => {
      const details = {
        email: ['Invalid email format'],
        password: ['Password too short'],
      };
      const error = new ValidationError('Invalid input', details);

      expect(error.message).toBe('Invalid input');
      expect(error.code).toBe(ErrorCodes.VALIDATION_ERROR);
      expect(error.status).toBe(400);
      expect(error.details).toEqual(details);
    });

    it('should create ValidationError with details but default message', () => {
      const details = { field: ['error'] };
      const error = new ValidationError(undefined, details);

      expect(error.message).toBe('Validation failed');
      expect(error.details).toEqual(details);
    });
  });

  describe('UnauthorizedError', () => {
    it('should create UnauthorizedError with default message', () => {
      const error = new UnauthorizedError();

      expect(error).toBeInstanceOf(APIError);
      expect(error).toBeInstanceOf(UnauthorizedError);
      expect(error.name).toBe('UnauthorizedError');
      expect(error.message).toBe('Unauthorized');
      expect(error.code).toBe(ErrorCodes.UNAUTHORIZED);
      expect(error.status).toBe(401);
    });

    it('should create UnauthorizedError with custom message', () => {
      const error = new UnauthorizedError('Invalid token');

      expect(error.message).toBe('Invalid token');
      expect(error.code).toBe(ErrorCodes.UNAUTHORIZED);
      expect(error.status).toBe(401);
    });

    it('should not have details property', () => {
      const error = new UnauthorizedError();

      expect(error.details).toBeUndefined();
    });
  });

  describe('ForbiddenError', () => {
    it('should create ForbiddenError with default message', () => {
      const error = new ForbiddenError();

      expect(error).toBeInstanceOf(APIError);
      expect(error).toBeInstanceOf(ForbiddenError);
      expect(error.name).toBe('ForbiddenError');
      expect(error.message).toBe('Forbidden');
      expect(error.code).toBe(ErrorCodes.FORBIDDEN);
      expect(error.status).toBe(403);
    });

    it('should create ForbiddenError with custom message', () => {
      const error = new ForbiddenError('Admin access required');

      expect(error.message).toBe('Admin access required');
      expect(error.code).toBe(ErrorCodes.FORBIDDEN);
      expect(error.status).toBe(403);
    });

    it('should not have details property', () => {
      const error = new ForbiddenError();

      expect(error.details).toBeUndefined();
    });
  });

  describe('NotFoundError', () => {
    it('should create NotFoundError with default message', () => {
      const error = new NotFoundError();

      expect(error).toBeInstanceOf(APIError);
      expect(error).toBeInstanceOf(NotFoundError);
      expect(error.name).toBe('NotFoundError');
      expect(error.message).toBe('Resource not found');
      expect(error.code).toBe(ErrorCodes.NOT_FOUND);
      expect(error.status).toBe(404);
    });

    it('should create NotFoundError with custom message', () => {
      const error = new NotFoundError('User not found');

      expect(error.message).toBe('User not found');
      expect(error.code).toBe(ErrorCodes.NOT_FOUND);
      expect(error.status).toBe(404);
    });

    it('should not have details property', () => {
      const error = new NotFoundError();

      expect(error.details).toBeUndefined();
    });
  });
});

/**
 * Test Suite: handleAPIError Function
 *
 * Tests error transformation and response creation for all error types
 */
describe('handleAPIError', () => {
  beforeEach(() => {
    // Reset mocks before each test
    vi.clearAllMocks();
    // Set default environment to development
    (env as { NODE_ENV: string }).NODE_ENV = 'development';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Helper: Parse JSON response body
   */
  interface ErrorResponse {
    success: false;
    error: {
      message: string;
      code?: string;
      details?: Record<string, unknown>;
    };
  }

  async function parseResponse(response: Response): Promise<ErrorResponse> {
    return (await response.json()) as ErrorResponse;
  }

  describe('APIError handling', () => {
    it('should handle APIError with all properties', async () => {
      const error = new APIError('Custom error', 'CUSTOM_CODE', 418, { extra: 'data' });
      const response = handleAPIError(error);
      const body = await parseResponse(response);

      expect(response.status).toBe(418);
      expect(body).toEqual({
        success: false,
        error: {
          message: 'Custom error',
          code: 'CUSTOM_CODE',
          details: { extra: 'data' },
        },
      });
    });

    it('should handle ValidationError', async () => {
      const error = new ValidationError('Invalid data', {
        email: ['Invalid format'],
      });
      const response = handleAPIError(error);
      const body = await parseResponse(response);

      expect(response.status).toBe(400);
      expect(body).toEqual({
        success: false,
        error: {
          message: 'Invalid data',
          code: ErrorCodes.VALIDATION_ERROR,
          details: { email: ['Invalid format'] },
        },
      });
    });

    it('should handle UnauthorizedError', async () => {
      const error = new UnauthorizedError('Token expired');
      const response = handleAPIError(error);
      const body = await parseResponse(response);

      expect(response.status).toBe(401);
      expect(body).toEqual({
        success: false,
        error: {
          message: 'Token expired',
          code: ErrorCodes.UNAUTHORIZED,
        },
      });
    });

    it('should handle ForbiddenError', async () => {
      const error = new ForbiddenError('Insufficient permissions');
      const response = handleAPIError(error);
      const body = await parseResponse(response);

      expect(response.status).toBe(403);
      expect(body).toEqual({
        success: false,
        error: {
          message: 'Insufficient permissions',
          code: ErrorCodes.FORBIDDEN,
        },
      });
    });

    it('should handle NotFoundError', async () => {
      const error = new NotFoundError('User not found');
      const response = handleAPIError(error);
      const body = await parseResponse(response);

      expect(response.status).toBe(404);
      expect(body).toEqual({
        success: false,
        error: {
          message: 'User not found',
          code: ErrorCodes.NOT_FOUND,
        },
      });
    });

    it('should log APIError with correct context', () => {
      const error = new APIError('Test error', 'TEST', 500);
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const mockError = logger.error as unknown as ReturnType<typeof vi.fn>;
      handleAPIError(error);

      expect(mockError).toHaveBeenCalledWith('API Error', error, {
        errorType: 'api',
        isDevelopment: true,
      });
    });
  });

  describe('Zod validation error handling', () => {
    it('should transform Zod error with single field error', async () => {
      const schema = z.object({
        email: z.string().email(),
      });

      let zodError: z.ZodError | undefined;
      try {
        schema.parse({ email: 'invalid' });
      } catch (error) {
        zodError = error as z.ZodError;
      }

      expect(zodError).toBeDefined();
      const response = handleAPIError(zodError!);
      const body = await parseResponse(response);

      expect(response.status).toBe(400);
      expect(body.success).toBe(false);
      const error = body.error as Record<string, unknown>;
      expect(error.code).toBe(ErrorCodes.VALIDATION_ERROR);
      expect(error.message).toBe('Validation failed');
      const details = error.details as Record<string, unknown>;
      expect(details).toHaveProperty('email');
      expect(Array.isArray(details.email)).toBe(true);
    });

    it('should transform Zod error with multiple field errors', async () => {
      const schema = z.object({
        email: z.string().email(),
        password: z.string().min(8),
        age: z.number().min(18),
      });

      let zodError: z.ZodError | undefined;
      try {
        schema.parse({ email: 'invalid', password: 'short', age: 15 });
      } catch (error) {
        zodError = error as z.ZodError;
      }

      expect(zodError).toBeDefined();
      const response = handleAPIError(zodError!);
      const body = await parseResponse(response);

      expect(response.status).toBe(400);
      const error = body.error as Record<string, unknown>;
      expect(error.code).toBe(ErrorCodes.VALIDATION_ERROR);
      const details = error.details as Record<string, unknown>;
      expect(details).toHaveProperty('email');
      expect(details).toHaveProperty('password');
      expect(details).toHaveProperty('age');
    });

    it('should transform Zod error with nested field errors', async () => {
      const schema = z.object({
        user: z.object({
          name: z.string().min(1),
          email: z.string().email(),
        }),
      });

      let zodError: z.ZodError | undefined;
      try {
        schema.parse({ user: { name: '', email: 'invalid' } });
      } catch (error) {
        zodError = error as z.ZodError;
      }

      expect(zodError).toBeDefined();
      const response = handleAPIError(zodError!);
      const body = await parseResponse(response);

      expect(response.status).toBe(400);
      expect(body.error.details).toHaveProperty('user.name');
      expect(body.error.details).toHaveProperty('user.email');
    });

    it('should handle Zod error with array field errors', async () => {
      const schema = z.object({
        tags: z.array(z.string().min(1)),
      });

      let zodError: z.ZodError | undefined;
      try {
        schema.parse({ tags: ['valid', '', 'also-valid'] });
      } catch (error) {
        zodError = error as z.ZodError;
      }

      expect(zodError).toBeDefined();
      const response = handleAPIError(zodError!);
      const body = await parseResponse(response);

      expect(response.status).toBe(400);
      expect(body.error.code).toBe(ErrorCodes.VALIDATION_ERROR);
      expect(body.error.details).toBeDefined();
    });

    it('should accumulate multiple errors for the same field', async () => {
      const schema = z.object({
        password: z
          .string()
          .min(8, 'Too short')
          .regex(/[A-Z]/, 'Must have uppercase')
          .regex(/[0-9]/, 'Must have number'),
      });

      let zodError: z.ZodError | undefined;
      try {
        schema.parse({ password: 'short' });
      } catch (error) {
        zodError = error as z.ZodError;
      }

      expect(zodError).toBeDefined();
      const response = handleAPIError(zodError!);
      const body = await parseResponse(response);

      expect(response.status).toBe(400);
      const error = body.error as Record<string, unknown>;
      const details = error.details as Record<string, unknown>;
      expect(details.password).toBeDefined();
      expect(Array.isArray(details.password)).toBe(true);
      // Should have at least one error message
      expect((details.password as unknown[]).length).toBeGreaterThan(0);
    });

    it('should log Zod validation errors', () => {
      const schema = z.object({ email: z.string().email() });

      let zodError: z.ZodError | undefined;
      try {
        schema.parse({ email: 'invalid' });
      } catch (error) {
        zodError = error as z.ZodError;
      }

      handleAPIError(zodError!);

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(logger.error as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
        'API Error',
        zodError,
        expect.objectContaining({
          errorType: 'api',
        })
      );
    });
  });

  describe('Prisma error handling', () => {
    describe('P2002 - Unique constraint violation', () => {
      it('should handle unique constraint on email field', async () => {
        const prismaError = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: '5.0.0',
          meta: { target: ['email'] },
        });

        const response = handleAPIError(prismaError);
        const body = await parseResponse(response);

        expect(response.status).toBe(400);
        expect(body).toEqual({
          success: false,
          error: {
            message: 'Email already exists',
            code: ErrorCodes.EMAIL_TAKEN,
            details: {
              field: 'email',
              constraint: 'unique',
            },
          },
        });
      });

      it('should handle unique constraint on username field', async () => {
        const prismaError = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: '5.0.0',
          meta: { target: ['username'] },
        });

        const response = handleAPIError(prismaError);
        const body = await parseResponse(response);

        expect(response.status).toBe(400);
        expect(body.error.message).toBe('Username already exists');
        expect(body.error.details).toEqual({
          field: 'username',
          constraint: 'unique',
        });
      });

      it('should handle unique constraint with no target field', async () => {
        const prismaError = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: '5.0.0',
          meta: { target: [] },
        });

        const response = handleAPIError(prismaError);
        const body = await parseResponse(response);

        expect(response.status).toBe(400);
        expect(body.error.message).toBe('Field already exists');
        expect(body.error.code).toBe(ErrorCodes.EMAIL_TAKEN);
        expect(body.error.details).toEqual({
          field: 'field',
          constraint: 'unique',
        });
      });

      it('should handle unique constraint with missing meta', async () => {
        const prismaError = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: '5.0.0',
          meta: undefined,
        });

        const response = handleAPIError(prismaError);
        const body = await parseResponse(response);

        expect(response.status).toBe(400);
        const error = body.error as Record<string, unknown>;
        const details = error.details as Record<string, unknown>;
        expect(details.field).toBe('field');
      });
    });

    describe('P2025 - Record not found', () => {
      it('should handle record not found error', async () => {
        const prismaError = new Prisma.PrismaClientKnownRequestError('Record not found', {
          code: 'P2025',
          clientVersion: '5.0.0',
          meta: { cause: 'Record to update not found.' },
        });

        const response = handleAPIError(prismaError);
        const body = await parseResponse(response);

        expect(response.status).toBe(404);
        expect(body).toEqual({
          success: false,
          error: {
            message: 'Record not found',
            code: ErrorCodes.NOT_FOUND,
          },
        });
      });
    });

    describe('P2003 - Foreign key constraint violation', () => {
      it('should handle foreign key constraint error', async () => {
        const prismaError = new Prisma.PrismaClientKnownRequestError(
          'Foreign key constraint failed',
          {
            code: 'P2003',
            clientVersion: '5.0.0',
            meta: { field_name: 'userId' },
          }
        );

        const response = handleAPIError(prismaError);
        const body = await parseResponse(response);

        expect(response.status).toBe(400);
        expect(body).toEqual({
          success: false,
          error: {
            message: 'Invalid reference',
            code: ErrorCodes.VALIDATION_ERROR,
            details: {
              constraint: 'foreign_key',
            },
          },
        });
      });
    });

    describe('Generic Prisma errors', () => {
      it('should handle unknown Prisma error code in development', async () => {
        (env as { NODE_ENV: string }).NODE_ENV = 'development';

        const prismaError = new Prisma.PrismaClientKnownRequestError('Unknown error', {
          code: 'P9999',
          clientVersion: '5.0.0',
          meta: {},
        });

        const response = handleAPIError(prismaError);
        const body = await parseResponse(response);

        expect(response.status).toBe(500);
        const error = body.error as Record<string, unknown>;
        expect(error.message).toBe('Database error');
        expect(error.code).toBe(ErrorCodes.INTERNAL_ERROR);
        expect(error.details).toBeDefined();
        const details = error.details as Record<string, unknown>;
        expect(details.code).toBe('P9999');
        expect(details.message).toBe('Unknown error');
      });

      it('should handle unknown Prisma error code in production', async () => {
        (env as { NODE_ENV: string }).NODE_ENV = 'production';

        const prismaError = new Prisma.PrismaClientKnownRequestError('Unknown error', {
          code: 'P9999',
          clientVersion: '5.0.0',
          meta: {},
        });

        const response = handleAPIError(prismaError);
        const body = await parseResponse(response);

        expect(response.status).toBe(500);
        expect(body.error.message).toBe('Database error');
        expect(body.error.code).toBe(ErrorCodes.INTERNAL_ERROR);
        expect(body.error.details).toBeUndefined();
      });
    });

    describe('PrismaClientValidationError', () => {
      it('should handle Prisma validation error in development', async () => {
        (env as { NODE_ENV: string }).NODE_ENV = 'development';

        const prismaError = new Prisma.PrismaClientValidationError('Invalid value for field', {
          clientVersion: '5.0.0',
        });

        const response = handleAPIError(prismaError);
        const body = await parseResponse(response);

        expect(response.status).toBe(400);
        const error = body.error as Record<string, unknown>;
        expect(error.message).toBe('Invalid data format');
        expect(error.code).toBe(ErrorCodes.VALIDATION_ERROR);
        expect(error.details).toBeDefined();
        const details = error.details as Record<string, unknown>;
        expect(details.message).toBe('Invalid value for field');
      });

      it('should handle Prisma validation error in production', async () => {
        (env as { NODE_ENV: string }).NODE_ENV = 'production';

        const prismaError = new Prisma.PrismaClientValidationError('Invalid value for field', {
          clientVersion: '5.0.0',
        });

        const response = handleAPIError(prismaError);
        const body = await parseResponse(response);

        expect(response.status).toBe(400);
        expect(body.error.message).toBe('Invalid data format');
        expect(body.error.code).toBe(ErrorCodes.VALIDATION_ERROR);
        expect(body.error.details).toBeUndefined();
      });
    });

    it('should log Prisma errors', () => {
      const prismaError = new Prisma.PrismaClientKnownRequestError('Test error', {
        code: 'P2002',
        clientVersion: '5.0.0',
        meta: { target: ['email'] },
      });

      handleAPIError(prismaError);

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(logger.error as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
        'API Error',
        prismaError,
        expect.objectContaining({
          errorType: 'api',
        })
      );
    });
  });

  describe('Generic error handling', () => {
    it('should handle generic Error with message in development', async () => {
      (env as { NODE_ENV: string }).NODE_ENV = 'development';

      const error = new Error('Something went wrong');
      const response = handleAPIError(error);
      const body = await parseResponse(response);

      expect(response.status).toBe(500);
      const bodyError = body.error as Record<string, unknown>;
      expect(bodyError.message).toBe('Something went wrong');
      expect(bodyError.code).toBe(ErrorCodes.INTERNAL_ERROR);
      expect(bodyError.details).toBeDefined();
      const details = bodyError.details as Record<string, unknown>;
      expect(details.stack).toBeDefined();
    });

    it('should handle generic Error in production without stack trace', async () => {
      (env as { NODE_ENV: string }).NODE_ENV = 'production';

      const error = new Error('Something went wrong');
      const response = handleAPIError(error);
      const body = await parseResponse(response);

      expect(response.status).toBe(500);
      expect(body.error.message).toBe('Something went wrong');
      expect(body.error.code).toBe(ErrorCodes.INTERNAL_ERROR);
      expect(body.error.details).toBeUndefined();
    });

    it('should handle non-Error objects', async () => {
      const error = 'String error';
      const response = handleAPIError(error);
      const body = await parseResponse(response);

      expect(response.status).toBe(500);
      expect(body.error.message).toBe('An unexpected error occurred');
      expect(body.error.code).toBe(ErrorCodes.INTERNAL_ERROR);
    });

    it('should handle null error', async () => {
      const response = handleAPIError(null);
      const body = await parseResponse(response);

      expect(response.status).toBe(500);
      expect(body.error.message).toBe('An unexpected error occurred');
      expect(body.error.code).toBe(ErrorCodes.INTERNAL_ERROR);
    });

    it('should handle undefined error', async () => {
      const response = handleAPIError(undefined);
      const body = await parseResponse(response);

      expect(response.status).toBe(500);
      expect(body.error.message).toBe('An unexpected error occurred');
      expect(body.error.code).toBe(ErrorCodes.INTERNAL_ERROR);
    });

    it('should log generic errors', () => {
      const error = new Error('Generic error');
      handleAPIError(error);

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(logger.error as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
        'API Error',
        error,
        expect.objectContaining({
          errorType: 'api',
        })
      );
    });
  });

  describe('Environment-aware error details', () => {
    it('should include error details in development mode', async () => {
      (env as { NODE_ENV: string }).NODE_ENV = 'development';

      const error = new Error('Test error');
      const response = handleAPIError(error);
      const body = await parseResponse(response);

      expect(body.error.details).toBeDefined();
      expect(
        ((body.error as Record<string, unknown>).details as Record<string, unknown>).stack
      ).toBeDefined();
    });

    it('should exclude error details in production mode', async () => {
      (env as { NODE_ENV: string }).NODE_ENV = 'production';

      const error = new Error('Test error');
      const response = handleAPIError(error);
      const body = await parseResponse(response);

      expect(body.error.details).toBeUndefined();
    });

    it('should include Prisma details in development', async () => {
      (env as { NODE_ENV: string }).NODE_ENV = 'development';

      const prismaError = new Prisma.PrismaClientKnownRequestError('Database error', {
        code: 'P1001',
        clientVersion: '5.0.0',
      });

      const response = handleAPIError(prismaError);
      const body = await parseResponse(response);

      expect(body.error.details).toBeDefined();
      expect(
        ((body.error as Record<string, unknown>).details as Record<string, unknown>).code
      ).toBe('P1001');
    });

    it('should exclude Prisma details in production', async () => {
      (env as { NODE_ENV: string }).NODE_ENV = 'production';

      const prismaError = new Prisma.PrismaClientKnownRequestError('Database error', {
        code: 'P1001',
        clientVersion: '5.0.0',
      });

      const response = handleAPIError(prismaError);
      const body = await parseResponse(response);

      expect(body.error.details).toBeUndefined();
    });

    it('should always include APIError details regardless of environment', async () => {
      (env as { NODE_ENV: string }).NODE_ENV = 'production';

      const error = new ValidationError('Invalid data', {
        field: ['error message'],
      });

      const response = handleAPIError(error);
      const body = await parseResponse(response);

      // APIError details should be included even in production
      expect(body.error.details).toBeDefined();
      expect(
        ((body.error as Record<string, unknown>).details as Record<string, unknown>).field
      ).toEqual(['error message']);
    });
  });

  describe('Logger integration', () => {
    it('should log all errors with correct parameters', () => {
      const error = new Error('Test error');
      handleAPIError(error);

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(logger.error as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(logger.error as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
        'API Error',
        error,
        {
          errorType: 'api',
          isDevelopment: true,
        }
      );
    });

    it('should log with isDevelopment=false in production', () => {
      (env as { NODE_ENV: string }).NODE_ENV = 'production';

      const error = new Error('Test error');
      handleAPIError(error);

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(logger.error as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
        'API Error',
        error,
        {
          errorType: 'api',
          isDevelopment: false,
        }
      );
    });

    it('should log before returning response', () => {
      const error = new Error('Test error');
      const response = handleAPIError(error);

      // Logger should be called before response is created
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(logger.error as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalled();
      expect(response).toBeInstanceOf(Response);
    });
  });

  describe('Response format consistency', () => {
    it('should return Response object with correct content-type', () => {
      const error = new Error('Test');
      const response = handleAPIError(error);

      expect(response).toBeInstanceOf(Response);
      expect(response.headers.get('Content-Type')).toContain('application/json');
    });

    it('should always include success: false in error responses', async () => {
      const errors = [
        new APIError('Test'),
        new ValidationError(),
        new UnauthorizedError(),
        new ForbiddenError(),
        new NotFoundError(),
        new Error('Generic'),
      ];

      for (const error of errors) {
        const response = handleAPIError(error);
        const body = await parseResponse(response);

        expect(body.success).toBe(false);
      }
    });

    it('should always include error.message in responses', async () => {
      const errors = [
        new APIError('Test'),
        new ValidationError(),
        new UnauthorizedError(),
        new ForbiddenError(),
        new NotFoundError(),
        new Error('Generic'),
      ];

      for (const error of errors) {
        const response = handleAPIError(error);
        const body = await parseResponse(response);

        expect(body.error.message).toBeDefined();
        expect(typeof body.error.message).toBe('string');
        expect(((body.error as Record<string, unknown>).message as string).length).toBeGreaterThan(
          0
        );
      }
    });
  });
});
