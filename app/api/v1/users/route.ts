/**
 * Users Management Endpoints (Admin Only)
 *
 * GET /api/v1/users - List all users with pagination, search, and sorting
 * POST /api/v1/users - Create a new user
 *
 * Authentication: Required (Admin role only)
 *
 * GET Query Parameters:
 *   - page: Page number (default: 1)
 *   - limit: Items per page (default: 20, max: 100)
 *   - search: Search query for name/email (optional)
 *   - sortBy: Field to sort by (name, email, createdAt)
 *   - sortOrder: Sort order (asc, desc)
 *
 * POST Request Body:
 *   - name: User's full name (required)
 *   - email: User's email address (required, must be unique)
 *   - password: User's password (optional, auto-generated if not provided)
 *   - role: User's role (optional, defaults to USER)
 */

import { NextRequest } from 'next/server';
import { headers } from 'next/headers';
import { randomBytes } from 'crypto';
import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { successResponse, paginatedResponse, errorResponse } from '@/lib/api/responses';
import { UnauthorizedError, ForbiddenError, handleAPIError, ErrorCodes } from '@/lib/api/errors';
import {
  validateRequestBody,
  validateQueryParams,
  parsePaginationParams,
} from '@/lib/api/validation';
import { createUserSchema, listUsersQuerySchema } from '@/lib/validations/user';

/**
 * Type definitions for better-auth signup API responses
 */
interface BetterAuthUser {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  createdAt: string;
}

interface BetterAuthSession {
  token: string;
  userId: string;
  expiresAt: string;
}

interface BetterAuthSignupResponse {
  user: BetterAuthUser;
  session?: BetterAuthSession;
}

interface BetterAuthError {
  message?: string;
  code?: string;
}

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
          role: true,
          createdAt: true,
          // Exclude password, emailVerified, etc. for list view
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

/**
 * POST /api/v1/users
 *
 * Creates a new user via better-auth's signup API (admin only).
 * This guarantees password compatibility with better-auth's login verification.
 *
 * @example
 * POST /api/v1/users
 * {
 *   "name": "John Doe",
 *   "email": "john@example.com",
 *   "password": "SecurePassword123!", // optional, auto-generated if not provided
 *   "role": "ADMIN" // optional, defaults to USER
 * }
 *
 * @returns Created user object
 * @throws UnauthorizedError if not authenticated
 * @throws ForbiddenError if not admin
 * @throws ValidationError if invalid request body
 */
export async function POST(request: NextRequest) {
  try {
    // ============================================================================
    // USER CREATION - BETTER-AUTH DELEGATION
    // ============================================================================
    // This endpoint delegates user creation to better-auth's signup API to ensure
    // password hashing is 100% compatible with better-auth's login verification.
    //
    // If you switch to a different authentication library, you will need to:
    // 1. Replace the fetch call with your new library's user creation method
    // 2. Update the session cleanup logic if needed
    // 3. Adjust the response structure to match your library's format
    //
    // This approach is recommended for starter templates because:
    // - Guaranteed compatibility (no password hashing mismatches)
    // - Future-proof (automatically adapts to better-auth internal changes)
    // - Self-documenting (code clearly shows delegation to better-auth)
    // ============================================================================

    // 1. Authenticate and authorize (admin only)
    const requestHeaders = await headers();
    const session = await auth.api.getSession({ headers: requestHeaders });

    if (!session) {
      throw new UnauthorizedError();
    }

    if (session.user.role !== 'ADMIN') {
      throw new ForbiddenError('Admin access required');
    }

    // 2. Validate request body
    const body = await validateRequestBody(request, createUserSchema);

    // 3. Generate secure random password if not provided
    const password = body.password || randomBytes(16).toString('hex');

    // 4. Create user via better-auth signup API (guarantees compatibility)
    const signupResponse = await fetch(`${process.env.BETTER_AUTH_URL}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: body.name,
        email: body.email,
        password: password,
      }),
    });

    if (!signupResponse.ok) {
      const error = (await signupResponse
        .json()
        .catch(() => ({}) as BetterAuthError)) as BetterAuthError;

      // Handle duplicate email or other signup errors
      if (error.message?.includes('already exists') || error.message?.includes('duplicate')) {
        return errorResponse('Email already in use', {
          code: ErrorCodes.EMAIL_TAKEN,
          status: 400,
        });
      }

      throw new Error(error.message || 'User creation failed');
    }

    const signupData = (await signupResponse.json()) as BetterAuthSignupResponse;
    const createdUser = signupData.user;

    // 5. Update role if different from default (signup creates USER role)
    if (body.role && body.role !== 'USER') {
      await prisma.user.update({
        where: { id: createdUser.id },
        data: { role: body.role },
      });
    }

    // 6. Clean up the session created by signup (we don't want admin logged in as new user)
    if (signupData.session) {
      await prisma.session
        .delete({
          where: { token: signupData.session.token },
        })
        .catch(() => {
          // Ignore if session doesn't exist or was already cleaned up
        });
    }

    // 7. Return created user
    return successResponse(
      {
        id: createdUser.id,
        name: createdUser.name,
        email: createdUser.email,
        role: body.role || 'USER',
        emailVerified: createdUser.emailVerified,
        createdAt: createdUser.createdAt,
      },
      undefined,
      { status: 201 }
    );
  } catch (error) {
    return handleAPIError(error);
  }
}
