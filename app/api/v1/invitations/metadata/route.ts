/**
 * Get Invitation Metadata Endpoint
 *
 * GET /api/v1/invitations/metadata - Get invitation metadata for a given token and email
 *
 * Authentication: Not required (public endpoint, validated via token)
 *
 * Query Parameters:
 *   - token: Invitation token (required)
 *   - email: Email address (required)
 *
 * Flow:
 * 1. Validate query parameters
 * 2. Validate invitation token (checks expiration and email match)
 * 3. Fetch metadata from Verification table
 * 4. Return metadata (name, role)
 *
 * Security:
 * - Token must be valid and not expired
 * - Returns 400 for invalid/expired tokens
 * - Returns 404 if invitation not found
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { successResponse, errorResponse } from '@/lib/api/responses';
import { handleAPIError, ErrorCodes } from '@/lib/api/errors';
import { validateInvitationToken } from '@/lib/utils/invitation-token';
import { logger } from '@/lib/logging';

/**
 * Query parameter validation schema
 */
const querySchema = z.object({
  token: z.string().min(1, 'Token is required'),
  email: z.string().email('Valid email is required'),
});

/**
 * GET /api/v1/invitations/metadata
 *
 * Retrieves invitation metadata for display in the acceptance form.
 * Allows UI to pre-fill invitation details before user accepts.
 *
 * @example
 * GET /api/v1/invitations/metadata?token=abc123...&email=user@example.com
 *
 * @returns Invitation metadata (name, role)
 * @throws ValidationError if invalid query parameters
 * @throws NotFoundError if invitation not found
 */
export async function GET(request: NextRequest) {
  try {
    // 1. Validate query parameters
    const url = new URL(request.url);
    const token = url.searchParams.get('token');
    const email = url.searchParams.get('email');

    const validated = querySchema.parse({ token, email });

    logger.info('Invitation metadata requested', { email: validated.email });

    // 2. Validate token
    const isValid = await validateInvitationToken(validated.email, validated.token);
    if (!isValid) {
      logger.warn('Invalid invitation token for metadata request', { email: validated.email });
      return errorResponse('Invalid or expired invitation token', {
        code: ErrorCodes.VALIDATION_ERROR,
        status: 400,
      });
    }

    // 3. Get metadata
    const invitation = await prisma.verification.findFirst({
      where: { identifier: `invitation:${validated.email}` },
    });

    if (!invitation || !invitation.metadata) {
      logger.warn('Invitation not found', { email: validated.email });
      return errorResponse('Invitation not found', {
        code: ErrorCodes.NOT_FOUND,
        status: 404,
      });
    }

    const metadata = invitation.metadata as { name: string; role: string };

    logger.info('Invitation metadata retrieved', { email: validated.email });

    // 4. Return metadata
    return successResponse({
      name: metadata.name,
      role: metadata.role,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return errorResponse('Invalid query parameters', {
        code: ErrorCodes.VALIDATION_ERROR,
        status: 400,
      });
    }
    return handleAPIError(error);
  }
}
