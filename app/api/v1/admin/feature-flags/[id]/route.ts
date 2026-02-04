/**
 * Feature Flag by ID Endpoints (Phase 4.4)
 *
 * GET /api/v1/admin/feature-flags/:id - Get a feature flag
 * PATCH /api/v1/admin/feature-flags/:id - Update a feature flag
 * DELETE /api/v1/admin/feature-flags/:id - Delete a feature flag
 *
 * Authentication: Required (Admin role only)
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { NotFoundError } from '@/lib/api/errors';
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
export const GET = withAdminAuth<{ id: string }>(async (_request, _session, { params }) => {
  // Await params (Next.js 16 requirement)
  const { id: flagId } = await params;

  // Validate flag ID parameter
  const { id } = validateQueryParams(new URLSearchParams({ id: flagId }), featureFlagIdSchema);

  // Fetch flag from database
  const flag = await prisma.featureFlag.findUnique({
    where: { id },
  });

  if (!flag) {
    throw new NotFoundError('Feature flag not found');
  }

  return successResponse(flag);
});

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
export const PATCH = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  // Await params (Next.js 16 requirement)
  const { id: flagId } = await params;

  // Validate flag ID parameter
  const { id } = validateQueryParams(new URLSearchParams({ id: flagId }), featureFlagIdSchema);

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
});

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
export const DELETE = withAdminAuth<{ id: string }>(async (_request, session, { params }) => {
  // Await params (Next.js 16 requirement)
  const { id: flagId } = await params;

  // Validate flag ID parameter
  const { id } = validateQueryParams(new URLSearchParams({ id: flagId }), featureFlagIdSchema);

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
});
