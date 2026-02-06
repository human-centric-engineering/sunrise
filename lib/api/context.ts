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
 * Get a scoped logger for an API route handler
 *
 * Extracts request context (requestId, method, endpoint) and user context
 * (userId, sessionId) and returns a logger that includes all of this
 * in every log entry.
 *
 * @param request - The incoming request object
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
export async function getRouteLogger(request: Request): Promise<Logger> {
  const context = await getFullContext(request);
  const endpoint = getEndpointPath(request);

  return logger.withContext({
    ...context,
    endpoint,
  });
}
