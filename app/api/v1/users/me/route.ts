/**
 * Current User Endpoint
 *
 * GET /api/v1/users/me - Get current authenticated user's profile
 * PATCH /api/v1/users/me - Update current user's profile
 * DELETE /api/v1/users/me - Delete current user's account (Phase 3.2)
 *
 * Authentication: Required (session-based via better-auth)
 */

import { cookies } from 'next/headers';
import { prisma } from '@/lib/db/client';
import { successResponse, errorResponse } from '@/lib/api/responses';
import { UnauthorizedError, ErrorCodes } from '@/lib/api/errors';
import { validateRequestBody } from '@/lib/api/validation';
import { updateUserSchema, deleteAccountSchema } from '@/lib/validations/user';
import { withAuth } from '@/lib/auth/guards';
import { isRecord } from '@/lib/utils';
import { logger } from '@/lib/logging';
import { serverTrack } from '@/lib/analytics/server';
import { EVENTS } from '@/lib/analytics/events';

/**
 * GET /api/v1/users/me
 *
 * Returns the current authenticated user's profile.
 * Includes extended profile fields (bio, phone, timezone, location, preferences).
 * Password field is explicitly excluded from the response.
 *
 * @returns User profile with id, name, email, role, profile fields, etc.
 * @throws UnauthorizedError if not authenticated
 */
export const GET = withAuth(async (_request, session) => {
  // Fetch user from database with all profile fields
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
      // Extended profile fields (Phase 3.2)
      bio: true,
      phone: true,
      timezone: true,
      location: true,
      preferences: true,
      // Explicitly exclude password
    },
  });

  if (!user) {
    throw new UnauthorizedError('User not found');
  }

  return successResponse(user);
});

/**
 * PATCH /api/v1/users/me
 *
 * Updates the current user's profile.
 * Supports updating name, email, and extended profile fields (bio, phone, timezone, location).
 *
 * Validates:
 * - Request body matches updateUserSchema
 * - Email is unique (if being changed)
 *
 * @param request - Request with JSON body { name?, email?, bio?, phone?, timezone?, location? }
 * @returns Updated user profile
 * @throws UnauthorizedError if not authenticated
 * @throws ValidationError if invalid data
 */
export const PATCH = withAuth(async (request, session) => {
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

  // Update user with all provided fields
  const updatedUser = await prisma.user.update({
    where: { id: session.user.id },
    data: body,
    select: {
      id: true,
      name: true,
      email: true,
      emailVerified: true,
      image: true,
      role: true,
      createdAt: true,
      updatedAt: true,
      // Extended profile fields (Phase 3.2)
      bio: true,
      phone: true,
      timezone: true,
      location: true,
      preferences: true,
    },
  });

  return successResponse(updatedUser);
});

/**
 * DELETE /api/v1/users/me
 *
 * Permanently deletes the current user's account.
 * Requires confirmation by sending { confirmation: "DELETE" } in request body.
 * Deletes avatar from storage, cascades deletion to sessions and accounts.
 * Clears the session cookie after deletion.
 *
 * @param request - Request with JSON body { confirmation: "DELETE" }
 * @returns Success message confirming deletion
 * @throws UnauthorizedError if not authenticated
 * @throws ValidationError if confirmation is missing or incorrect
 */
export const DELETE = withAuth(async (request, session) => {
  try {
    // Validate confirmation (ensures user typed "DELETE")
    await validateRequestBody(request, deleteAccountSchema);

    // Log the deletion for audit purposes
    logger.info('User account deletion initiated', {
      userId: session.user.id,
      email: session.user.email,
    });

    // Clean up stored avatar files (no-op if nothing exists)
    const { deleteByPrefix, isStorageEnabled } = await import('@/lib/storage/upload');
    if (isStorageEnabled()) {
      await deleteByPrefix(`avatars/${session.user.id}/`);
    }

    // Delete user (cascades to sessions and accounts via Prisma schema)
    await prisma.user.delete({
      where: { id: session.user.id },
    });

    // Clear all better-auth cookies (session, cached session data, CSRF, OAuth state)
    const cookieStore = await cookies();
    cookieStore.delete('better-auth.session_token');
    cookieStore.delete('better-auth.session_data');
    cookieStore.delete('better-auth.csrf_token');
    cookieStore.delete('better-auth.state');
    // __Secure- cookies require the Secure attribute in the Set-Cookie header,
    // otherwise browsers silently reject the deletion. Use set() with maxAge: 0
    // instead of delete() to include the required attributes.
    const secureCookieOptions = { path: '/', secure: true, maxAge: 0 } as const;
    cookieStore.set('__Secure-better-auth.session_token', '', secureCookieOptions);
    cookieStore.set('__Secure-better-auth.session_data', '', secureCookieOptions);
    cookieStore.set('__Secure-better-auth.csrf_token', '', secureCookieOptions);
    cookieStore.set('__Secure-better-auth.state', '', secureCookieOptions);

    // Track account deletion server-side (bypasses ad blockers for critical events)
    await serverTrack({
      event: EVENTS.ACCOUNT_DELETED,
      userId: session.user.id,
    });

    logger.info('User account deleted successfully', {
      userId: session.user.id,
    });

    return successResponse({
      deleted: true,
      message: 'Account deleted successfully',
    });
  } catch (error) {
    logger.error('Failed to delete user account', error, {
      userId: isRecord(error) && typeof error.userId === 'string' ? error.userId : undefined,
    });
    throw error;
  }
});
