/**
 * Admin Logs Endpoint (Phase 4.4)
 *
 * GET /api/v1/admin/logs - Get application logs with filtering
 *
 * Authentication: Required (Admin role only)
 *
 * Query Parameters:
 *   - level: Filter by log level (debug, info, warn, error)
 *   - search: Search in message content
 *   - page: Page number (default: 1)
 *   - limit: Items per page (default: 50, max: 100)
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { paginatedResponse } from '@/lib/api/responses';
import { validateQueryParams } from '@/lib/api/validation';
import { logsQuerySchema } from '@/lib/validations/admin';
import { getLogEntries } from '@/lib/admin/logs';
import { getRouteLogger } from '@/lib/api/context';

/**
 * GET /api/v1/admin/logs
 *
 * Returns paginated application logs with optional filtering.
 *
 * @returns Paginated list of log entries
 * @throws UnauthorizedError if not authenticated
 * @throws ForbiddenError if not admin
 */
export const GET = withAdminAuth(async (request, _session) => {
  const log = await getRouteLogger(request);
  log.info('Fetching application logs');

  // Validate and parse query params
  const { searchParams } = request.nextUrl;
  const query = validateQueryParams(searchParams, logsQuerySchema);

  // Get filtered log entries
  const { entries, total } = getLogEntries({
    level: query.level,
    search: query.search,
    page: query.page,
    limit: query.limit,
  });

  log.info('Application logs retrieved', { count: entries.length, total });

  // Return paginated response
  return paginatedResponse(entries, {
    page: query.page,
    limit: query.limit,
    total,
  });
});
