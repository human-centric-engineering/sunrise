/**
 * API Response Utilities
 *
 * Standardized helper functions for creating consistent API responses.
 * All API routes should use these functions instead of manually constructing responses.
 */

import type { PaginationMeta } from '@/types/api';

/**
 * Default `Cache-Control` for every JSON envelope response.
 *
 * Nothing set a cache directive before this, and a response carrying a validator
 * (an `ETag`, which several routes send — see `lib/api/etag.ts`) but no freshness
 * information is *heuristically cacheable*: RFC 9111 §4.2.2 lets a shared cache
 * store it and invent its own expiry. For a per-user payload that is the wrong
 * default, and it fails silently — everything works until the day a CDN or
 * caching proxy sits in front of the origin.
 *
 * `no-cache`, deliberately not `no-store`: `no-store` forbids the client keeping
 * a copy at all, which makes conditional GET impossible and would defeat the
 * ETags. `no-cache` lets the browser store and revalidate, so the 304 path keeps
 * working. `private` keeps shared caches out of it entirely.
 *
 * It is spread *before* `options.headers`, so a route can tighten it (to
 * `no-store`, say). **Do not loosen it to `public` or add `s-maxage`**: that is
 * not supported on these helpers, for two reasons (#751). `checkConditional()`
 * in `lib/api/etag.ts` sends this constant on its 304, so the first
 * revalidation reverts a shared cache's entry to `private`. And `proxy.ts` can
 * attach a per-visitor `Set-Cookie` to any response, API responses included,
 * which a shared cache would replay to every other visitor. Supporting public
 * caching needs both fixed together. Routes returning a raw `Response` (the
 * embed widget, SSE streams, the Markdown exports) never pass through here and
 * keep whatever they set.
 *
 * See #487.
 */
export const DEFAULT_CACHE_CONTROL = 'private, no-cache';

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
  };

  return Response.json(body, {
    status: options?.status || 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': DEFAULT_CACHE_CONTROL,
      ...options?.headers,
    },
  });
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
    code?: string;
    status?: number;
    details?: Record<string, unknown>;
    headers?: HeadersInit;
  }
): Response {
  const body = {
    success: false,
    error: {
      message,
      ...(options?.code && { code: options.code }),
      ...(options?.details && { details: options.details }),
    },
  };

  return Response.json(body, {
    status: options?.status || 500,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': DEFAULT_CACHE_CONTROL,
      ...options?.headers,
    },
  });
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
    page: number;
    limit: number;
    total: number;
  },
  options?: { status?: number; headers?: HeadersInit }
): Response {
  const totalPages = Math.ceil(pagination.total / pagination.limit);

  const meta: PaginationMeta = {
    page: pagination.page,
    limit: pagination.limit,
    total: pagination.total,
    totalPages,
  };

  return successResponse(data, meta, options);
}
