/**
 * API Route Context Utilities
 *
 * Provides convenience helpers for request context tracing in API routes.
 * Combines context extraction and scoped logger creation into a single call.
 *
 * @example
 * ```typescript
 * import { getRouteLogger } from '@/lib/api/context';
 *
 * export async function GET(request: NextRequest) {
 *   const log = await getRouteLogger(request);
 *   log.info('Processing request');
 *   // ... handle request
 * }
 * ```
 */

import { getFullContext, getEndpointPath } from '@/lib/logging/context';
import { logger, type Logger } from '@/lib/logging';

/**
 * Options for `getRouteLogger`.
 */
export interface RouteLoggerOptions {
  /**
   * The route pattern to log as `endpoint`, used verbatim — e.g.
   * `'/api/v1/admin/invitations/[email]'`. Pin it on a route whose dynamic
   * segment is a credential or personal data, and always where
   * `getEndpointPath()`'s heuristic cannot recognise it (a token under 20
   * characters, one with dots or other punctuation, a one-case or slug-shaped
   * secret — see `lib/logging/redact-path.ts`). Without it, `endpoint` is the
   * resolved path with id- and credential-shaped segments collapsed to
   * `[param]` (#685).
   */
  endpoint?: string;
}

/**
 * Get a scoped logger for an API route handler
 *
 * Extracts request context (requestId, method, endpoint) and user context
 * (userId, sessionId) and returns a logger that includes all of this
 * in every log entry.
 *
 * The bound context carries no URL: the query string can hold a token or an
 * email, and the logger redacts by key name only (#685).
 *
 * @param request - The incoming request object
 * @param options - Optional `endpoint` pattern to log instead of the resolved path
 * @returns A logger scoped to this request with all context attached
 *
 * @example
 * ```typescript
 * export async function POST(request: NextRequest) {
 *   const log = await getRouteLogger(request);
 *
 *   log.info('Creating resource');
 *   // Logs: { requestId: 'abc123', userId: 'user_456', method: 'POST', endpoint: '/api/v1/users', ... }
 *
 *   try {
 *     const result = await createResource();
 *     log.info('Resource created', { resourceId: result.id });
 *     return successResponse(result);
 *   } catch (error) {
 *     log.error('Failed to create resource', error);
 *     return errorResponse('CREATE_FAILED', 'Could not create resource');
 *   }
 * }
 * ```
 */
export async function getRouteLogger(
  request: Request,
  options: RouteLoggerOptions = {}
): Promise<Logger> {
  const context = await getFullContext(request);
  const endpoint = options.endpoint ?? getEndpointPath(request);

  return logger.withContext({
    ...context,
    endpoint,
  });
}
