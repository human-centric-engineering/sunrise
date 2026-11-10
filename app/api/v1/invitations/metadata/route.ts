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
 * 3. Return metadata (name, role, the org it joins, and whether the address
 *    already has an account) or specific error code
 *
 * `accountExists` tells the accept page which way the invitation is taken:
 * a new account sets a password (`POST /api/auth/accept-invite`), an
 * existing one signs in and accepts (`POST /api/v1/invitations/accept`,
 * #1199). It is answered only to a caller holding a valid token, who was
 * sent the invitation email that already says so. `newAccountOnly` marks a
 * platform invitation, which only creates an account: an existing account
 * cannot redeem it.
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
import { getInvitationMetadata, isPlatformInvitation } from '@/lib/utils/invitation-token';
import { getRouteLogger } from '@/lib/api/context';
import { prisma } from '@/lib/db/client';
import { emailSchema } from '@/lib/validations/auth';

/**
 * Query parameter validation schema
 */
const querySchema = z.object({
  token: z.string().min(1, 'Token is required'),
  // The shared schema (trimmed, lowercased), as every invitation is stored
  // and as accept and decline read it, so one link answers the same on all.
  email: emailSchema,
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
export async function GET(request: NextRequest): Promise<Response> {
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
    const [org, account] = await Promise.all([
      result.metadata.orgId
        ? prisma.org.findUnique({ where: { id: result.metadata.orgId }, select: { name: true } })
        : null,
      prisma.user.findUnique({
        where: { email: validated.email },
        select: { emailVerified: true },
      }),
    ]);
    return successResponse({
      name: result.metadata.name,
      role: result.metadata.role,
      orgName: org?.name ?? null,
      accountExists: account !== null,
      // Accepting as an existing account needs a verified address. An
      // unverified one is told to verify on sign-in first (the sign-in page
      // offers the email), rather than finding out at the last step.
      accountVerified: account?.emailVerified ?? false,
      // A platform invitation (a platform role, or the install org) can only
      // create an account. With one already there, the page says so instead
      // of offering a sign-in that the accept route would refuse.
      newAccountOnly: isPlatformInvitation(result.metadata),
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
