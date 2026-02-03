/**
 * Users Management Endpoints (Admin Only)
 *
 * GET /api/v1/users - List all users with pagination, search, and sorting
 *
 * Authentication: Required (Admin role only)
 *
 * GET Query Parameters:
 *   - page: Page number (default: 1)
 *   - limit: Items per page (default: 20, max: 100)
 *   - search: Search query for name/email (optional)
 *   - sortBy: Field to sort by (name, email, createdAt)
 *   - sortOrder: Sort order (asc, desc)
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { paginatedResponse } from '@/lib/api/responses';
import { validateQueryParams, parsePaginationParams } from '@/lib/api/validation';
import { listUsersQuerySchema } from '@/lib/validations/user';

/**
 * GET /api/v1/users
 *
 * Returns a paginated list of users.
 * Supports search across name and email fields.
 * Supports sorting by name, email, or createdAt.
 *
 * @example
 * GET /api/v1/users?page=1&limit=20&search=john&sortBy=createdAt&sortOrder=desc
 *
 * @returns Paginated list of users with metadata
 * @throws UnauthorizedError if not authenticated
 * @throws ForbiddenError if not admin
 * @throws ValidationError if invalid query params
 */
export const GET = withAdminAuth(async (request, _session) => {
  // Validate and parse query params
  const { searchParams } = request.nextUrl;
  const query = validateQueryParams(searchParams, listUsersQuerySchema);
  const { page, limit, skip } = parsePaginationParams(searchParams);

  // Build Prisma where clause for search
  const where = query.search
    ? {
        OR: [
          { name: { contains: query.search, mode: 'insensitive' as const } },
          { email: { contains: query.search, mode: 'insensitive' as const } },
        ],
      }
    : {};

  // Execute queries in parallel for performance
  const [users, total] = await Promise.all([
    prisma.user.findMany({
      where,
      skip,
      take: limit,
      select: {
        id: true,
        name: true,
        email: true,
        image: true,
        role: true,
        emailVerified: true,
        createdAt: true,
      },
      orderBy: { [query.sortBy]: query.sortOrder },
    }),
    prisma.user.count({ where }),
  ]);

  // Return paginated response
  return paginatedResponse(users, { page, limit, total });
});
