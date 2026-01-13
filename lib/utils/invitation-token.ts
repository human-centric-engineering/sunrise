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
 * Invitation metadata structure
 */
export type InvitationMetadata = {
  name: string;
  role: string;
  invitedBy: string;
  invitedAt: string;
  [key: string]: string; // Index signature for Prisma JSON compatibility
};

/**
 * Generate a secure invitation token and store it in the database with metadata
 *
 * @param email - The email address to associate with the invitation
 * @param metadata - Invitation metadata (name, role, invitedBy, invitedAt)
 * @returns The unhashed token string (to be sent in invitation email)
 *
 * @example
 * ```typescript
 * const token = await generateInvitationToken('user@example.com', {
 *   name: 'John Doe',
 *   role: 'USER',
 *   invitedBy: 'admin-user-id',
 *   invitedAt: new Date().toISOString(),
 * });
 * await sendInvitationEmail(email, token);
 * ```
 */
export async function generateInvitationToken(
  email: string,
  metadata: InvitationMetadata
): Promise<string> {
  try {
    // Generate cryptographically secure random token
    const token = randomBytes(TOKEN_BYTE_LENGTH).toString('hex');
    const hashedToken = hashToken(token);

    // Calculate expiration date (7 days from now)
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + TOKEN_EXPIRY_DAYS);

    // Store hashed token in database with metadata
    await prisma.verification.create({
      data: {
        identifier: `${IDENTIFIER_PREFIX}${email}`,
        value: hashedToken,
        expiresAt,
        metadata: metadata,
      },
    });

    logger.info('Invitation token generated', {
      email,
      expiresAt: expiresAt.toISOString(),
      metadata,
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

    // Find the most recent non-expired verification record for this email
    const verification = await prisma.verification.findFirst({
      where: {
        identifier: `${IDENTIFIER_PREFIX}${email}`,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Token not found or all expired
    if (!verification) {
      logger.warn('Invitation token not found or expired', { email });
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

/**
 * Invitation record returned by getValidInvitation
 */
export type InvitationRecord = {
  email: string;
  metadata: InvitationMetadata;
  expiresAt: Date;
  createdAt: Date;
};

/**
 * Get a valid (non-expired) invitation for an email address
 *
 * Returns the most recent non-expired invitation if one exists.
 * Does NOT validate any token - just checks if an invitation exists.
 *
 * @param email - The email address to look up
 * @returns The invitation record if found and not expired, null otherwise
 *
 * @example
 * ```typescript
 * const invitation = await getValidInvitation('user@example.com');
 * if (invitation) {
 *   console.log(`Invitation expires: ${invitation.expiresAt}`);
 * }
 * ```
 */
export async function getValidInvitation(email: string): Promise<InvitationRecord | null> {
  try {
    const verification = await prisma.verification.findFirst({
      where: {
        identifier: `${IDENTIFIER_PREFIX}${email}`,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!verification) {
      return null;
    }

    return {
      email,
      metadata: verification.metadata as InvitationMetadata,
      expiresAt: verification.expiresAt,
      createdAt: verification.createdAt,
    };
  } catch (error) {
    logger.error('Failed to get valid invitation', error, { email });
    return null;
  }
}

/**
 * Update (regenerate) an invitation token for an email
 *
 * Deletes all existing invitation tokens for the email and creates a new one.
 * Use this for resending invitations - ensures the new token is valid.
 *
 * @param email - The email address to update the invitation for
 * @param metadata - Updated invitation metadata
 * @returns The new unhashed token string
 *
 * @example
 * ```typescript
 * // Resend invitation with new token
 * const newToken = await updateInvitationToken('user@example.com', {
 *   name: 'John Doe',
 *   role: 'USER',
 *   invitedBy: 'admin-id',
 *   invitedAt: new Date().toISOString(),
 * });
 * await sendInvitationEmail(email, newToken);
 * ```
 */
export async function updateInvitationToken(
  email: string,
  metadata: InvitationMetadata
): Promise<string> {
  // Delete all existing invitations for this email
  await deleteInvitationToken(email);

  // Generate and store new token
  const token = await generateInvitationToken(email, metadata);

  logger.info('Invitation token updated (regenerated)', { email });

  return token;
}

/**
 * Result of getInvitationMetadata validation
 */
export type InvitationMetadataResult =
  | { valid: true; metadata: InvitationMetadata; expiresAt: Date }
  | { valid: false; reason: 'not_found' | 'expired' | 'invalid_token' };

/**
 * Validate a token and retrieve invitation metadata in one operation
 *
 * Combines token validation with metadata retrieval. Use this when you need
 * both validation status and metadata (e.g., for accept-invite page).
 *
 * @param email - The email address to validate
 * @param token - The plain text token to validate
 * @returns Validation result with metadata if valid, or failure reason
 *
 * @example
 * ```typescript
 * const result = await getInvitationMetadata('user@example.com', token);
 * if (result.valid) {
 *   console.log(`Invited by: ${result.metadata.invitedBy}`);
 * } else {
 *   console.log(`Failed: ${result.reason}`);
 * }
 * ```
 */
export async function getInvitationMetadata(
  email: string,
  token: string
): Promise<InvitationMetadataResult> {
  try {
    const hashedToken = hashToken(token);

    // First check if any invitation exists for this email (including expired)
    const anyInvitation = await prisma.verification.findFirst({
      where: {
        identifier: `${IDENTIFIER_PREFIX}${email}`,
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!anyInvitation) {
      logger.warn('Invitation not found for metadata lookup', { email });
      return { valid: false, reason: 'not_found' };
    }

    // Check if the invitation has expired
    if (anyInvitation.expiresAt <= new Date()) {
      logger.warn('Invitation expired for metadata lookup', {
        email,
        expiredAt: anyInvitation.expiresAt.toISOString(),
      });
      return { valid: false, reason: 'expired' };
    }

    // Validate the token
    if (anyInvitation.value !== hashedToken) {
      logger.warn('Invitation token mismatch for metadata lookup', { email });
      return { valid: false, reason: 'invalid_token' };
    }

    logger.info('Invitation metadata retrieved', { email });

    return {
      valid: true,
      metadata: anyInvitation.metadata as InvitationMetadata,
      expiresAt: anyInvitation.expiresAt,
    };
  } catch (error) {
    logger.error('Failed to get invitation metadata', error, { email });
    return { valid: false, reason: 'not_found' };
  }
}
