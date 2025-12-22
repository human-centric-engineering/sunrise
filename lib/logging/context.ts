/**
 * Request Context & Tracing Utilities
 *
 * Provides functions for:
 * - Generating unique request IDs for distributed tracing
 * - Extracting request context from headers
 * - Getting user/session context from authentication
 *
 * Request IDs enable tracing a single user action across:
 * - Browser (client-side logs)
 * - API routes (server-side logs)
 * - Database operations
 * - Error tracking systems
 *
 * @example
 * ```typescript
 * // In proxy.ts or API routes:
 * const requestId = await getRequestId();
 * const logger = createLogger({ requestId });
 * logger.info('Request received');
 * ```
 */

import { nanoid } from 'nanoid';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth/config';

/**
 * Generate a unique request ID
 * Uses nanoid for cryptographically strong IDs
 * Format: 16-character alphanumeric string
 *
 * @example 'v1StGXR8_Z5jdHi6'
 */
export function generateRequestId(): string {
  return nanoid(16);
}

/**
 * Get the request ID from headers
 * Returns existing ID from headers or generates a new one
 *
 * The request ID is passed through the system via the 'x-request-id' header:
 * 1. Generated in proxy.ts for incoming requests
 * 2. Included in response headers to client
 * 3. Client includes it in subsequent API calls
 * 4. All logs for a request chain share the same ID
 *
 * @example
 * ```typescript
 * const requestId = await getRequestId();
 * // Use in logger: logger.withContext({ requestId })
 * ```
 */
export async function getRequestId(): Promise<string> {
  const headersList = await headers();
  const existingId = headersList.get('x-request-id');
  return existingId || generateRequestId();
}

/**
 * Get full request context for logging
 * Extracts relevant information from the request
 *
 * @param request - Optional Request object (for API routes)
 * @returns Request context including ID, method, URL, user agent
 *
 * @example
 * ```typescript
 * export async function GET(request: NextRequest) {
 *   const context = await getRequestContext(request);
 *   const logger = createLogger(context);
 *   logger.info('API request received');
 * }
 * ```
 */
export async function getRequestContext(request?: Request): Promise<{
  requestId: string;
  method?: string;
  url?: string;
  userAgent?: string;
}> {
  const headersList = await headers();
  const requestId = headersList.get('x-request-id') || generateRequestId();

  return {
    requestId,
    method: request?.method,
    url: request?.url,
    userAgent: headersList.get('user-agent') || undefined,
  };
}

/**
 * Get user context from current session
 * Extracts user ID, session ID, and email from better-auth session
 *
 * @returns User context if authenticated, empty object if not
 *
 * @example
 * ```typescript
 * const userContext = await getUserContext();
 * const logger = createLogger(userContext);
 * logger.info('User action', { action: 'delete-account' });
 * ```
 */
export async function getUserContext(): Promise<{
  userId?: string;
  sessionId?: string;
  email?: string;
}> {
  try {
    const session = await auth.api.getSession({
      headers: await headers(),
    });

    if (!session) {
      return {};
    }

    return {
      userId: session.user.id,
      sessionId: session.session.id,
      email: session.user.email,
    };
  } catch {
    // If auth fails, return empty context (don't throw)
    // We don't want logging utilities to break the request
    return {};
  }
}

/**
 * Get combined request and user context
 * Convenience function that merges request and user context
 *
 * @param request - Optional Request object
 * @returns Combined context for logging
 *
 * @example
 * ```typescript
 * export async function POST(request: NextRequest) {
 *   const context = await getFullContext(request);
 *   const logger = createLogger(context);
 *   logger.info('User created resource', { resourceType: 'post' });
 * }
 * ```
 */
export async function getFullContext(request?: Request): Promise<{
  requestId: string;
  method?: string;
  url?: string;
  userAgent?: string;
  userId?: string;
  sessionId?: string;
  email?: string;
}> {
  const [requestContext, userContext] = await Promise.all([
    getRequestContext(request),
    getUserContext(),
  ]);

  return {
    ...requestContext,
    ...userContext,
  };
}

/**
 * Extract endpoint path from request
 * Returns clean endpoint path without query params
 *
 * @example
 * ```typescript
 * getEndpointPath(request)
 * // Input: '/api/v1/users?page=1'
 * // Output: '/api/v1/users'
 * ```
 */
export function getEndpointPath(request: Request): string {
  try {
    const url = new URL(request.url);
    return url.pathname;
  } catch {
    return request.url;
  }
}

/**
 * Get client IP address from request
 * Checks various headers in order of preference
 *
 * Useful for rate limiting and security logging
 *
 * @example
 * ```typescript
 * const ip = await getClientIp();
 * logger.warn('Suspicious activity', { ip, action: 'multiple-failed-logins' });
 * ```
 */
export async function getClientIp(): Promise<string | undefined> {
  const headersList = await headers();

  // Check headers in order of preference
  const ipHeaders = [
    'x-forwarded-for', // Most common proxy header
    'x-real-ip', // nginx
    'cf-connecting-ip', // Cloudflare
    'x-client-ip', // Apache
    'x-cluster-client-ip', // Rackspace LB
  ];

  for (const header of ipHeaders) {
    const value = headersList.get(header);
    if (value) {
      // x-forwarded-for can contain multiple IPs: "client, proxy1, proxy2"
      // Return the first (client) IP
      return value.split(',')[0].trim();
    }
  }

  return undefined;
}
