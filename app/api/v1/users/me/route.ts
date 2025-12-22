/**
 * Current User Endpoint
 *
 * GET /api/v1/users/me - Get current authenticated user's profile
 * PATCH /api/v1/users/me - Update current user's profile
 *
 * Authentication: Required (session-based via better-auth)
 */

import { NextRequest } from 'next/server';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { successResponse, errorResponse } from '@/lib/api/responses';
import { UnauthorizedError, handleAPIError, ErrorCodes } from '@/lib/api/errors';
import { validateRequestBody } from '@/lib/api/validation';
import { updateUserSchema } from '@/lib/validations/user';

/**
 * GET /api/v1/users/me
 *
 * Returns the current authenticated user's profile.
 * Password field is explicitly excluded from the response.
 *
 * @returns User profile with id, name, email, role, etc.
 * @throws UnauthorizedError if not authenticated
 */
export async function GET(_request: NextRequest) {
  try {
    // Get session from better-auth
    const requestHeaders = await headers();
    const session = await auth.api.getSession({ headers: requestHeaders });

    if (!session) {
      throw new UnauthorizedError();
    }

    // Fetch user from database
    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: {
        id: true,
        name: true,
        email: true,
        emailVerified: true,
        image: true,
        role: true,
        createdAt: true,
        updatedAt: true,
        // Explicitly exclude password
      },
    });

    if (!user) {
      throw new UnauthorizedError('User not found');
    }

    return successResponse(user);
  } catch (error) {
    return handleAPIError(error);
  }
}

/**
 * PATCH /api/v1/users/me
 *
 * Updates the current user's profile.
 * Only name and email can be updated via this endpoint.
 *
 * Validates:
 * - Request body matches updateUserSchema
 * - Email is unique (if being changed)
 *
 * @param request - Request with JSON body { name?, email? }
 * @returns Updated user profile
 * @throws UnauthorizedError if not authenticated
 * @throws ValidationError if invalid data
 */
export async function PATCH(request: NextRequest) {
  try {
    // Authenticate
    const requestHeaders = await headers();
    const session = await auth.api.getSession({ headers: requestHeaders });

    if (!session) {
      throw new UnauthorizedError();
    }

    // Validate request body
    const body = await validateRequestBody(request, updateUserSchema);

    // Check email uniqueness if changing email
    if (body.email) {
      const existingUser = await prisma.user.findUnique({
        where: { email: body.email },
      });

      if (existingUser && existingUser.id !== session.user.id) {
        return errorResponse('Email already in use', {
          code: ErrorCodes.EMAIL_TAKEN,
          status: 400,
        });
      }
    }

    // Update user
    const updatedUser = await prisma.user.update({
      where: { id: session.user.id },
      data: body,
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        updatedAt: true,
      },
    });

    return successResponse(updatedUser);
  } catch (error) {
    return handleAPIError(error);
  }
}
