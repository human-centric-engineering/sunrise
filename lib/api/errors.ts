/**
 * API Error Handling Utilities
 *
 * Provides custom error classes and centralized error handling for API routes.
 * All API routes should use these error classes and the handleAPIError function
 * to ensure consistent error responses.
 */

import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { errorResponse } from './responses'

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
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes]

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
    public details?: Record<string, any>
  ) {
    super(message)
    this.name = 'APIError'
    // Maintains proper stack trace for where error was thrown (V8 only)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor)
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
  constructor(message: string = 'Validation failed', details?: Record<string, any>) {
    super(message, ErrorCodes.VALIDATION_ERROR, 400, details)
    this.name = 'ValidationError'
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
    super(message, ErrorCodes.UNAUTHORIZED, 401)
    this.name = 'UnauthorizedError'
  }
}

/**
 * Forbidden error (403 Forbidden)
 *
 * Used when user is authenticated but lacks permission for the requested resource
 *
 * @example
 * ```typescript
 * if (session.user.role !== 'ADMIN') {
 *   throw new ForbiddenError('Admin access required')
 * }
 * ```
 */
export class ForbiddenError extends APIError {
  constructor(message: string = 'Forbidden') {
    super(message, ErrorCodes.FORBIDDEN, 403)
    this.name = 'ForbiddenError'
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
    super(message, ErrorCodes.NOT_FOUND, 404)
    this.name = 'NotFoundError'
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
  // Log error in development for debugging
  if (process.env.NODE_ENV === 'development') {
    console.error('API Error:', error)
  }

  // Handle custom APIError instances
  if (error instanceof APIError) {
    return errorResponse(error.message, {
      code: error.code,
      status: error.status,
      details: error.details,
    })
  }

  // Handle Zod validation errors
  if (error instanceof z.ZodError) {
    // Transform Zod errors into a more readable format
    const details: Record<string, string[]> = {}

    error.issues.forEach((err: z.ZodIssue) => {
      const path = err.path.join('.')
      if (!details[path]) {
        details[path] = []
      }
      details[path].push(err.message)
    })

    return errorResponse('Validation failed', {
      code: ErrorCodes.VALIDATION_ERROR,
      status: 400,
      details,
    })
  }

  // Handle Prisma errors
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    // Unique constraint violation (e.g., duplicate email)
    if (error.code === 'P2002') {
      const target = (error.meta?.target as string[]) || []
      const field = target[0] || 'field'

      return errorResponse(`${field.charAt(0).toUpperCase() + field.slice(1)} already exists`, {
        code: ErrorCodes.EMAIL_TAKEN,
        status: 400,
        details: { field, constraint: 'unique' },
      })
    }

    // Record not found
    if (error.code === 'P2025') {
      return errorResponse('Record not found', {
        code: ErrorCodes.NOT_FOUND,
        status: 404,
      })
    }

    // Foreign key constraint violation
    if (error.code === 'P2003') {
      return errorResponse('Invalid reference', {
        code: ErrorCodes.VALIDATION_ERROR,
        status: 400,
        details: { constraint: 'foreign_key' },
      })
    }

    // Generic Prisma error
    return errorResponse('Database error', {
      code: ErrorCodes.INTERNAL_ERROR,
      status: 500,
      details:
        process.env.NODE_ENV === 'development'
          ? { code: error.code, message: error.message }
          : undefined,
    })
  }

  // Handle Prisma validation errors
  if (error instanceof Prisma.PrismaClientValidationError) {
    return errorResponse('Invalid data format', {
      code: ErrorCodes.VALIDATION_ERROR,
      status: 400,
      details: process.env.NODE_ENV === 'development' ? { message: error.message } : undefined,
    })
  }

  // Handle unknown errors
  const message = error instanceof Error ? error.message : 'An unexpected error occurred'

  return errorResponse(message, {
    code: ErrorCodes.INTERNAL_ERROR,
    status: 500,
    details:
      process.env.NODE_ENV === 'development' && error instanceof Error
        ? { stack: error.stack }
        : undefined,
  })
}
