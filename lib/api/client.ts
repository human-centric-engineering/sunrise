/**
 * Type-Safe API Client
 *
 * Frontend fetch wrapper with automatic error handling, type safety, and JSON parsing.
 * Use this for all API calls from client components.
 *
 * @example
 * ```typescript
 * // GET request
 * const user = await apiClient.get<User>('/api/v1/users/me');
 *
 * // GET with query parameters
 * const users = await apiClient.get<User[]>('/api/v1/users', {
 *   params: { page: 1, limit: 10, q: 'search' }
 * });
 *
 * // POST request
 * const newUser = await apiClient.post<User>('/api/v1/users', {
 *   body: { name: 'John', email: 'john@example.com' }
 * });
 *
 * // Error handling
 * try {
 *   const user = await apiClient.get<User>('/api/v1/users/me');
 * } catch (error) {
 *   if (error instanceof APIClientError) {
 *     console.error(error.message, error.code, error.details);
 *   }
 * }
 * ```
 */

import type { APIResponse } from '@/types/api';
import { parseApiResponse } from '@/lib/api/parse-response';

/**
 * Custom error class for API client errors
 *
 * Thrown when API requests fail or return error responses.
 * Includes status code, error code, and optional details for debugging.
 */
export class APIClientError extends Error {
  constructor(
    message: string,
    public code?: string,
    public status?: number,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'APIClientError';

    // Maintains proper stack trace for where error was thrown (V8 only)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

/**
 * Request options for API client methods
 */
interface RequestOptions {
  /** Query parameters for GET requests (e.g., { page: 1, limit: 10 }) */
  params?: Record<string, string | number | boolean | undefined>;
  /** Request body for POST/PATCH/DELETE (will be JSON stringified) */
  body?: unknown;
  /** Additional fetch options (headers, credentials, signal, etc.) */
  options?: RequestInit;
}

/**
 * Get base URL for API requests
 *
 * Defaults to empty string for same-origin requests.
 * Uses NEXT_PUBLIC_APP_URL if available (useful for server-side calls).
 */
const getBaseURL = (): string => {
  // In browser, use relative URLs for same-origin requests
  if (typeof window !== 'undefined') {
    return '';
  }
  // In server-side code, use full URL if available
  return process.env.NEXT_PUBLIC_APP_URL || '';
};

/**
 * Build URL with query parameters
 *
 * Constructs full URL from path and query params, filtering out undefined values.
 *
 * @param path - API endpoint path (e.g., '/api/v1/users')
 * @param params - Query parameters object
 * @returns Full URL with query string
 */
function buildURL(
  path: string,
  params?: Record<string, string | number | boolean | undefined>
): string {
  const baseURL = getBaseURL();
  const url = new URL(path, baseURL || 'http://localhost');

  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        url.searchParams.append(key, String(value));
      }
    });
  }

  // Return relative URL if no base URL (browser context)
  return baseURL ? url.toString() : `${url.pathname}${url.search}`;
}

/**
 * Parse API response and handle errors
 *
 * Extracts data from successful responses or throws APIClientError for failures.
 * Validates response format and provides detailed error information.
 *
 * @param response - Fetch response object
 * @returns Parsed data from successful response
 * @throws {APIClientError} When response indicates failure or is malformed
 */
async function handleResponse<T>(response: Response): Promise<T> {
  // Try to parse JSON response
  let data: APIResponse<T>;

  try {
    data = await parseApiResponse<T>(response);
  } catch {
    // Non-JSON or malformed response
    throw new APIClientError(
      `Invalid response format: ${response.statusText}`,
      'INVALID_RESPONSE',
      response.status
    );
  }

  // Check if response indicates success
  if (data.success) {
    return data.data;
  }

  // Handle error response
  const apiError = data.error;
  throw new APIClientError(apiError.message, apiError.code, response.status, apiError.details);
}

/**
 * Generic HTTP request function
 *
 * Internal helper that performs the actual fetch request with proper headers,
 * body serialization, and error handling.
 *
 * @param method - HTTP method (GET, POST, PATCH, DELETE)
 * @param path - API endpoint path
 * @param options - Request options (params, body, fetch options)
 * @returns Parsed response data
 * @throws {APIClientError} When request fails or returns error
 */
async function request<T>(method: string, path: string, options?: RequestOptions): Promise<T> {
  const url = buildURL(path, options?.params);

  const fetchOptions: RequestInit = {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...options?.options?.headers,
    },
    credentials: 'same-origin',
    ...options?.options,
  };

  // Add body for non-GET requests
  if (options?.body && method !== 'GET') {
    fetchOptions.body = JSON.stringify(options.body);
  }

  try {
    const response = await fetch(url, fetchOptions);
    return await handleResponse<T>(response);
  } catch (error) {
    // Re-throw APIClientError instances
    if (error instanceof APIClientError) {
      throw error;
    }

    // Wrap other errors (network failures, etc.)
    throw new APIClientError(
      error instanceof Error ? error.message : 'Network request failed',
      'NETWORK_ERROR'
    );
  }
}

/**
 * Type-safe API client
 *
 * Provides methods for all HTTP verbs with automatic error handling and type safety.
 * All methods return typed promises and throw APIClientError on failure.
 *
 * @example
 * ```typescript
 * // GET user profile
 * const user = await apiClient.get<User>('/api/v1/users/me');
 *
 * // GET with pagination
 * const users = await apiClient.get<User[]>('/api/v1/users', {
 *   params: { page: 1, limit: 20 }
 * });
 *
 * // POST new user
 * const newUser = await apiClient.post<User>('/api/v1/users', {
 *   body: { name: 'John', email: 'john@example.com' }
 * });
 *
 * // PATCH update
 * const updated = await apiClient.patch<User>('/api/v1/users/me', {
 *   body: { name: 'Jane' }
 * });
 *
 * // DELETE
 * await apiClient.delete('/api/v1/users/123');
 * ```
 */
export const apiClient = {
  /**
   * GET request
   *
   * Fetches a resource from the API. Supports query parameters via params option.
   *
   * @param path - API endpoint path
   * @param options - Request options (params, fetch options)
   * @returns Promise resolving to typed response data
   *
   * @example
   * ```typescript
   * const user = await apiClient.get<User>('/api/v1/users/me');
   * const users = await apiClient.get<User[]>('/api/v1/users', {
   *   params: { page: 1, limit: 10 }
   * });
   * ```
   */
  get: <T>(path: string, options?: Omit<RequestOptions, 'body'>) =>
    request<T>('GET', path, options),

  /**
   * POST request
   *
   * Creates a new resource on the API. Body is automatically JSON stringified.
   *
   * @param path - API endpoint path
   * @param options - Request options (body, params, fetch options)
   * @returns Promise resolving to typed response data
   *
   * @example
   * ```typescript
   * const newUser = await apiClient.post<User>('/api/v1/users', {
   *   body: { name: 'John', email: 'john@example.com' }
   * });
   * ```
   */
  post: <T>(path: string, options?: RequestOptions) => request<T>('POST', path, options),

  /**
   * PATCH request
   *
   * Partially updates a resource on the API. Body is automatically JSON stringified.
   *
   * @param path - API endpoint path
   * @param options - Request options (body, params, fetch options)
   * @returns Promise resolving to typed response data
   *
   * @example
   * ```typescript
   * const updated = await apiClient.patch<User>('/api/v1/users/me', {
   *   body: { name: 'Jane' }
   * });
   * ```
   */
  patch: <T>(path: string, options?: RequestOptions) => request<T>('PATCH', path, options),

  /**
   * DELETE request
   *
   * Deletes a resource from the API. Can include body if needed (rare).
   *
   * @param path - API endpoint path
   * @param options - Request options (body, params, fetch options)
   * @returns Promise resolving to typed response data (often void)
   *
   * @example
   * ```typescript
   * await apiClient.delete('/api/v1/users/123');
   * ```
   */
  delete: <T = void>(path: string, options?: RequestOptions) => request<T>('DELETE', path, options),
};
