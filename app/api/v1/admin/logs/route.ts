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

import { headers } from 'next/headers';
import { NextRequest } from 'next/server';
import { auth } from '@/lib/auth/config';
import { paginatedResponse } from '@/lib/api/responses';
import { UnauthorizedError, ForbiddenError, handleAPIError } from '@/lib/api/errors';
import { validateQueryParams } from '@/lib/api/validation';
import { logsQuerySchema } from '@/lib/validations/admin';
import { getLogEntries } from '@/lib/admin/logs';

/**
 * GET /api/v1/admin/logs
 *
 * Returns paginated application logs with optional filtering.
 *
 * @returns Paginated list of log entries
 * @throws UnauthorizedError if not authenticated
 * @throws ForbiddenError if not admin
 */
export async function GET(request: NextRequest) {
  try {
    // Authenticate and check role
    const requestHeaders = await headers();
    const session = await auth.api.getSession({ headers: requestHeaders });

    if (!session) {
      throw new UnauthorizedError();
    }

    if (session.user.role !== 'ADMIN') {
      throw new ForbiddenError('Admin access required');
    }

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

    // Return paginated response
    return paginatedResponse(entries, {
      page: query.page,
      limit: query.limit,
      total,
    });
  } catch (error) {
    return handleAPIError(error);
  }
}
