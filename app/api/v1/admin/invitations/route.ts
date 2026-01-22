/**
 * Admin Invitations List Endpoint
 *
 * GET /api/v1/admin/invitations - List all pending user invitations
 *
 * Authentication: Required (Admin role only)
 *
 * Query Parameters:
 *   - page: Page number (default: 1)
 *   - limit: Items per page (default: 20, max: 100)
 *   - search: Search query for name/email (optional)
 *   - sortBy: Field to sort by (name, email, invitedAt, expiresAt)
 *   - sortOrder: Sort order (asc, desc)
 */

import { NextRequest } from 'next/server';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth/config';
import { paginatedResponse } from '@/lib/api/responses';
import { UnauthorizedError, ForbiddenError, handleAPIError } from '@/lib/api/errors';
import { validateQueryParams } from '@/lib/api/validation';
import { listInvitationsQuerySchema } from '@/lib/validations/admin';
import { getAllPendingInvitations } from '@/lib/utils/invitation-token';

/**
 * GET /api/v1/admin/invitations
 *
 * Returns a paginated list of pending user invitations.
 * Supports search across name and email fields.
 * Supports sorting by name, email, invitedAt, or expiresAt.
 *
 * @example
 * GET /api/v1/admin/invitations?page=1&limit=20&search=john&sortBy=invitedAt&sortOrder=desc
 *
 * @returns Paginated list of invitations with metadata
 * @throws UnauthorizedError if not authenticated
 * @throws ForbiddenError if not admin
 * @throws ValidationError if invalid query params
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
    const query = validateQueryParams(searchParams, listInvitationsQuerySchema);

    // Fetch pending invitations
    const { invitations, total } = await getAllPendingInvitations({
      search: query.search,
      page: query.page,
      limit: query.limit,
      sortBy: query.sortBy,
      sortOrder: query.sortOrder,
    });

    // Return paginated response
    return paginatedResponse(invitations, {
      page: query.page,
      limit: query.limit,
      total,
    });
  } catch (error) {
    return handleAPIError(error);
  }
}
