/**
 * Feature Flag by ID Endpoints (Phase 4.4)
 *
 * GET /api/v1/admin/feature-flags/:id - Get a feature flag
 * PATCH /api/v1/admin/feature-flags/:id - Update a feature flag
 * DELETE /api/v1/admin/feature-flags/:id - Delete a feature flag
 *
 * Authentication: Required (Admin role only)
 */

import { NextRequest } from 'next/server';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { UnauthorizedError, ForbiddenError, NotFoundError, handleAPIError } from '@/lib/api/errors';
import { validateQueryParams, validateRequestBody } from '@/lib/api/validation';
import { featureFlagIdSchema, updateFeatureFlagSchema } from '@/lib/validations/admin';
import { updateFlag, deleteFlag } from '@/lib/feature-flags';
import { logger } from '@/lib/logging';

/**
 * GET /api/v1/admin/feature-flags/:id
 *
 * Returns a specific feature flag.
 *
 * @param params - Route parameters containing flag ID
 * @returns Feature flag
 * @throws UnauthorizedError if not authenticated
 * @throws ForbiddenError if not admin
 * @throws NotFoundError if flag doesn't exist
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    // Await params (Next.js 16 requirement)
    const { id: flagId } = await params;

    // Validate flag ID parameter
    const { id } = validateQueryParams(new URLSearchParams({ id: flagId }), featureFlagIdSchema);

    // Authenticate and check role
    const requestHeaders = await headers();
    const session = await auth.api.getSession({ headers: requestHeaders });

    if (!session) {
      throw new UnauthorizedError();
    }

    if (session.user.role !== 'ADMIN') {
      throw new ForbiddenError('Admin access required');
    }

    // Fetch flag from database
    const flag = await prisma.featureFlag.findUnique({
      where: { id },
    });

    if (!flag) {
      throw new NotFoundError('Feature flag not found');
    }

    return successResponse(flag);
  } catch (error) {
    return handleAPIError(error);
  }
}

/**
 * PATCH /api/v1/admin/feature-flags/:id
 *
 * Updates a feature flag.
 *
 * @param request - Request with update data
 * @param params - Route parameters containing flag ID
 * @returns Updated feature flag
 * @throws UnauthorizedError if not authenticated
 * @throws ForbiddenError if not admin
 * @throws NotFoundError if flag doesn't exist
 */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    // Await params (Next.js 16 requirement)
    const { id: flagId } = await params;

    // Validate flag ID parameter
    const { id } = validateQueryParams(new URLSearchParams({ id: flagId }), featureFlagIdSchema);

    // Authenticate and check role
    const requestHeaders = await headers();
    const session = await auth.api.getSession({ headers: requestHeaders });

    if (!session) {
      throw new UnauthorizedError();
    }

    if (session.user.role !== 'ADMIN') {
      throw new ForbiddenError('Admin access required');
    }

    // Check if flag exists
    const existingFlag = await prisma.featureFlag.findUnique({
      where: { id },
    });

    if (!existingFlag) {
      throw new NotFoundError('Feature flag not found');
    }

    // Validate request body
    const body = await validateRequestBody(request, updateFeatureFlagSchema);

    // Update the flag
    const flag = await updateFlag(id, {
      description: body.description,
      enabled: body.enabled,
      metadata: body.metadata,
    });

    logger.info('Feature flag updated', {
      flagId: id,
      name: flag.name,
      adminId: session.user.id,
      changes: body,
    });

    return successResponse(flag);
  } catch (error) {
    return handleAPIError(error);
  }
}

/**
 * DELETE /api/v1/admin/feature-flags/:id
 *
 * Deletes a feature flag.
 *
 * @param params - Route parameters containing flag ID
 * @returns Success response
 * @throws UnauthorizedError if not authenticated
 * @throws ForbiddenError if not admin
 * @throws NotFoundError if flag doesn't exist
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // Await params (Next.js 16 requirement)
    const { id: flagId } = await params;

    // Validate flag ID parameter
    const { id } = validateQueryParams(new URLSearchParams({ id: flagId }), featureFlagIdSchema);

    // Authenticate and check role
    const requestHeaders = await headers();
    const session = await auth.api.getSession({ headers: requestHeaders });

    if (!session) {
      throw new UnauthorizedError();
    }

    if (session.user.role !== 'ADMIN') {
      throw new ForbiddenError('Admin access required');
    }

    // Check if flag exists
    const existingFlag = await prisma.featureFlag.findUnique({
      where: { id },
    });

    if (!existingFlag) {
      throw new NotFoundError('Feature flag not found');
    }

    // Delete the flag
    await deleteFlag(id);

    logger.info('Feature flag deleted', {
      flagId: id,
      name: existingFlag.name,
      adminId: session.user.id,
    });

    return successResponse({ id, deleted: true });
  } catch (error) {
    return handleAPIError(error);
  }
}
