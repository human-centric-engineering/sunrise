/**
 * API Type Definitions
 *
 * Type-safe structures for all API responses, errors, and utilities.
 * Used across all API routes for consistent, predictable response formats.
 */

/**
 * Standard API response wrapper using discriminated union for type safety
 *
 * Success response includes data and optional metadata
 * Error response includes error details with code and optional context
 *
 * @example
 * ```typescript
 * // Success
 * const response: APIResponse<User> = {
 *   success: true,
 *   data: { id: '123', name: 'John' },
 *   meta: { cached: true }
 * }
 *
 * // Error
 * const error: APIResponse<User> = {
 *   success: false,
 *   error: {
 *     message: 'User not found',
 *     code: 'NOT_FOUND'
 *   }
 * }
 * ```
 */
export type APIResponse<T> =
  | {
      success: true
      data: T
      meta?: PaginationMeta | Record<string, any>
    }
  | {
      success: false
      error: APIError
    }

/**
 * Error structure for API responses
 *
 * Provides human-readable message, optional error code for client handling,
 * and optional details object for additional context (e.g., validation errors)
 */
export interface APIError {
  /** Human-readable error message */
  message: string
  /** Machine-readable error code for client-side error handling */
  code?: string
  /** Additional context about the error (validation errors, stack traces in dev, etc.) */
  details?: Record<string, any>
}

/**
 * Pagination metadata for list endpoints
 *
 * Returned in the `meta` field of paginated API responses
 *
 * @example
 * ```typescript
 * {
 *   success: true,
 *   data: [...],
 *   meta: {
 *     page: 1,
 *     limit: 20,
 *     total: 150,
 *     totalPages: 8
 *   }
 * }
 * ```
 */
export interface PaginationMeta {
  /** Current page number (1-indexed) */
  page: number
  /** Number of items per page */
  limit: number
  /** Total number of items across all pages */
  total: number
  /** Total number of pages (calculated from total and limit) */
  totalPages: number
}

/**
 * HTTP method types
 *
 * Used for type-safe method handling in middleware and utilities
 */
export type HTTPMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS'

/**
 * Request validation result
 *
 * Used internally by validation utilities to communicate validation outcomes
 * Not typically exposed to API clients
 */
export interface ValidationResult<T> {
  /** Whether validation succeeded */
  success: boolean
  /** Validated and parsed data (only present if success is true) */
  data?: T
  /** Validation errors keyed by field name (only present if success is false) */
  errors?: Record<string, string[]>
}
