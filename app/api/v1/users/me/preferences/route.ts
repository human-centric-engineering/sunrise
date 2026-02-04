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

import { type Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { UnauthorizedError } from '@/lib/api/errors';
import { validateRequestBody } from '@/lib/api/validation';
import { updatePreferencesSchema, userPreferencesSchema } from '@/lib/validations/user';
import { withAuth } from '@/lib/auth/guards';
import { DEFAULT_USER_PREFERENCES } from '@/lib/validations/user';
import type { UserPreferences } from '@/types';

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

  // Save updated preferences.
  // The JSON round-trip converts our validated interface into a plain object
  // whose type (`{ email: { marketing: boolean; ... } }`) satisfies Prisma's
  // InputJsonObject without needing a cast on the interface itself.
  const preferencesForDb = toJsonValue(updatedPreferences);
  await prisma.user.update({
    where: { id: session.user.id },
    data: {
      preferences: preferencesForDb,
    },
  });

  return successResponse(updatedPreferences);
});

/**
 * Parse preferences from database JSON field using Zod validation.
 *
 * Returns validated preferences or defaults if the stored data doesn't
 * match the expected shape (e.g., null, legacy format, or corrupt data).
 */
function parsePreferences(dbPreferences: unknown): UserPreferences {
  const result = userPreferencesSchema.safeParse(dbPreferences);
  if (result.success) {
    // Ensure securityAlerts is always true regardless of stored value
    return { ...result.data, email: { ...result.data.email, securityAlerts: true } };
  }
  return DEFAULT_USER_PREFERENCES;
}

/**
 * Convert a Zod-validated value to a JSON-serializable form that satisfies
 * Prisma's InputJsonValue type.
 *
 * TypeScript interfaces lack the index signature that Prisma's InputJsonObject
 * requires (`{ readonly [Key in string]?: InputJsonValue | null }`). A JSON
 * round-trip produces a structurally identical plain object whose inferred type
 * _does_ satisfy InputJsonValue, eliminating the need for a type assertion.
 */
function toJsonValue(value: UserPreferences): Prisma.InputJsonValue {
  // JSON.parse returns `any`; the runtime value is a plain JSON object
  // validated by our Zod schema above.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  return JSON.parse(JSON.stringify(value));
}
