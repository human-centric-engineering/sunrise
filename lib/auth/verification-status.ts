/**
 * Email Verification Status Utility
 *
 * Determines the current verification state of a user's email.
 * Used to provide contextual messaging on the dashboard.
 *
 * Status Types:
 * - 'verified': Email has been verified
 * - 'pending': Verification email was sent, awaiting user action
 * - 'not_sent': Email is unverified and no verification email has been sent
 *   (e.g., when REQUIRE_EMAIL_VERIFICATION=false in development)
 */

import { prisma } from '@/lib/db/client';

/**
 * Email verification status states
 */
export type VerificationStatus = 'verified' | 'pending' | 'not_sent';

/**
 * Get the verification status for a user's email
 *
 * @param email - The user's email address
 * @param emailVerified - Whether the email is already verified
 * @returns The verification status
 *
 * @example
 * ```typescript
 * const status = await getVerificationStatus('user@example.com', false);
 * // status: 'pending' | 'not_sent'
 * ```
 */
export async function getVerificationStatus(
  email: string,
  emailVerified: boolean
): Promise<VerificationStatus> {
  // If already verified, return immediately
  if (emailVerified) {
    return 'verified';
  }

  // Check if a verification token exists for this email
  // better-auth stores email verification tokens with identifier format: email
  const verificationToken = await prisma.verification.findFirst({
    where: {
      identifier: email,
      expiresAt: { gt: new Date() }, // Only consider non-expired tokens
    },
    select: { id: true },
  });

  // If a token exists, verification email was sent
  if (verificationToken) {
    return 'pending';
  }

  // No token and not verified = email never sent
  return 'not_sent';
}
