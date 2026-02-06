/**
 * Send Verification Email Endpoint
 *
 * POST /api/auth/send-verification-email
 *
 * Allows users to request a verification email for their account.
 * This is useful when:
 * - Email verification was disabled during signup (dev mode)
 * - User wants to verify their email for added security
 * - Previous verification email expired or was lost
 *
 * Security:
 * - Rate limited to 3 requests per 15 minutes per IP
 * - Always returns success (prevents email enumeration)
 * - Only sends email if user exists and is unverified
 */

import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db/client';
import { auth } from '@/lib/auth/config';
import { successResponse } from '@/lib/api/responses';
import { handleAPIError } from '@/lib/api/errors';
import { validateRequestBody } from '@/lib/api/validation';
import { sendVerificationEmailSchema } from '@/lib/validations/auth';
import {
  verificationEmailLimiter,
  createRateLimitResponse,
  getRateLimitHeaders,
} from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { getRouteLogger } from '@/lib/api/context';

/**
 * POST /api/auth/send-verification-email
 *
 * Sends a verification email to the specified address.
 *
 * @example
 * POST /api/auth/send-verification-email
 * {
 *   "email": "user@example.com"
 * }
 *
 * @returns Success message (always returns success to prevent enumeration)
 * @throws RateLimitError if too many requests
 */
export async function POST(request: NextRequest) {
  const log = await getRouteLogger(request);

  try {
    // 1. Check rate limit
    const clientIP = getClientIP(request);
    const rateLimitResult = verificationEmailLimiter.check(clientIP);

    if (!rateLimitResult.success) {
      log.warn('Verification email rate limit exceeded', {
        ip: clientIP,
        remaining: rateLimitResult.remaining,
        reset: rateLimitResult.reset,
      });
      return createRateLimitResponse(rateLimitResult);
    }

    // 2. Validate request body
    const body = await validateRequestBody(request, sendVerificationEmailSchema);
    const { email } = body;

    // Always return success response (prevents email enumeration)
    const successResponseMessage = {
      message: 'If an account exists with this email, a verification email has been sent.',
    };

    // 3. Check if user exists and is unverified
    const user = await prisma.user.findUnique({
      where: { email },
      select: { id: true, email: true, emailVerified: true, name: true },
    });

    if (!user) {
      log.info('Verification email requested for non-existent user', { email });
      return successResponse(successResponseMessage, undefined, {
        headers: getRateLimitHeaders(rateLimitResult),
      });
    }

    if (user.emailVerified) {
      log.info('Verification email requested for already verified user', {
        userId: user.id,
        email,
      });
      return successResponse(successResponseMessage, undefined, {
        headers: getRateLimitHeaders(rateLimitResult),
      });
    }

    // 4. Use better-auth's API to send verification email
    // This creates a verification token and triggers our configured sendVerificationEmail callback
    log.info('Sending verification email', { userId: user.id, email });

    try {
      await auth.api.sendVerificationEmail({
        body: { email },
      });
      log.info('Verification email sent successfully', { userId: user.id, email });
    } catch (sendError) {
      // Log the error but still return success (prevents enumeration)
      log.error('better-auth sendVerificationEmail failed', sendError, {
        email,
        userId: user.id,
      });
    }

    return successResponse(successResponseMessage, undefined, {
      headers: getRateLimitHeaders(rateLimitResult),
    });
  } catch (error) {
    log.error('Failed to process verification email request', error);
    return handleAPIError(error);
  }
}
