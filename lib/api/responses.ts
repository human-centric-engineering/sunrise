/**
 * API Response Utilities
 *
 * Standardized helper functions for creating consistent API responses.
 * All API routes should use these functions instead of manually constructing responses.
 */

import type { PaginationMeta } from '@/types/api'

/**
 * Create a successful API response
 *
 * Returns a properly formatted success response with data and optional metadata
 *
 * @param data - The response payload
 * @param meta - Optional metadata (pagination info, cache info, etc.)
 * @param options - Optional HTTP status code and headers
 * @returns Response object with JSON content-type
 *
 * @example
 * ```typescript
 * // Simple success
 * return successResponse({ id: '123', name: 'John' })
 *
 * // With pagination metadata
 * return successResponse(users, {
 *   page: 1,
 *   limit: 20,
 *   total: 150,
 *   totalPages: 8
 * })
 *
 * // With custom status and headers
 * return successResponse(newUser, undefined, {
 *   status: 201,
 *   headers: { 'Location': '/api/v1/users/123' }
 * })
 * ```
 */
export function successResponse<T>(
  data: T,
  meta?: PaginationMeta | Record<string, unknown>,
  options?: { status?: number; headers?: HeadersInit }
): Response {
  const body = {
    success: true,
    data,
    ...(meta && { meta }),
  }

  return Response.json(body, {
    status: options?.status || 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...options?.headers,
    },
  })
}

/**
 * Create an error API response
 *
 * Returns a properly formatted error response with message, code, and optional details
 *
 * @param message - Human-readable error message
 * @param options - Error code, HTTP status, details, and headers
 * @returns Response object with JSON content-type
 *
 * @example
 * ```typescript
 * // Simple error
 * return errorResponse('User not found', {
 *   code: 'NOT_FOUND',
 *   status: 404
 * })
 *
 * // Validation error with details
 * return errorResponse('Validation failed', {
 *   code: 'VALIDATION_ERROR',
 *   status: 400,
 *   details: {
 *     email: ['Invalid email format'],
 *     password: ['Password too short']
 *   }
 * })
 * ```
 */
export function errorResponse(
  message: string,
  options?: {
    code?: string
    status?: number
    details?: Record<string, unknown>
    headers?: HeadersInit
  }
): Response {
  const body = {
    success: false,
    error: {
      message,
      ...(options?.code && { code: options.code }),
      ...(options?.details && { details: options.details }),
    },
  }

  return Response.json(body, {
    status: options?.status || 500,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...options?.headers,
    },
  })
}

/**
 * Create a paginated API response
 *
 * Convenience function for list endpoints with pagination.
 * Automatically calculates totalPages from total and limit.
 *
 * @param data - Array of items to return
 * @param pagination - Pagination information (page, limit, total)
 * @param options - Optional HTTP status code and headers
 * @returns Response object with pagination metadata
 *
 * @example
 * ```typescript
 * const [users, total] = await Promise.all([
 *   prisma.user.findMany({ skip, take: limit }),
 *   prisma.user.count()
 * ])
 *
 * return paginatedResponse(users, {
 *   page: 1,
 *   limit: 20,
 *   total: 150
 * })
 * // Returns: { success: true, data: [...], meta: { page: 1, limit: 20, total: 150, totalPages: 8 } }
 * ```
 */
export function paginatedResponse<T>(
  data: T[],
  pagination: {
    page: number
    limit: number
    total: number
  },
  options?: { status?: number; headers?: HeadersInit }
): Response {
  const totalPages = Math.ceil(pagination.total / pagination.limit)

  const meta: PaginationMeta = {
    page: pagination.page,
    limit: pagination.limit,
    total: pagination.total,
    totalPages,
  }

  return successResponse(data, meta, options)
}
