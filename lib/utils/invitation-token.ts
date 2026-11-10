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
 * Keying (#1199): one email can hold several pending invitations — one per
 * org — all under the same `invitation:<email>` identifier, told apart by
 * `metadata.orgId`. So nothing here reads "the invitation for this email":
 * a token is matched to its own row by its hash, a resend replaces only the
 * row in the same org, and acceptance consumes only the row it redeemed.
 * {@link deleteInvitationToken} is the one exception, and deletes every
 * invitation for the address on purpose (a platform admin's revoke).
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
import { parseInvitationMetadata, type InvitationMetadata } from '@/lib/validations/admin';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { DEFAULT_USER_ROLE } from '@/lib/auth/roles';

/**
 * Token Configuration
 */
const TOKEN_BYTE_LENGTH = 32; // 32 bytes = 64 hex characters
const TOKEN_EXPIRY_DAYS = 7; // 7 days until invitation expires
/** Prefix of a `Verification.identifier` that holds an invitation — `invitation:<email>`. */
export const INVITATION_IDENTIFIER_PREFIX = 'invitation:';
const IDENTIFIER_PREFIX = INVITATION_IDENTIFIER_PREFIX; // Prefix for invitation identifiers

/**
 * Hash a token using SHA-256
 *
 * @param token - The plain text token to hash
 * @returns The hashed token as a hex string
 */
export function hashInvitationToken(token: string): string {
  return hashToken(token);
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// Re-export InvitationMetadata from validations for backward compatibility
export type { InvitationMetadata } from '@/lib/validations/admin';

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
      role: metadata.role,
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
 * True when an unexpired invitation for `email` carries this token. Matched
 * by the token's hash, not by taking the newest row: the email may hold
 * invitations into several orgs, and each link redeems its own.
 *
 * @param email - The email address to validate the token for
 * @param token - The plain text token to validate
 * @returns True if token is valid, false otherwise
 */
export async function validateInvitationToken(email: string, token: string): Promise<boolean> {
  try {
    const verification = await prisma.verification.findFirst({
      where: {
        identifier: `${IDENTIFIER_PREFIX}${email}`,
        value: hashToken(token),
        expiresAt: { gt: new Date() },
      },
      select: { id: true },
    });

    if (!verification) {
      logger.warn('Invitation token not found, expired or mismatched', { email });
      return false;
    }

    logger.info('Invitation token validated', { email });
    return true;
  } catch (error) {
    logger.error('Failed to validate invitation token', error, { email });
    return false;
  }
}

/**
 * The unexpired invitation row this token redeems, or null.
 *
 * `metadata` is null when the row's metadata cannot be parsed: the token is
 * still valid, and the caller decides what an unreadable invitation grants.
 */
export async function findInvitationByToken(
  email: string,
  token: string
): Promise<{ id: string; metadata: InvitationMetadata | null; expiresAt: Date } | null> {
  const row = await prisma.verification.findFirst({
    where: {
      identifier: `${IDENTIFIER_PREFIX}${email}`,
      value: hashToken(token),
      expiresAt: { gt: new Date() },
    },
    select: { id: true, metadata: true, expiresAt: true },
  });
  if (!row) return null;
  return { id: row.id, metadata: parseInvitationMetadata(row.metadata), expiresAt: row.expiresAt };
}

/**
 * Delete one invitation row. Answers whether this call deleted it, so two
 * concurrent redemptions of the same token cannot both proceed: the one that
 * gets `false` lost the race.
 */
export async function consumeInvitation(id: string): Promise<boolean> {
  const { count } = await prisma.verification.deleteMany({ where: { id } });
  return count > 0;
}

/**
 * Delete the invitation this token redeems, expired or not — the invitee
 * declining it. Every other invitation for the address is left. Answers
 * whether a row went.
 */
export async function deleteInvitationByToken(email: string, token: string): Promise<boolean> {
  const { count } = await prisma.verification.deleteMany({
    where: { identifier: `${IDENTIFIER_PREFIX}${email}`, value: hashToken(token) },
  });
  logger.info('Invitation deleted by token', { email, deleted: count > 0 });
  return count > 0;
}

/**
 * Delete all invitation tokens for a given email — every org's.
 *
 * A platform admin's revoke. Acceptance and decline remove only the row they
 * redeemed ({@link consumeInvitation}, {@link deleteInvitationByToken}), so
 * an invitation into one org does not take the address's others with it.
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
 * Delete the address's invitations into one org — `orgId` `null` for the
 * install org — and no other org's (#1199). A platform admin's revoke of one
 * row in the pending list. Answers how many went.
 */
export async function deleteInvitationsInOrg(email: string, orgId: string | null): Promise<number> {
  const rows = await prisma.verification.findMany({
    where: { identifier: `${IDENTIFIER_PREFIX}${email}` },
    select: { id: true, metadata: true },
  });
  const slot = invitationOrgSlot(orgId);
  const ids = rows
    .filter((row) => {
      const parsed = parseInvitationMetadata(row.metadata);
      return parsed !== null && invitationOrgSlot(parsed.orgId) === slot;
    })
    .map((row) => row.id);
  if (ids.length === 0) return 0;
  const { count } = await prisma.verification.deleteMany({ where: { id: { in: ids } } });
  logger.info('Invitations deleted for one org', { email, orgId: slot, count });
  return count;
}

/**
 * Invitation record returned by getValidInvitation
 */
export type InvitationRecord = {
  /**
   * The `Verification` row's id. Every reader here sets it; optional so a
   * record built by hand (a fork's test fixture) still type-checks.
   */
  id?: string;
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

    const metadata = parseInvitationMetadata(verification.metadata);
    if (!metadata) {
      logger.warn('Invalid invitation metadata', { email });
      return null;
    }

    return {
      id: verification.id,
      email,
      metadata,
      expiresAt: verification.expiresAt,
      createdAt: verification.createdAt,
    };
  } catch (error) {
    logger.error('Failed to get valid invitation', error, { email });
    return null;
  }
}

/**
 * The org an invitation occupies, for keeping one per (email, org): its
 * `orgId`, or `null` for the install org, whether named or absent (#1199).
 */
export function invitationOrgSlot(orgId: string | null | undefined): string | null {
  return orgId && orgId !== INSTALL_ORG_ID ? orgId : null;
}

/**
 * A platform invitation: one granting a platform role, or into the install
 * org (named, absent or empty). It exists to create an account, so an
 * existing account cannot redeem it, and an org's own invitation route does
 * not write beside it (#1199). The one statement of the rule, for the routes
 * and the accept page alike.
 */
export function isPlatformInvitation(
  metadata: Pick<InvitationMetadata, 'role' | 'orgId'>
): boolean {
  return metadata.role !== DEFAULT_USER_ROLE || invitationOrgSlot(metadata.orgId) === null;
}

/** Every unexpired invitation for an address, as {@link pendingInvitationsFor} reads them. */
export interface PendingInvitations {
  /** Readable rows, newest first. */
  readable: InvitationRecord[];
  /** Unexpired rows whose metadata cannot be parsed, so whose org is unknown. */
  unreadable: number;
}

/**
 * Every unexpired invitation for `email`, newest first — one per org it has
 * been invited into. Throws on a failed read rather than answering "none",
 * because a caller deciding whether it may write a new invitation must not
 * read an outage as an empty slot.
 */
export async function pendingInvitationsFor(email: string): Promise<PendingInvitations> {
  const rows = await prisma.verification.findMany({
    where: { identifier: `${IDENTIFIER_PREFIX}${email}`, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
  });
  const readable: InvitationRecord[] = [];
  let unreadable = 0;
  for (const row of rows) {
    const metadata = parseInvitationMetadata(row.metadata);
    if (!metadata) {
      unreadable += 1;
      continue;
    }
    readable.push({
      id: row.id,
      email,
      metadata,
      expiresAt: row.expiresAt,
      createdAt: row.createdAt,
    });
  }
  return { readable, unreadable };
}

/**
 * Update (regenerate) an invitation token for an email
 *
 * Replaces the pending invitation in the same org as `metadata`
 * ({@link invitationOrgSlot}: the install org named or absent counts as one)
 * and creates a new one. An invitation for the same address into another org
 * is left alone, as is a row whose metadata cannot be read.
 *
 * @param email - The email address to update the invitation for
 * @param metadata - Updated invitation metadata
 * @returns The new unhashed token string
 */
export async function updateInvitationToken(
  email: string,
  metadata: InvitationMetadata
): Promise<string> {
  const replaced = await deleteInvitationsInOrg(email, metadata.orgId ?? null);

  const token = await generateInvitationToken(email, metadata);

  logger.info('Invitation token updated (regenerated)', {
    email,
    orgId: metadata.orgId ?? null,
    replaced,
  });

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
    // This token's own row, expired or not. The address may hold invitations
    // into several orgs, so the newest row is not necessarily this link's.
    const invitation = await prisma.verification.findFirst({
      where: {
        identifier: `${IDENTIFIER_PREFIX}${email}`,
        value: hashToken(token),
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!invitation) {
      // Some invitation for the address exists, but not this token's: a
      // stale link (re-sent since) or a mistyped one.
      const anyInvitation = await prisma.verification.count({
        where: { identifier: `${IDENTIFIER_PREFIX}${email}` },
      });
      if (anyInvitation > 0) {
        logger.warn('Invitation token mismatch for metadata lookup', { email });
        return { valid: false, reason: 'invalid_token' };
      }
      logger.warn('Invitation not found for metadata lookup', { email });
      return { valid: false, reason: 'not_found' };
    }

    if (invitation.expiresAt <= new Date()) {
      logger.warn('Invitation expired for metadata lookup', {
        email,
        expiredAt: invitation.expiresAt.toISOString(),
      });
      return { valid: false, reason: 'expired' };
    }

    const metadata = parseInvitationMetadata(invitation.metadata);
    if (!metadata) {
      logger.warn('Invalid invitation metadata for metadata lookup', { email });
      return { valid: false, reason: 'not_found' as const };
    }

    logger.info('Invitation metadata retrieved', { email });

    return {
      valid: true,
      metadata,
      expiresAt: invitation.expiresAt,
    };
  } catch (error) {
    logger.error('Failed to get invitation metadata', error, { email });
    return { valid: false, reason: 'not_found' };
  }
}

/**
 * Options for getting all pending invitations
 */
export interface GetAllPendingInvitationsOptions {
  /** Search query for name or email */
  search?: string;
  /** Page number (1-indexed) */
  page?: number;
  /** Items per page */
  limit?: number;
  /** Field to sort by */
  sortBy?: 'name' | 'email' | 'invitedAt' | 'expiresAt';
  /** Sort order */
  sortOrder?: 'asc' | 'desc';
}

/**
 * Pending invitation item for list display
 */
export interface PendingInvitationItem {
  email: string;
  /**
   * The org it joins, `null` for the install org (#1199). An address can have
   * one row per org, so `(email, orgId)` names a row; email alone does not.
   * Optional so a hand-built item still type-checks.
   */
  orgId?: string | null;
  /** The org role it grants, when it names one. */
  orgRole?: string | null;
  name: string;
  role: string;
  invitedBy: string;
  invitedByName: string | null;
  invitedAt: Date;
  expiresAt: Date;
}

/**
 * Get all pending (non-expired) invitations
 *
 * Queries the Verification table for all invitation records that haven't expired.
 * Supports search by email/name, pagination, and sorting.
 *
 * @param options - Query options for filtering, pagination, and sorting
 * @returns Object containing invitations array and total count
 *
 * @example
 * ```typescript
 * const { invitations, total } = await getAllPendingInvitations({
 *   search: 'john',
 *   page: 1,
 *   limit: 20,
 *   sortBy: 'invitedAt',
 *   sortOrder: 'desc',
 * });
 * ```
 */
export async function getAllPendingInvitations(
  options: GetAllPendingInvitationsOptions = {}
): Promise<{ invitations: PendingInvitationItem[]; total: number }> {
  const { search, page = 1, limit = 20, sortBy = 'invitedAt', sortOrder = 'desc' } = options;

  try {
    // Build the base where clause - find all non-expired invitations
    const baseWhere = {
      identifier: { startsWith: IDENTIFIER_PREFIX },
      expiresAt: { gt: new Date() },
    };

    // Get all pending invitations from database
    const [verifications, total] = await Promise.all([
      prisma.verification.findMany({
        where: baseWhere,
        orderBy: { createdAt: sortOrder },
      }),
      prisma.verification.count({ where: baseWhere }),
    ]);

    // Transform verification records to invitation items with metadata
    // Skip records with invalid/corrupt metadata
    const allItems = await Promise.all(
      verifications.map(async (v): Promise<PendingInvitationItem | null> => {
        const metadata = parseInvitationMetadata(v.metadata);
        if (!metadata) return null;

        const email = v.identifier.replace(IDENTIFIER_PREFIX, '');

        // Look up the inviter's name
        let invitedByName: string | null = null;
        if (metadata.invitedBy) {
          const inviter = await prisma.user.findUnique({
            where: { id: metadata.invitedBy },
            select: { name: true },
          });
          invitedByName = inviter?.name ?? null;
        }

        return {
          email,
          orgId: invitationOrgSlot(metadata.orgId),
          orgRole: metadata.orgRole ?? null,
          name: metadata.name,
          role: metadata.role,
          invitedBy: metadata.invitedBy,
          invitedByName,
          invitedAt: new Date(metadata.invitedAt),
          expiresAt: v.expiresAt,
        };
      })
    );

    let invitations: PendingInvitationItem[] = allItems.filter(
      (item): item is PendingInvitationItem => item !== null
    );

    // Apply search filter if provided
    if (search) {
      const searchLower = search.toLowerCase();
      invitations = invitations.filter(
        (inv) =>
          inv.email.toLowerCase().includes(searchLower) ||
          inv.name.toLowerCase().includes(searchLower)
      );
    }

    // Sort invitations based on sortBy and sortOrder
    invitations.sort((a, b) => {
      let aValue: string | Date;
      let bValue: string | Date;

      switch (sortBy) {
        case 'name':
          aValue = a.name.toLowerCase();
          bValue = b.name.toLowerCase();
          break;
        case 'email':
          aValue = a.email.toLowerCase();
          bValue = b.email.toLowerCase();
          break;
        case 'expiresAt':
          aValue = a.expiresAt;
          bValue = b.expiresAt;
          break;
        case 'invitedAt':
        default:
          aValue = a.invitedAt;
          bValue = b.invitedAt;
          break;
      }

      if (aValue < bValue) return sortOrder === 'asc' ? -1 : 1;
      if (aValue > bValue) return sortOrder === 'asc' ? 1 : -1;
      return 0;
    });

    // Calculate total after search filter
    const filteredTotal = search ? invitations.length : total;

    // Apply pagination
    const skip = (page - 1) * limit;
    const paginatedInvitations = invitations.slice(skip, skip + limit);

    logger.info('Fetched pending invitations', {
      total: filteredTotal,
      page,
      limit,
      search: search || null,
    });

    return {
      invitations: paginatedInvitations,
      total: filteredTotal,
    };
  } catch (error) {
    logger.error('Failed to fetch pending invitations', error);
    throw new Error('Failed to fetch pending invitations');
  }
}
