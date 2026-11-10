/**
 * Decline an invitation (#1199, t-1006)
 *
 * POST /api/v1/invitations/decline — `{ token, email }`
 *
 * Public and token-gated, like `GET /api/v1/invitations/metadata`: the
 * emailed link is the whole authority, so whoever received it can turn it
 * down without an account, or without signing in to one. Deletes the
 * invitation this token redeems and nothing else; the address's invitations
 * into other orgs stay. 404 when there is no such invitation.
 *
 * The token is the same secret accepting takes, so the same per-IP cap
 * applies against guessing.
 */

import { NextRequest } from 'next/server';
import { handleAPIError } from '@/lib/api/errors';
import { successResponse } from '@/lib/api/responses';
import { validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { invitationLinkSchema } from '@/lib/validations/user';
import { declineInvitation } from '@/lib/tenancy/accept-invitation';
import { acceptInviteLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';

export async function POST(request: NextRequest): Promise<Response> {
  const log = await getRouteLogger(request);
  try {
    const clientIP = getClientIP(request);
    const rateLimitResult = acceptInviteLimiter.check(clientIP);
    if (!rateLimitResult.success) {
      log.warn('Decline invite rate limit exceeded', { ip: clientIP });
      return createRateLimitResponse(rateLimitResult);
    }

    const { token, email } = await validateRequestBody(request, invitationLinkSchema);
    await declineInvitation(email, token);

    log.info('Invitation declined', { email });
    return successResponse({ message: 'Invitation declined' });
  } catch (error) {
    log.error('Failed to decline invitation', error);
    return handleAPIError(error);
  }
}
