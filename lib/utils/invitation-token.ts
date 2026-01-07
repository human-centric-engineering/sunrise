/**
 * Invitation Token Utilities
 *
 * Phase 3.1, Step 4.1: Token generation and validation for user invitations.
 *
 * Functions:
 * - generateInvitationToken() - Generate and store secure invitation token
 * - validateInvitationToken() - Validate token and check expiration
 * - deleteInvitationToken() - Clean up used or expired tokens
 *
 * Security:
 * - Uses crypto.randomBytes for cryptographically secure tokens
 * - Stores hashed tokens (SHA-256) to prevent token theft from database
 * - 7-day expiration window for invitations
 * - Tokens are single-use (delete after validation)
 */

import { randomBytes, createHash } from 'crypto';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';

/**
 * Token Configuration
 */
const TOKEN_BYTE_LENGTH = 32; // 32 bytes = 64 hex characters
const TOKEN_EXPIRY_DAYS = 7; // 7 days until invitation expires
const IDENTIFIER_PREFIX = 'invitation:'; // Prefix for invitation identifiers

/**
 * Hash a token using SHA-256
 *
 * @param token - The plain text token to hash
 * @returns The hashed token as a hex string
 */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Generate a secure invitation token and store it in the database
 *
 * @param email - The email address to associate with the invitation
 * @returns The unhashed token string (to be sent in invitation email)
 *
 * @example
 * ```typescript
 * const token = await generateInvitationToken('user@example.com');
 * await sendInvitationEmail(email, token);
 * ```
 */
export async function generateInvitationToken(email: string): Promise<string> {
  try {
    // Generate cryptographically secure random token
    const token = randomBytes(TOKEN_BYTE_LENGTH).toString('hex');
    const hashedToken = hashToken(token);

    // Calculate expiration date (7 days from now)
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + TOKEN_EXPIRY_DAYS);

    // Store hashed token in database
    await prisma.verification.create({
      data: {
        identifier: `${IDENTIFIER_PREFIX}${email}`,
        value: hashedToken,
        expiresAt,
      },
    });

    logger.info('Invitation token generated', {
      email,
      expiresAt: expiresAt.toISOString(),
    });

    // Return unhashed token (this is what gets sent in the email)
    return token;
  } catch (error) {
    logger.error('Failed to generate invitation token', error, { email });
    throw new Error('Failed to generate invitation token');
  }
}

/**
 * Validate an invitation token
 *
 * Checks if:
 * - Token exists for the given email
 * - Token hash matches the stored hash
 * - Token has not expired
 *
 * @param email - The email address to validate the token for
 * @param token - The plain text token to validate
 * @returns True if token is valid, false otherwise
 *
 * @example
 * ```typescript
 * const isValid = await validateInvitationToken('user@example.com', token);
 * if (isValid) {
 *   await createUser(email);
 *   await deleteInvitationToken(email);
 * }
 * ```
 */
export async function validateInvitationToken(email: string, token: string): Promise<boolean> {
  try {
    const hashedToken = hashToken(token);

    // Find the verification record for this email
    const verification = await prisma.verification.findFirst({
      where: {
        identifier: `${IDENTIFIER_PREFIX}${email}`,
      },
    });

    // Token not found
    if (!verification) {
      logger.warn('Invitation token not found', { email });
      return false;
    }

    // Check if token has expired (inclusive check - token expiring now is invalid)
    if (verification.expiresAt <= new Date()) {
      logger.warn('Invitation token expired', {
        email,
        expiredAt: verification.expiresAt.toISOString(),
      });
      return false;
    }

    // Compare hashed tokens
    const isValid = verification.value === hashedToken;

    if (!isValid) {
      logger.warn('Invitation token mismatch', { email });
    } else {
      logger.info('Invitation token validated', { email });
    }

    return isValid;
  } catch (error) {
    logger.error('Failed to validate invitation token', error, { email });
    return false;
  }
}

/**
 * Delete all invitation tokens for a given email
 *
 * Should be called after:
 * - Successful token validation and user creation
 * - Manual token revocation
 * - Cleanup of expired tokens
 *
 * @param email - The email address to delete tokens for
 *
 * @example
 * ```typescript
 * // After successful signup
 * await createUser(email);
 * await deleteInvitationToken(email);
 * ```
 */
export async function deleteInvitationToken(email: string): Promise<void> {
  try {
    const result = await prisma.verification.deleteMany({
      where: {
        identifier: `${IDENTIFIER_PREFIX}${email}`,
      },
    });

    logger.info('Invitation tokens deleted', {
      email,
      count: result.count,
    });
  } catch (error) {
    logger.error('Failed to delete invitation token', error, { email });
    throw new Error('Failed to delete invitation token');
  }
}
