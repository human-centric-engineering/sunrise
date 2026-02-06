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

import { withAdminAuth } from '@/lib/auth/guards';
import { paginatedResponse } from '@/lib/api/responses';
import { validateQueryParams } from '@/lib/api/validation';
import { listInvitationsQuerySchema } from '@/lib/validations/admin';
import { getAllPendingInvitations } from '@/lib/utils/invitation-token';
import { getRouteLogger } from '@/lib/api/context';

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
export const GET = withAdminAuth(async (request, _session) => {
  const log = await getRouteLogger(request);
  log.info('Listing pending invitations');

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

  log.info('Pending invitations retrieved', { count: invitations.length, total });

  // Return paginated response
  return paginatedResponse(invitations, {
    page: query.page,
    limit: query.limit,
    total,
  });
});
