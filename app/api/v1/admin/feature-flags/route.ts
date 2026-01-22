/**
 * Feature Flags Endpoints (Phase 4.4)
 *
 * GET /api/v1/admin/feature-flags - List all feature flags
 * POST /api/v1/admin/feature-flags - Create a new feature flag
 *
 * Authentication: Required (Admin role only)
 */

import { NextRequest } from 'next/server';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth/config';
import { successResponse } from '@/lib/api/responses';
import { UnauthorizedError, ForbiddenError, ConflictError, handleAPIError } from '@/lib/api/errors';
import { validateRequestBody } from '@/lib/api/validation';
import { createFeatureFlagSchema } from '@/lib/validations/admin';
import { getAllFlags, createFlag, getFlag } from '@/lib/feature-flags';
import { logger } from '@/lib/logging';

/**
 * GET /api/v1/admin/feature-flags
 *
 * Returns all feature flags.
 *
 * @returns List of feature flags
 * @throws UnauthorizedError if not authenticated
 * @throws ForbiddenError if not admin
 */
export async function GET() {
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

    const flags = await getAllFlags();

    return successResponse(flags);
  } catch (error) {
    return handleAPIError(error);
  }
}

/**
 * POST /api/v1/admin/feature-flags
 *
 * Creates a new feature flag.
 *
 * @param request - Request with flag data
 * @returns Created feature flag
 * @throws UnauthorizedError if not authenticated
 * @throws ForbiddenError if not admin
 * @throws ConflictError if flag name already exists
 */
export async function POST(request: NextRequest) {
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

    // Validate request body
    const body = await validateRequestBody(request, createFeatureFlagSchema);

    // Check if flag with same name already exists
    const existingFlag = await getFlag(body.name);
    if (existingFlag) {
      throw new ConflictError(`Feature flag '${body.name}' already exists`);
    }

    // Create the flag
    const flag = await createFlag({
      name: body.name,
      description: body.description,
      enabled: body.enabled,
      metadata: body.metadata,
      createdBy: session.user.id,
    });

    logger.info('Feature flag created', {
      flagId: flag.id,
      name: flag.name,
      adminId: session.user.id,
    });

    return successResponse(flag, undefined, { status: 201 });
  } catch (error) {
    return handleAPIError(error);
  }
}
