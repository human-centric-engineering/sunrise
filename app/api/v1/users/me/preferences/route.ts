/**
 * User Preferences Endpoint
 *
 * GET /api/v1/users/me/preferences - Get current user's email preferences
 * PATCH /api/v1/users/me/preferences - Update current user's email preferences
 *
 * Authentication: Required (session-based via better-auth)
 *
 * Phase 3.2: User Management
 */

import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { UnauthorizedError } from '@/lib/api/errors';
import { validateRequestBody } from '@/lib/api/validation';
import { updatePreferencesSchema } from '@/lib/validations/user';
import { withAuth } from '@/lib/auth/guards';
import { DEFAULT_USER_PREFERENCES, type UserPreferences } from '@/types';

/**
 * GET /api/v1/users/me/preferences
 *
 * Returns the current user's email preferences.
 * If preferences are not set, returns default preferences.
 *
 * @returns User preferences object
 * @throws UnauthorizedError if not authenticated
 */
export const GET = withAuth(async (_request, session) => {
  // Fetch user preferences
  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: {
      preferences: true,
    },
  });

  if (!user) {
    throw new UnauthorizedError('User not found');
  }

  // Parse preferences or return defaults
  const preferences = parsePreferences(user.preferences);

  return successResponse(preferences);
});

/**
 * PATCH /api/v1/users/me/preferences
 *
 * Updates the current user's email preferences.
 * Supports partial updates - only provided fields will be updated.
 * Security alerts cannot be disabled (always true).
 *
 * @param request - Request with JSON body { email?: { marketing?, productUpdates?, securityAlerts? } }
 * @returns Updated preferences object
 * @throws UnauthorizedError if not authenticated
 * @throws ValidationError if invalid data
 */
export const PATCH = withAuth(async (request, session) => {
  // Validate request body
  const body = await validateRequestBody(request, updatePreferencesSchema);

  // Fetch current preferences
  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: {
      preferences: true,
    },
  });

  if (!user) {
    throw new UnauthorizedError('User not found');
  }

  // Parse current preferences
  const currentPreferences = parsePreferences(user.preferences);

  // Merge with updates (ensure securityAlerts stays true)
  const updatedPreferences: UserPreferences = {
    email: {
      ...currentPreferences.email,
      ...(body.email || {}),
      securityAlerts: true, // Cannot be disabled
    },
  };

  // Save updated preferences (cast to Prisma JSON type)
  await prisma.user.update({
    where: { id: session.user.id },
    data: {
      preferences: updatedPreferences as unknown as Prisma.InputJsonValue,
    },
  });

  return successResponse(updatedPreferences);
});

/**
 * Parse preferences from database JSON field
 *
 * Handles null/undefined preferences and merges with defaults
 */
function parsePreferences(dbPreferences: unknown): UserPreferences {
  if (!dbPreferences || typeof dbPreferences !== 'object') {
    return DEFAULT_USER_PREFERENCES;
  }

  const prefs = dbPreferences as Record<string, unknown>;

  return {
    email: {
      marketing:
        typeof (prefs.email as Record<string, unknown>)?.marketing === 'boolean'
          ? ((prefs.email as Record<string, unknown>).marketing as boolean)
          : DEFAULT_USER_PREFERENCES.email.marketing,
      productUpdates:
        typeof (prefs.email as Record<string, unknown>)?.productUpdates === 'boolean'
          ? ((prefs.email as Record<string, unknown>).productUpdates as boolean)
          : DEFAULT_USER_PREFERENCES.email.productUpdates,
      securityAlerts: true, // Always true
    },
  };
}
