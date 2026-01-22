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

import { NextRequest } from 'next/server';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { paginatedResponse } from '@/lib/api/responses';
import { UnauthorizedError, ForbiddenError, handleAPIError } from '@/lib/api/errors';
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
  } catch (error) {
    return handleAPIError(error);
  }
}
