/**
 * API Error Handling Utilities
 *
 * Provides custom error classes and centralized error handling for API routes.
 * All API routes should use these error classes and the handleAPIError function
 * to ensure consistent error responses.
 *
 * @see .context/api/errors.md for error handling patterns
 */

import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { errorResponse } from '@/lib/api/responses';
import { env } from '@/lib/env';
import { logger } from '@/lib/logging';
import { OwnerReadRefusedError } from '@/lib/db/owner-extension';
import { isUniqueViolationOn, UNIQUE_CONSTRAINTS } from '@/lib/db/unique-violation';

/**
 * Error code constants for consistent error handling across the API
 *
 * Use these codes in error responses to allow clients to handle
 * specific error types programmatically
 */
export const ErrorCodes = {
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  EMAIL_TAKEN: 'EMAIL_TAKEN',
  RATE_LIMIT_EXCEEDED: 'RATE_LIMIT_EXCEEDED',
  INVITATION_EXPIRED: 'INVITATION_EXPIRED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  // Conflict errors
  CONFLICT: 'CONFLICT',
  // A save of a record that changed since it was loaded (412), or one that did
  // not say which version it was loaded at (428) — `lib/api/record-version.ts`
  STALE_RECORD: 'STALE_RECORD',
  PRECONDITION_REQUIRED: 'PRECONDITION_REQUIRED',
  // File upload errors
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',
  INVALID_FILE_TYPE: 'INVALID_FILE_TYPE',
  UPLOAD_FAILED: 'UPLOAD_FAILED',
  STORAGE_NOT_CONFIGURED: 'STORAGE_NOT_CONFIGURED',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

/**
 * Base API error class
 *
 * Extend this class for specific error types or use directly for custom errors
 *
 * @example
 * ```typescript
 * throw new APIError('Something went wrong', 'CUSTOM_ERROR', 500)
 * ```
 */
export class APIError extends Error {
  constructor(
    message: string,
    public code?: string,
    public status: number = 500,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'APIError';
    // Maintains proper stack trace for where error was thrown (V8 only)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

/**
 * Validation error (400 Bad Request)
 *
 * Used when request data fails validation (e.g., Zod schema validation)
 *
 * @example
 * ```typescript
 * throw new ValidationError('Invalid input', {
 *   email: ['Invalid email format'],
 *   password: ['Too short']
 * })
 * ```
 */
export class ValidationError extends APIError {
  constructor(message: string = 'Validation failed', details?: Record<string, unknown>) {
    super(message, ErrorCodes.VALIDATION_ERROR, 400, details);
    this.name = 'ValidationError';
  }
}

/**
 * Unauthorized error (401 Unauthorized)
 *
 * Used when authentication is required but not provided or invalid
 *
 * @example
 * ```typescript
 * if (!session) {
 *   throw new UnauthorizedError()
 * }
 * ```
 */
export class UnauthorizedError extends APIError {
  constructor(message: string = 'Unauthorized') {
    super(message, ErrorCodes.UNAUTHORIZED, 401);
    this.name = 'UnauthorizedError';
  }
}

/**
 * Forbidden error (403 Forbidden)
 *
 * Used when user is authenticated but lacks permission for the requested resource
 *
 * @example
 * ```typescript
 * if (!isPlatformAdmin(session.user)) {
 *   throw new ForbiddenError('Admin access required')
 * }
 * ```
 */
export class ForbiddenError extends APIError {
  constructor(message: string = 'Forbidden') {
    super(message, ErrorCodes.FORBIDDEN, 403);
    this.name = 'ForbiddenError';
  }
}

/**
 * Not found error (404 Not Found)
 *
 * Used when a requested resource does not exist
 *
 * @example
 * ```typescript
 * if (!user) {
 *   throw new NotFoundError('User not found')
 * }
 * ```
 */
export class NotFoundError extends APIError {
  constructor(message: string = 'Resource not found') {
    super(message, ErrorCodes.NOT_FOUND, 404);
    this.name = 'NotFoundError';
  }
}

/**
 * Conflict error (HTTP 409)
 *
 * Use when a resource already exists or there's a conflict with the current state.
 *
 * @example
 * ```typescript
 * if (existingFlag) {
 *   throw new ConflictError('Feature flag already exists')
 * }
 * ```
 */
export class ConflictError extends APIError {
  constructor(message: string = 'Resource already exists', details?: Record<string, unknown>) {
    super(message, ErrorCodes.CONFLICT, 409, details);
    this.name = 'ConflictError';
  }
}

/**
 * A save of a record that has changed since the caller loaded it (412).
 *
 * The caller's `If-Match` names the version it loaded, and the record has
 * moved on: another admin saved it, or an erasure scrubbed it. Nothing was
 * written. The client reloads and makes its change again.
 *
 * @see lib/api/record-version.ts
 */
export class StaleRecordError extends APIError {
  constructor(
    message: string = 'This changed since you opened it. Reload to see the current version, then make your change again.'
  ) {
    super(message, ErrorCodes.STALE_RECORD, 412);
    this.name = 'StaleRecordError';
  }
}

/**
 * A save that did not say which version of the record it was loaded at (428).
 *
 * The message is written for the admin who sees it, since forms show a
 * route's message as it stands; an API client acts on the code, and the
 * docs say what to send (`If-Match`, with the version its read returned).
 *
 * @see lib/api/record-version.ts
 */
export class PreconditionRequiredError extends APIError {
  constructor(
    message: string = 'This save did not say which version it was based on. Reload and try again.'
  ) {
    super(message, ErrorCodes.PRECONDITION_REQUIRED, 428);
    this.name = 'PreconditionRequiredError';
  }
}

/**
 * Centralized error handler for API routes
 *
 * Handles APIError instances, Zod validation errors, Prisma errors,
 * and unknown errors with appropriate HTTP status codes and error messages
 *
 * @param error - Any error thrown in an API route
 * @returns Response object with formatted error
 *
 * @example
 * ```typescript
 * export async function GET(request: NextRequest) {
 *   try {
 *     // ... route logic
 *   } catch (error) {
 *     return handleAPIError(error)
 *   }
 * }
 * ```
 */
export function handleAPIError(error: unknown): Response {
  // Log all API errors with structured logger
  // In production: JSON format for log aggregation
  // In development: human-readable format for debugging
  logger.error('API Error', error, {
    errorType: 'api',
    isDevelopment: env.NODE_ENV === 'development',
  });

  // Handle custom APIError instances
  if (error instanceof APIError) {
    return errorResponse(error.message, {
      code: error.code,
      status: error.status,
      details: error.details,
    });
  }

  // A narrowed caller's read of another member's rows (§115). Answered as the
  // 404 a missing row gets, so the refusal does not confirm the row exists;
  // the log line above carries the model and operation for whoever debugs it.
  if (error instanceof OwnerReadRefusedError) {
    return errorResponse('Resource not found', {
      code: ErrorCodes.NOT_FOUND,
      status: 404,
    });
  }

  // Handle Zod validation errors
  if (error instanceof z.ZodError) {
    // Transform Zod errors into a more readable format
    const details: Record<string, string[]> = {};

    error.issues.forEach((err: z.ZodIssue) => {
      const path = err.path.join('.');
      if (!details[path]) {
        details[path] = [];
      }
      details[path].push(err.message);
    });

    return errorResponse('Validation failed', {
      code: ErrorCodes.VALIDATION_ERROR,
      status: 400,
      details,
    });
  }

  // Handle Prisma errors
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    // Unique constraint violation. Only a duplicate email is EMAIL_TAKEN,
    // which clients render as "this email address is already registered".
    // Any other collision keeps the 400 it always had, as VALIDATION_ERROR: the
    // value is taken. Some routes answer 409 for "a concurrent change, please
    // retry" and send every other unique violation here to tell the two apart
    // (agent PATCH and import, bulk, instructions revert, backup import), and
    // the knowledge section editor reads any 409 as an edit conflict (t-796).
    if (error.code === 'P2002') {
      if (isUniqueViolationOn(error, UNIQUE_CONSTRAINTS.userEmail)) {
        return errorResponse('Email already exists', {
          code: ErrorCodes.EMAIL_TAKEN,
          status: 400,
          details: { field: 'email', constraint: 'unique' },
        });
      }
      // No `details`: a VALIDATION_ERROR's details are a field → messages
      // map, and the error does not say which field collided.
      return errorResponse('A record with that value already exists', {
        code: ErrorCodes.VALIDATION_ERROR,
        status: 400,
      });
    }

    // Record not found
    if (error.code === 'P2025') {
      return errorResponse('Record not found', {
        code: ErrorCodes.NOT_FOUND,
        status: 404,
      });
    }

    // Foreign key constraint violation
    if (error.code === 'P2003') {
      return errorResponse('Invalid reference', {
        code: ErrorCodes.VALIDATION_ERROR,
        status: 400,
        details: { constraint: 'foreign_key' },
      });
    }

    // Generic Prisma error
    return errorResponse('Database error', {
      code: ErrorCodes.INTERNAL_ERROR,
      status: 500,
      details:
        env.NODE_ENV === 'development' ? { code: error.code, message: error.message } : undefined,
    });
  }

  // Handle Prisma validation errors
  if (error instanceof Prisma.PrismaClientValidationError) {
    return errorResponse('Invalid data format', {
      code: ErrorCodes.VALIDATION_ERROR,
      status: 400,
      details: env.NODE_ENV === 'development' ? { message: error.message } : undefined,
    });
  }

  // Handle unknown errors — use generic message in production to avoid leaking
  // implementation details (database errors, internal paths, etc.)
  const message =
    env.NODE_ENV !== 'production' && error instanceof Error
      ? error.message
      : 'An unexpected error occurred';

  return errorResponse(message, {
    code: ErrorCodes.INTERNAL_ERROR,
    status: 500,
    details:
      env.NODE_ENV === 'development' && error instanceof Error ? { stack: error.stack } : undefined,
  });
}
