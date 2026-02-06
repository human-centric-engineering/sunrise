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
 * 2. Validate token and get metadata in one operation
 * 3. Return metadata (name, role) or specific error code
 *
 * Response Error Codes:
 *   - VALIDATION_ERROR: Invalid query parameters or invalid token
 *   - INVITATION_EXPIRED: Token exists but has expired
 *   - NOT_FOUND: No invitation found for this email
 *
 * Security:
 * - Token must be valid and not expired
 * - Returns specific error codes to allow UI to show appropriate message
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { successResponse, errorResponse } from '@/lib/api/responses';
import { handleAPIError, ErrorCodes } from '@/lib/api/errors';
import { getInvitationMetadata } from '@/lib/utils/invitation-token';
import { getRouteLogger } from '@/lib/api/context';

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
  const log = await getRouteLogger(request);
  try {
    // 1. Validate query parameters
    const url = new URL(request.url);
    const token = url.searchParams.get('token');
    const email = url.searchParams.get('email');

    const validated = querySchema.parse({ token, email });

    log.info('Invitation metadata requested', { email: validated.email });

    // 2. Validate token and get metadata in one operation
    const result = await getInvitationMetadata(validated.email, validated.token);

    if (!result.valid) {
      // Return specific error code based on failure reason
      switch (result.reason) {
        case 'expired':
          log.warn('Expired invitation for metadata request', { email: validated.email });
          return errorResponse('This invitation has expired', {
            code: ErrorCodes.INVITATION_EXPIRED,
            status: 410, // Gone - resource existed but is no longer available
          });

        case 'invalid_token':
          log.warn('Invalid token for metadata request', { email: validated.email });
          return errorResponse('Invalid invitation token', {
            code: ErrorCodes.VALIDATION_ERROR,
            status: 400,
          });

        case 'not_found':
        default:
          log.warn('Invitation not found for metadata request', { email: validated.email });
          return errorResponse('Invitation not found', {
            code: ErrorCodes.NOT_FOUND,
            status: 404,
          });
      }
    }

    log.info('Invitation metadata retrieved', { email: validated.email });

    // 3. Return metadata
    return successResponse({
      name: result.metadata.name,
      role: result.metadata.role,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      log.warn('Invalid query parameters for invitation metadata');
      return errorResponse('Invalid query parameters', {
        code: ErrorCodes.VALIDATION_ERROR,
        status: 400,
      });
    }
    log.error('Error retrieving invitation metadata', error);
    return handleAPIError(error);
  }
}
