/**
 * User by ID Endpoints
 *
 * GET /api/v1/users/:id - Get user by ID (Admin or own profile)
 * PATCH /api/v1/users/:id - Update user (Admin only)
 * DELETE /api/v1/users/:id - Delete user (Admin only)
 *
 * Authentication: Required
 * Authorization:
 *   - GET: Admin can view any user, users can view their own profile
 *   - PATCH: Admin only (can update role, name, emailVerified)
 *   - DELETE: Admin only, cannot delete self
 */

import { prisma } from '@/lib/db/client';
import { successResponse, errorResponse } from '@/lib/api/responses';
import { ForbiddenError, NotFoundError, ValidationError } from '@/lib/api/errors';
import { withAuth, withAdminAuth } from '@/lib/auth/guards';
import { validateQueryParams, validateRequestBody } from '@/lib/api/validation';
import { userIdSchema } from '@/lib/validations/user';
import { adminUserUpdateSchema } from '@/lib/validations/admin';
import { getRouteLogger } from '@/lib/api/context';

/**
 * GET /api/v1/users/:id
 *
 * Returns a specific user's profile.
 * Admin users can view any profile.
 * Regular users can only view their own profile.
 *
 * @param params - Route parameters containing user ID
 * @returns User profile
 * @throws UnauthorizedError if not authenticated
 * @throws ForbiddenError if non-admin tries to view another user
 * @throws NotFoundError if user doesn't exist
 * @throws ValidationError if ID format is invalid
 */
export const GET = withAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);

  // Await params (Next.js 16 requirement)
  const { id: userId } = await params;

  // Validate user ID parameter
  const { id } = validateQueryParams(new URLSearchParams({ id: userId }), userIdSchema);

  log.info('Fetching user by ID', { targetUserId: id });

  // Authorization: Admin can view any user, users can view own profile
  if (session.user.id !== id && session.user.role !== 'ADMIN') {
    throw new ForbiddenError();
  }

  // Fetch user from database
  const user = await prisma.user.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      emailVerified: true,
      image: true,
      bio: true,
      phone: true,
      timezone: true,
      location: true,
      createdAt: true,
      updatedAt: true,
      // Exclude password
    },
  });

  if (!user) {
    throw new NotFoundError('User not found');
  }

  return successResponse(user);
});

/**
 * PATCH /api/v1/users/:id
 *
 * Updates a user's information.
 * Admin only endpoint.
 * Can update: name, role, emailVerified
 *
 * @param request - Request with update body
 * @param params - Route parameters containing user ID
 * @returns Updated user profile
 * @throws UnauthorizedError if not authenticated
 * @throws ForbiddenError if not admin
 * @throws NotFoundError if user doesn't exist
 * @throws ValidationError if body is invalid
 */
export const PATCH = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);

  // Await params (Next.js 16 requirement)
  const { id: userId } = await params;

  // Validate user ID parameter
  const { id } = validateQueryParams(new URLSearchParams({ id: userId }), userIdSchema);

  log.info('Updating user by ID', { targetUserId: id });

  // Validate request body
  const body = await validateRequestBody(request, adminUserUpdateSchema);

  // Check if at least one field is provided
  if (Object.keys(body).length === 0) {
    throw new ValidationError('At least one field must be provided');
  }

  // Check if user exists
  const existingUser = await prisma.user.findUnique({
    where: { id },
  });

  if (!existingUser) {
    throw new NotFoundError('User not found');
  }

  // Prevent admin from demoting themselves
  if (session.user.id === id && body.role && body.role !== 'ADMIN') {
    return errorResponse('Cannot change your own role', {
      status: 400,
      code: 'SELF_ROLE_CHANGE',
    });
  }

  // Update user
  const updatedUser = await prisma.user.update({
    where: { id },
    data: {
      ...(body.name && { name: body.name }),
      ...(body.role && { role: body.role }),
      ...(body.emailVerified !== undefined && { emailVerified: body.emailVerified }),
    },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      emailVerified: true,
      image: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  log.info('User updated by admin', {
    userId: id,
    adminId: session.user.id,
    changes: body,
  });

  return successResponse(updatedUser);
});

/**
 * DELETE /api/v1/users/:id
 *
 * Deletes a user account.
 * Only admins can delete users.
 * Admins cannot delete their own account.
 *
 * Cascade behavior:
 * - Avatar file is deleted from storage (if one exists)
 * - Related accounts (OAuth) are deleted automatically via Prisma schema
 * - Related sessions are deleted automatically via Prisma schema
 *
 * @param params - Route parameters containing user ID
 * @returns Success response with deleted user ID
 * @throws UnauthorizedError if not authenticated
 * @throws ForbiddenError if not admin or trying to delete self
 * @throws NotFoundError if user doesn't exist
 * @throws ValidationError if ID format is invalid
 */
export const DELETE = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);

  // Await params (Next.js 16 requirement)
  const { id: userId } = await params;

  // Validate user ID parameter
  const { id } = validateQueryParams(new URLSearchParams({ id: userId }), userIdSchema);

  log.info('Deleting user by ID', { targetUserId: id });

  // Prevent self-deletion
  if (session.user.id === id) {
    return errorResponse('Cannot delete your own account', {
      status: 400,
    });
  }

  // Check if user exists
  const user = await prisma.user.findUnique({
    where: { id },
  });

  if (!user) {
    throw new NotFoundError('User not found');
  }

  // Prevent deleting other admin accounts
  if (user.role === 'ADMIN') {
    return errorResponse('Cannot delete an admin account. Demote the user first.', {
      status: 400,
    });
  }

  // Clean up stored avatar files (no-op if nothing exists)
  const { deleteByPrefix, isStorageEnabled } = await import('@/lib/storage/upload');
  if (isStorageEnabled()) {
    await deleteByPrefix(`avatars/${id}/`);
  }

  // Delete user (cascade deletes accounts and sessions via Prisma schema)
  await prisma.user.delete({
    where: { id },
  });

  log.info('User deleted by admin', { deletedUserId: id, adminId: session.user.id });

  return successResponse({ id, deleted: true });
});
