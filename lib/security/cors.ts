/**
 * CORS Configuration
 *
 * Cross-Origin Resource Sharing utilities for API routes.
 * Configurable via ALLOWED_ORIGINS environment variable.
 *
 * Features:
 * - Environment-based origin validation
 * - Preflight request handling
 * - HOC wrapper for API routes
 * - Automatic localhost support in development
 *
 * Default behavior:
 * - Same-origin only when ALLOWED_ORIGINS is not set (most secure)
 * - Configurable external access via ALLOWED_ORIGINS env var
 *
 * @example
 * ```typescript
 * // In API route
 * import { withCORS, handlePreflight } from '@/lib/security/cors';
 *
 * export async function OPTIONS(request: NextRequest) {
 *   return handlePreflight(request);
 * }
 *
 * export const POST = withCORS(async (request: NextRequest) => {
 *   // Your handler
 * });
 * ```
 */

import { NextRequest, NextResponse } from 'next/server';
import { SECURITY_CONSTANTS } from './constants';

/**
 * CORS configuration options
 */
export interface CORSOptions {
  /** Allowed origins (string, array, or function) */
  origin?: string | string[] | ((origin: string) => boolean);
  /** Allowed HTTP methods */
  methods?: string[];
  /** Headers clients can send */
  allowedHeaders?: string[];
  /** Headers clients can read from response */
  exposedHeaders?: string[];
  /** Allow credentials (cookies, auth headers) */
  credentials?: boolean;
  /** Preflight cache duration in seconds */
  maxAge?: number;
}

/**
 * Get allowed origins from environment
 *
 * In development: includes localhost variants
 * In production: only explicitly configured origins
 */
function getDefaultOrigins(): string[] {
  const origins: string[] = [];

  // Add configured origins from environment
  const configuredOrigins = process.env.ALLOWED_ORIGINS;
  if (configuredOrigins) {
    origins.push(
      ...configuredOrigins
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean)
    );
  }

  // Add localhost variants in development
  if (process.env.NODE_ENV === 'development') {
    origins.push('http://localhost:3000', 'http://localhost:3001', 'http://127.0.0.1:3000');
  }

  return origins;
}

/**
 * Default CORS options
 *
 * Safe defaults that work for most applications:
 * - Only allow configured origins
 * - Allow common HTTP methods
 * - Allow credentials for session-based auth
 */
const DEFAULT_CORS_OPTIONS: CORSOptions = {
  origin: getDefaultOrigins(),
  methods: [...SECURITY_CONSTANTS.CORS.METHODS],
  allowedHeaders: [...SECURITY_CONSTANTS.CORS.ALLOWED_HEADERS],
  exposedHeaders: [...SECURITY_CONSTANTS.CORS.EXPOSED_HEADERS],
  credentials: true,
  maxAge: SECURITY_CONSTANTS.CORS.MAX_AGE,
};

/**
 * Check if an origin is allowed
 *
 * @param origin - Request origin header value
 * @param allowed - Allowed origins configuration
 * @returns Whether the origin is allowed
 */
export function isOriginAllowed(origin: string | null, allowed: CORSOptions['origin']): boolean {
  // No origin = deny (fail-secure)
  if (!origin) return false;

  // No config = deny all external
  if (!allowed) return false;

  // Function validator
  if (typeof allowed === 'function') {
    return allowed(origin);
  }

  // Single string
  if (typeof allowed === 'string') {
    return origin === allowed;
  }

  // Array of strings
  if (Array.isArray(allowed)) {
    return allowed.includes(origin);
  }

  return false;
}

/**
 * Set CORS headers on a response
 *
 * @param response - Response to add headers to
 * @param request - Original request (for origin header)
 * @param options - CORS configuration options
 */
export function setCORSHeaders(
  response: NextResponse,
  request: NextRequest,
  options: CORSOptions = DEFAULT_CORS_OPTIONS
): void {
  const origin = request.headers.get('origin');
  const mergedOptions = { ...DEFAULT_CORS_OPTIONS, ...options };

  // Only set Access-Control-Allow-Origin if origin is allowed
  if (origin && isOriginAllowed(origin, mergedOptions.origin)) {
    response.headers.set('Access-Control-Allow-Origin', origin);

    // Vary header prevents caching issues with different origins
    response.headers.append('Vary', 'Origin');
  }

  // Allow credentials (cookies, auth headers)
  if (mergedOptions.credentials) {
    response.headers.set('Access-Control-Allow-Credentials', 'true');
  }

  // Allowed methods
  if (mergedOptions.methods?.length) {
    response.headers.set('Access-Control-Allow-Methods', mergedOptions.methods.join(', '));
  }

  // Allowed request headers
  if (mergedOptions.allowedHeaders?.length) {
    response.headers.set('Access-Control-Allow-Headers', mergedOptions.allowedHeaders.join(', '));
  }

  // Exposed response headers
  if (mergedOptions.exposedHeaders?.length) {
    response.headers.set('Access-Control-Expose-Headers', mergedOptions.exposedHeaders.join(', '));
  }

  // Preflight cache duration
  if (mergedOptions.maxAge !== undefined) {
    response.headers.set('Access-Control-Max-Age', String(mergedOptions.maxAge));
  }
}

/**
 * Handle CORS preflight (OPTIONS) request
 *
 * @param request - Preflight request
 * @param options - CORS configuration options
 * @returns 204 No Content response with CORS headers
 *
 * @example
 * ```typescript
 * // In app/api/v1/resource/route.ts
 * export async function OPTIONS(request: NextRequest) {
 *   return handlePreflight(request);
 * }
 * ```
 */
export function handlePreflight(
  request: NextRequest,
  options: CORSOptions = DEFAULT_CORS_OPTIONS
): NextResponse {
  const response = new NextResponse(null, { status: 204 });
  setCORSHeaders(response, request, options);
  return response;
}

/**
 * Higher-order function to add CORS to an API handler
 *
 * Wraps an API route handler and adds CORS headers to the response.
 * Use with handlePreflight for complete CORS support.
 *
 * @param handler - API route handler function
 * @param options - CORS configuration options
 * @returns Wrapped handler with CORS headers
 *
 * @example
 * ```typescript
 * // In app/api/v1/resource/route.ts
 * import { withCORS, handlePreflight } from '@/lib/security/cors';
 *
 * export async function OPTIONS(request: NextRequest) {
 *   return handlePreflight(request);
 * }
 *
 * export const GET = withCORS(async (request: NextRequest) => {
 *   return Response.json({ data: 'example' });
 * });
 *
 * export const POST = withCORS(async (request: NextRequest) => {
 *   const body = await request.json();
 *   return Response.json({ created: true });
 * });
 * ```
 */
export function withCORS<T extends (request: NextRequest) => Promise<Response>>(
  handler: T,
  options?: CORSOptions
): T {
  return (async (request: NextRequest): Promise<Response> => {
    // Run the actual handler
    const response = await handler(request);

    // Convert to NextResponse to add headers
    const body = await response.clone().text();
    const nextResponse = new NextResponse(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });

    // Add CORS headers
    setCORSHeaders(nextResponse, request, options);

    return nextResponse;
  }) as T;
}

/**
 * Create a CORS-enabled API route handler object
 *
 * Convenience function that creates both OPTIONS handler and wraps
 * other methods with CORS support.
 *
 * @param handlers - Object of HTTP method handlers
 * @param options - CORS configuration options
 * @returns Object with CORS-wrapped handlers
 *
 * @example
 * ```typescript
 * // In app/api/v1/resource/route.ts
 * import { createCORSHandlers } from '@/lib/security/cors';
 *
 * const handlers = createCORSHandlers({
 *   GET: async (request) => Response.json({ data: 'example' }),
 *   POST: async (request) => Response.json({ created: true }),
 * });
 *
 * export const { GET, POST, OPTIONS } = handlers;
 * ```
 */
export function createCORSHandlers<
  T extends Record<string, (request: NextRequest) => Promise<Response>>,
>(handlers: T, options?: CORSOptions): T & { OPTIONS: (request: NextRequest) => NextResponse } {
  const wrapped: Record<string, (request: NextRequest) => Promise<Response> | Response> = {
    OPTIONS: (request: NextRequest) => handlePreflight(request, options),
  };

  for (const [method, handler] of Object.entries(handlers)) {
    wrapped[method] = withCORS(handler, options);
  }

  return wrapped as T & { OPTIONS: (request: NextRequest) => NextResponse };
}
