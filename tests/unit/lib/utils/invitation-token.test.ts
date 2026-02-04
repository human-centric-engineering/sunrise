/**
 * Invitation Token Utility Tests
 *
 * Phase 3.1, Step 4.1: Comprehensive tests for invitation token generation and validation.
 *
 * Test Coverage:
 * - generateInvitationToken() - Token generation and storage
 * - validateInvitationToken() - Token validation (valid, expired, invalid)
 * - deleteInvitationToken() - Token deletion and cleanup
 * - Security features - Token hashing, expiration, single-use
 *
 * @see lib/utils/invitation-token.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { randomBytes, createHash } from 'crypto';
import {
  generateInvitationToken,
  validateInvitationToken,
  deleteInvitationToken,
  getValidInvitation,
  updateInvitationToken,
  getInvitationMetadata,
} from '@/lib/utils/invitation-token';

/**
 * Mock dependencies
 */

// Mock Prisma client
vi.mock('@/lib/db/client', () => ({
  prisma: {
    verification: {
      create: vi.fn(),
      findFirst: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
}));

// Mock logger
vi.mock('@/lib/logging', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Import mocked modules
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';

/**
 * Test data factories
 */

const createMockVerification = (email: string, token: string, daysOffset = 0) => {
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + daysOffset);

  const hashedToken = createHash('sha256').update(token).digest('hex');

  return {
    id: 'verification-123',
    identifier: `invitation:${email}`,
    value: hashedToken,
    expiresAt,
    createdAt: new Date(),
    updatedAt: new Date(),
    metadata: null, // Added for Prisma schema compatibility
  };
};

const createMockMetadata = () => ({
  name: 'Test User',
  role: 'USER',
  invitedBy: 'admin-123',
  invitedAt: new Date().toISOString(),
});

/**
 * Test Suite: generateInvitationToken()
 */
describe('generateInvitationToken()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('successful token generation', () => {
    it('should generate a secure random token', async () => {
      // Arrange
      const email = 'user@example.com';
      const metadata = createMockMetadata();
      vi.mocked(prisma.verification.create).mockResolvedValue({
        id: 'verification-123',
        identifier: `invitation:${email}`,
        value: 'hashed-token',
        expiresAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
        metadata: null,
      });

      // Act
      const token = await generateInvitationToken(email, metadata);

      // Assert: Token should be 64 hex characters (32 bytes)
      expect(token).toMatch(/^[a-f0-9]{64}$/);
      expect(token.length).toBe(64);
    });

    it('should store hashed token in database', async () => {
      // Arrange
      const email = 'user@example.com';
      const metadata = createMockMetadata();
      let storedValue = '';

      vi.mocked(prisma.verification.create).mockImplementation((args: any) => {
        storedValue = args.data.value;
        return Promise.resolve({
          id: 'verification-123',
          identifier: args.data.identifier,
          value: args.data.value,
          expiresAt: args.data.expiresAt,
          createdAt: new Date(),
          updatedAt: new Date(),
          metadata: null,
        }) as any;
      });

      // Act
      const token = await generateInvitationToken(email, metadata);

      // Assert: Stored value should be hashed (different from plain token)
      expect(storedValue).not.toBe(token);
      expect(storedValue).toMatch(/^[a-f0-9]{64}$/); // SHA-256 hash is also 64 hex chars
      expect(storedValue).toBe(createHash('sha256').update(token).digest('hex'));
    });

    it('should store token with correct identifier format', async () => {
      // Arrange
      const email = 'test@example.com';
      const metadata = createMockMetadata();
      vi.mocked(prisma.verification.create).mockResolvedValue({
        id: 'verification-123',
        identifier: `invitation:${email}`,
        value: 'hashed-token',
        expiresAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
        metadata: null,
      });

      // Act
      await generateInvitationToken(email, metadata);

      // Assert: Identifier should be prefixed with "invitation:"
      expect(prisma.verification.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          identifier: `invitation:${email}`,
        }),
      });
    });

    it('should set expiration to 7 days from now', async () => {
      // Arrange
      const email = 'user@example.com';
      const metadata = createMockMetadata();
      const now = new Date();
      vi.mocked(prisma.verification.create).mockResolvedValue({
        id: 'verification-123',
        identifier: `invitation:${email}`,
        value: 'hashed-token',
        expiresAt: now,
        createdAt: now,
        updatedAt: now,
        metadata: null,
      });

      // Act
      await generateInvitationToken(email, metadata);

      // Assert: ExpiresAt should be ~7 days from now
      const callArgs = vi.mocked(prisma.verification.create).mock.calls[0][0];
      const expiresAt = callArgs.data.expiresAt as Date;
      const expectedExpiry = new Date();
      expectedExpiry.setDate(expectedExpiry.getDate() + 7);

      // Allow 1 second tolerance for test execution time
      expect(Math.abs(expiresAt.getTime() - expectedExpiry.getTime())).toBeLessThan(1000);
    });

    it('should log token generation', async () => {
      // Arrange
      const email = 'user@example.com';
      const metadata = createMockMetadata();
      vi.mocked(prisma.verification.create).mockResolvedValue({
        id: 'verification-123',
        identifier: `invitation:${email}`,
        value: 'hashed-token',
        expiresAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
        metadata: null,
      });

      // Act
      await generateInvitationToken(email, metadata);

      // Assert: Should log info with email, expiration, and role (not full metadata)
      expect(logger.info).toHaveBeenCalledWith(
        'Invitation token generated',
        expect.objectContaining({
          email,
          expiresAt: expect.any(String),
          role: metadata.role,
        })
      );
    });

    it('should generate unique tokens on each call', async () => {
      // Arrange
      const email = 'user@example.com';
      const metadata = createMockMetadata();
      vi.mocked(prisma.verification.create).mockResolvedValue({
        id: 'verification-123',
        identifier: `invitation:${email}`,
        value: 'hashed-token',
        expiresAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
        metadata: null,
      });

      // Act: Generate multiple tokens
      const token1 = await generateInvitationToken(email, metadata);
      const token2 = await generateInvitationToken(email, metadata);
      const token3 = await generateInvitationToken(email, metadata);

      // Assert: All tokens should be unique
      expect(token1).not.toBe(token2);
      expect(token2).not.toBe(token3);
      expect(token1).not.toBe(token3);
    });
  });

  describe('error handling', () => {
    it('should throw error when database create fails', async () => {
      // Arrange
      const email = 'user@example.com';
      const metadata = createMockMetadata();
      const dbError = new Error('Database connection failed');
      vi.mocked(prisma.verification.create).mockRejectedValue(dbError);

      // Act & Assert
      await expect(generateInvitationToken(email, metadata)).rejects.toThrow(
        'Failed to generate invitation token'
      );
    });

    it('should log error when generation fails', async () => {
      // Arrange
      const email = 'user@example.com';
      const metadata = createMockMetadata();
      const dbError = new Error('Database error');
      vi.mocked(prisma.verification.create).mockRejectedValue(dbError);

      // Act
      try {
        await generateInvitationToken(email, metadata);
      } catch {
        // Expected to throw
      }

      // Assert: Should log error with details
      expect(logger.error).toHaveBeenCalledWith('Failed to generate invitation token', dbError, {
        email,
      });
    });
  });
});

/**
 * Test Suite: validateInvitationToken()
 */
describe('validateInvitationToken()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('valid token', () => {
    it('should return true for valid token', async () => {
      // Arrange
      const email = 'user@example.com';
      const token = randomBytes(32).toString('hex');
      const verification = createMockVerification(email, token, 7); // Expires in 7 days

      vi.mocked(prisma.verification.findFirst).mockResolvedValue(verification);

      // Act
      const result = await validateInvitationToken(email, token);

      // Assert
      expect(result).toBe(true);
    });

    it('should query database with correct identifier, expiration filter, and ordering', async () => {
      // Arrange
      const email = 'test@example.com';
      const token = randomBytes(32).toString('hex');
      const verification = createMockVerification(email, token, 7);

      vi.mocked(prisma.verification.findFirst).mockResolvedValue(verification);

      // Act
      await validateInvitationToken(email, token);

      // Assert: Should filter by non-expired and order by most recent
      expect(prisma.verification.findFirst).toHaveBeenCalledWith({
        where: {
          identifier: `invitation:${email}`,
          expiresAt: { gt: expect.any(Date) },
        },
        orderBy: { createdAt: 'desc' },
      });
    });

    it('should compare hashed tokens', async () => {
      // Arrange
      const email = 'user@example.com';
      const correctToken = randomBytes(32).toString('hex');
      const wrongToken = randomBytes(32).toString('hex');
      const verification = createMockVerification(email, correctToken, 7);

      vi.mocked(prisma.verification.findFirst).mockResolvedValue(verification);

      // Act
      const validResult = await validateInvitationToken(email, correctToken);
      const invalidResult = await validateInvitationToken(email, wrongToken);

      // Assert
      expect(validResult).toBe(true);
      expect(invalidResult).toBe(false);
    });

    it('should log successful validation', async () => {
      // Arrange
      const email = 'user@example.com';
      const token = randomBytes(32).toString('hex');
      const verification = createMockVerification(email, token, 7);

      vi.mocked(prisma.verification.findFirst).mockResolvedValue(verification);

      // Act
      await validateInvitationToken(email, token);

      // Assert
      expect(logger.info).toHaveBeenCalledWith('Invitation token validated', { email });
    });
  });

  describe('invalid token', () => {
    it('should return false when token not found', async () => {
      // Arrange
      const email = 'user@example.com';
      const token = randomBytes(32).toString('hex');

      vi.mocked(prisma.verification.findFirst).mockResolvedValue(null);

      // Act
      const result = await validateInvitationToken(email, token);

      // Assert
      expect(result).toBe(false);
    });

    it('should log warning when token not found', async () => {
      // Arrange
      const email = 'user@example.com';
      const token = randomBytes(32).toString('hex');

      vi.mocked(prisma.verification.findFirst).mockResolvedValue(null);

      // Act
      await validateInvitationToken(email, token);

      // Assert
      expect(logger.warn).toHaveBeenCalledWith('Invitation token not found or expired', { email });
    });

    it('should return false when token does not match', async () => {
      // Arrange
      const email = 'user@example.com';
      const correctToken = randomBytes(32).toString('hex');
      const wrongToken = randomBytes(32).toString('hex');
      const verification = createMockVerification(email, correctToken, 7);

      vi.mocked(prisma.verification.findFirst).mockResolvedValue(verification);

      // Act
      const result = await validateInvitationToken(email, wrongToken);

      // Assert
      expect(result).toBe(false);
    });

    it('should log warning when token does not match', async () => {
      // Arrange
      const email = 'user@example.com';
      const correctToken = randomBytes(32).toString('hex');
      const wrongToken = randomBytes(32).toString('hex');
      const verification = createMockVerification(email, correctToken, 7);

      vi.mocked(prisma.verification.findFirst).mockResolvedValue(verification);

      // Act
      await validateInvitationToken(email, wrongToken);

      // Assert
      expect(logger.warn).toHaveBeenCalledWith('Invitation token mismatch', { email });
    });
  });

  describe('expired token', () => {
    it('should return false when token has expired (filtered at DB level)', async () => {
      // Arrange
      const email = 'user@example.com';
      const token = randomBytes(32).toString('hex');

      // DB query with expiration filter returns null for expired tokens
      vi.mocked(prisma.verification.findFirst).mockResolvedValue(null);

      // Act
      const result = await validateInvitationToken(email, token);

      // Assert
      expect(result).toBe(false);
    });

    it('should log warning when no valid (non-expired) token found', async () => {
      // Arrange
      const email = 'user@example.com';
      const token = randomBytes(32).toString('hex');

      // DB query with expiration filter returns null for expired tokens
      vi.mocked(prisma.verification.findFirst).mockResolvedValue(null);

      // Act
      await validateInvitationToken(email, token);

      // Assert: Expiration is now handled at DB query level
      expect(logger.warn).toHaveBeenCalledWith('Invitation token not found or expired', { email });
    });

    it('should filter expired tokens via DB query', async () => {
      // Arrange
      const email = 'user@example.com';
      const token = randomBytes(32).toString('hex');

      vi.mocked(prisma.verification.findFirst).mockResolvedValue(null);

      // Act
      await validateInvitationToken(email, token);

      // Assert: DB query should include expiration filter
      expect(prisma.verification.findFirst).toHaveBeenCalledWith({
        where: {
          identifier: `invitation:${email}`,
          expiresAt: { gt: expect.any(Date) },
        },
        orderBy: { createdAt: 'desc' },
      });
    });
  });

  describe('error handling', () => {
    it('should return false when database query fails', async () => {
      // Arrange
      const email = 'user@example.com';
      const token = randomBytes(32).toString('hex');
      const dbError = new Error('Database error');

      vi.mocked(prisma.verification.findFirst).mockRejectedValue(dbError);

      // Act
      const result = await validateInvitationToken(email, token);

      // Assert
      expect(result).toBe(false);
    });

    it('should log error when validation fails', async () => {
      // Arrange
      const email = 'user@example.com';
      const token = randomBytes(32).toString('hex');
      const dbError = new Error('Database error');

      vi.mocked(prisma.verification.findFirst).mockRejectedValue(dbError);

      // Act
      await validateInvitationToken(email, token);

      // Assert
      expect(logger.error).toHaveBeenCalledWith('Failed to validate invitation token', dbError, {
        email,
      });
    });

    it('should not throw when database error occurs', async () => {
      // Arrange
      const email = 'user@example.com';
      const token = randomBytes(32).toString('hex');

      vi.mocked(prisma.verification.findFirst).mockRejectedValue(new Error('DB error'));

      // Act & Assert: Should not throw, just return false
      await expect(validateInvitationToken(email, token)).resolves.toBe(false);
    });
  });
});

/**
 * Test Suite: deleteInvitationToken()
 */
describe('deleteInvitationToken()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('successful deletion', () => {
    it('should delete tokens for email', async () => {
      // Arrange
      const email = 'user@example.com';
      vi.mocked(prisma.verification.deleteMany).mockResolvedValue({ count: 1 });

      // Act
      await deleteInvitationToken(email);

      // Assert
      expect(prisma.verification.deleteMany).toHaveBeenCalledWith({
        where: {
          identifier: `invitation:${email}`,
        },
      });
    });

    it('should handle deletion of multiple tokens', async () => {
      // Arrange
      const email = 'user@example.com';
      vi.mocked(prisma.verification.deleteMany).mockResolvedValue({ count: 3 });

      // Act
      await deleteInvitationToken(email);

      // Assert: Should delete all matching tokens
      expect(prisma.verification.deleteMany).toHaveBeenCalledWith({
        where: {
          identifier: `invitation:${email}`,
        },
      });
    });

    it('should log deletion with count', async () => {
      // Arrange
      const email = 'user@example.com';
      const deleteCount = 2;
      vi.mocked(prisma.verification.deleteMany).mockResolvedValue({ count: deleteCount });

      // Act
      await deleteInvitationToken(email);

      // Assert
      expect(logger.info).toHaveBeenCalledWith('Invitation tokens deleted', {
        email,
        count: deleteCount,
      });
    });

    it('should handle zero deletions gracefully', async () => {
      // Arrange
      const email = 'user@example.com';
      vi.mocked(prisma.verification.deleteMany).mockResolvedValue({ count: 0 });

      // Act
      await deleteInvitationToken(email);

      // Assert: Should still log and complete successfully
      expect(logger.info).toHaveBeenCalledWith('Invitation tokens deleted', {
        email,
        count: 0,
      });
    });
  });

  describe('error handling', () => {
    it('should throw error when deletion fails', async () => {
      // Arrange
      const email = 'user@example.com';
      const dbError = new Error('Database error');
      vi.mocked(prisma.verification.deleteMany).mockRejectedValue(dbError);

      // Act & Assert
      await expect(deleteInvitationToken(email)).rejects.toThrow(
        'Failed to delete invitation token'
      );
    });

    it('should log error when deletion fails', async () => {
      // Arrange
      const email = 'user@example.com';
      const dbError = new Error('Database error');
      vi.mocked(prisma.verification.deleteMany).mockRejectedValue(dbError);

      // Act
      try {
        await deleteInvitationToken(email);
      } catch {
        // Expected to throw
      }

      // Assert
      expect(logger.error).toHaveBeenCalledWith('Failed to delete invitation token', dbError, {
        email,
      });
    });
  });
});

/**
 * Test Suite: getValidInvitation()
 */
describe('getValidInvitation()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('valid invitation exists', () => {
    it('should return invitation record when non-expired invitation exists', async () => {
      // Arrange
      const email = 'user@example.com';
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
      const createdAt = new Date();
      const metadata = {
        name: 'Test User',
        role: 'USER',
        invitedBy: 'admin-123',
        invitedAt: createdAt.toISOString(),
      };

      vi.mocked(prisma.verification.findFirst).mockResolvedValue({
        id: 'verification-123',
        identifier: `invitation:${email}`,
        value: 'hashed-token',
        expiresAt,
        createdAt,
        updatedAt: createdAt,
        metadata,
      });

      // Act
      const result = await getValidInvitation(email);

      // Assert
      expect(result).toMatchObject({
        email,
        metadata,
        expiresAt,
        createdAt,
      });
    });

    it('should query with expiration filter and ordering', async () => {
      // Arrange
      const email = 'test@example.com';
      vi.mocked(prisma.verification.findFirst).mockResolvedValue(null);

      // Act
      await getValidInvitation(email);

      // Assert
      expect(prisma.verification.findFirst).toHaveBeenCalledWith({
        where: {
          identifier: `invitation:${email}`,
          expiresAt: { gt: expect.any(Date) },
        },
        orderBy: { createdAt: 'desc' },
      });
    });
  });

  describe('no valid invitation', () => {
    it('should return null when no invitation exists', async () => {
      // Arrange
      const email = 'user@example.com';
      vi.mocked(prisma.verification.findFirst).mockResolvedValue(null);

      // Act
      const result = await getValidInvitation(email);

      // Assert
      expect(result).toBeNull();
    });

    it('should return null when only expired invitations exist (filtered by DB)', async () => {
      // Arrange
      const email = 'user@example.com';
      // DB returns null because expiration filter excludes expired tokens
      vi.mocked(prisma.verification.findFirst).mockResolvedValue(null);

      // Act
      const result = await getValidInvitation(email);

      // Assert
      expect(result).toBeNull();
    });
  });

  describe('error handling', () => {
    it('should return null and log error on database failure', async () => {
      // Arrange
      const email = 'user@example.com';
      const dbError = new Error('Database connection failed');
      vi.mocked(prisma.verification.findFirst).mockRejectedValue(dbError);

      // Act
      const result = await getValidInvitation(email);

      // Assert
      expect(result).toBeNull();
      expect(logger.error).toHaveBeenCalledWith('Failed to get valid invitation', dbError, {
        email,
      });
    });
  });
});

/**
 * Test Suite: updateInvitationToken()
 */
describe('updateInvitationToken()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('successful update', () => {
    it('should delete existing tokens and create new one', async () => {
      // Arrange
      const email = 'user@example.com';
      const metadata = createMockMetadata();

      // Mock deleteMany (called by deleteInvitationToken)
      vi.mocked(prisma.verification.deleteMany).mockResolvedValue({ count: 1 });

      // Mock create (called by generateInvitationToken)
      vi.mocked(prisma.verification.create).mockResolvedValue({
        id: 'verification-new',
        identifier: `invitation:${email}`,
        value: 'new-hashed-token',
        expiresAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
        metadata: null,
      });

      // Act
      const token = await updateInvitationToken(email, metadata);

      // Assert: Should return new token
      expect(token).toMatch(/^[a-f0-9]{64}$/);

      // Assert: Old tokens deleted
      expect(prisma.verification.deleteMany).toHaveBeenCalledWith({
        where: { identifier: `invitation:${email}` },
      });

      // Assert: New token created
      expect(prisma.verification.create).toHaveBeenCalled();
    });

    it('should log token regeneration', async () => {
      // Arrange
      const email = 'user@example.com';
      const metadata = createMockMetadata();

      vi.mocked(prisma.verification.deleteMany).mockResolvedValue({ count: 1 });
      vi.mocked(prisma.verification.create).mockResolvedValue({
        id: 'verification-new',
        identifier: `invitation:${email}`,
        value: 'hashed-token',
        expiresAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
        metadata: null,
      });

      // Act
      await updateInvitationToken(email, metadata);

      // Assert
      expect(logger.info).toHaveBeenCalledWith('Invitation token updated (regenerated)', { email });
    });

    it('should invalidate old token after update', async () => {
      // Arrange
      const email = 'user@example.com';
      const metadata = createMockMetadata();
      let storedToken = '';

      vi.mocked(prisma.verification.deleteMany).mockResolvedValue({ count: 1 });
      vi.mocked(prisma.verification.create).mockImplementation((args: any) => {
        storedToken = args.data.value;
        return Promise.resolve({
          id: 'verification-new',
          identifier: args.data.identifier,
          value: args.data.value,
          expiresAt: args.data.expiresAt,
          createdAt: new Date(),
          updatedAt: new Date(),
          metadata: null,
        }) as any;
      });

      // Act: Update token
      const newToken = await updateInvitationToken(email, metadata);

      // Assert: New token is different from what was stored (hashed)
      expect(newToken).not.toBe(storedToken);
      expect(storedToken).toBe(createHash('sha256').update(newToken).digest('hex'));
    });
  });

  describe('error handling', () => {
    it('should propagate error if delete fails', async () => {
      // Arrange
      const email = 'user@example.com';
      const metadata = createMockMetadata();
      const dbError = new Error('Delete failed');
      vi.mocked(prisma.verification.deleteMany).mockRejectedValue(dbError);

      // Act & Assert
      await expect(updateInvitationToken(email, metadata)).rejects.toThrow(
        'Failed to delete invitation token'
      );
    });

    it('should propagate error if create fails', async () => {
      // Arrange
      const email = 'user@example.com';
      const metadata = createMockMetadata();
      vi.mocked(prisma.verification.deleteMany).mockResolvedValue({ count: 1 });
      vi.mocked(prisma.verification.create).mockRejectedValue(new Error('Create failed'));

      // Act & Assert
      await expect(updateInvitationToken(email, metadata)).rejects.toThrow(
        'Failed to generate invitation token'
      );
    });
  });
});

/**
 * Test Suite: getInvitationMetadata()
 */
describe('getInvitationMetadata()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('valid token', () => {
    it('should return valid result with metadata when token is valid', async () => {
      // Arrange
      const email = 'user@example.com';
      const token = randomBytes(32).toString('hex');
      const hashedToken = createHash('sha256').update(token).digest('hex');
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      const metadata = {
        name: 'Test User',
        role: 'USER',
        invitedBy: 'admin-123',
        invitedAt: new Date().toISOString(),
      };

      vi.mocked(prisma.verification.findFirst).mockResolvedValue({
        id: 'verification-123',
        identifier: `invitation:${email}`,
        value: hashedToken,
        expiresAt,
        createdAt: new Date(),
        updatedAt: new Date(),
        metadata,
      });

      // Act
      const result = await getInvitationMetadata(email, token);

      // Assert
      expect(result).toEqual({
        valid: true,
        metadata,
        expiresAt,
      });
    });

    it('should log successful metadata retrieval', async () => {
      // Arrange
      const email = 'user@example.com';
      const token = randomBytes(32).toString('hex');
      const hashedToken = createHash('sha256').update(token).digest('hex');

      vi.mocked(prisma.verification.findFirst).mockResolvedValue({
        id: 'verification-123',
        identifier: `invitation:${email}`,
        value: hashedToken,
        expiresAt: new Date(Date.now() + 86400000),
        createdAt: new Date(),
        updatedAt: new Date(),
        metadata: { name: 'Test', role: 'USER', invitedBy: 'admin', invitedAt: '' },
      });

      // Act
      await getInvitationMetadata(email, token);

      // Assert
      expect(logger.info).toHaveBeenCalledWith('Invitation metadata retrieved', { email });
    });
  });

  describe('not found', () => {
    it("should return not_found reason when invitation doesn't exist", async () => {
      // Arrange
      const email = 'user@example.com';
      const token = randomBytes(32).toString('hex');

      vi.mocked(prisma.verification.findFirst).mockResolvedValue(null);

      // Act
      const result = await getInvitationMetadata(email, token);

      // Assert
      expect(result).toEqual({ valid: false, reason: 'not_found' });
    });

    it('should log warning when invitation not found', async () => {
      // Arrange
      const email = 'user@example.com';
      const token = randomBytes(32).toString('hex');

      vi.mocked(prisma.verification.findFirst).mockResolvedValue(null);

      // Act
      await getInvitationMetadata(email, token);

      // Assert
      expect(logger.warn).toHaveBeenCalledWith('Invitation not found for metadata lookup', {
        email,
      });
    });
  });

  describe('expired', () => {
    it('should return expired reason when invitation has expired', async () => {
      // Arrange
      const email = 'user@example.com';
      const token = randomBytes(32).toString('hex');
      const hashedToken = createHash('sha256').update(token).digest('hex');
      const expiredAt = new Date(Date.now() - 86400000); // Yesterday

      vi.mocked(prisma.verification.findFirst).mockResolvedValue({
        id: 'verification-123',
        identifier: `invitation:${email}`,
        value: hashedToken,
        expiresAt: expiredAt,
        createdAt: new Date(),
        updatedAt: new Date(),
        metadata: { name: 'Test', role: 'USER', invitedBy: 'admin', invitedAt: '' },
      });

      // Act
      const result = await getInvitationMetadata(email, token);

      // Assert
      expect(result).toEqual({ valid: false, reason: 'expired' });
    });

    it('should log warning with expiration time when expired', async () => {
      // Arrange
      const email = 'user@example.com';
      const token = randomBytes(32).toString('hex');
      const hashedToken = createHash('sha256').update(token).digest('hex');
      const expiredAt = new Date(Date.now() - 86400000);

      vi.mocked(prisma.verification.findFirst).mockResolvedValue({
        id: 'verification-123',
        identifier: `invitation:${email}`,
        value: hashedToken,
        expiresAt: expiredAt,
        createdAt: new Date(),
        updatedAt: new Date(),
        metadata: { name: 'Test', role: 'USER', invitedBy: 'admin', invitedAt: '' },
      });

      // Act
      await getInvitationMetadata(email, token);

      // Assert
      expect(logger.warn).toHaveBeenCalledWith(
        'Invitation expired for metadata lookup',
        expect.objectContaining({
          email,
          expiredAt: expect.any(String),
        })
      );
    });
  });

  describe('invalid token', () => {
    it('should return invalid_token reason when token does not match', async () => {
      // Arrange
      const email = 'user@example.com';
      const correctToken = randomBytes(32).toString('hex');
      const wrongToken = randomBytes(32).toString('hex');
      const correctHashedToken = createHash('sha256').update(correctToken).digest('hex');

      vi.mocked(prisma.verification.findFirst).mockResolvedValue({
        id: 'verification-123',
        identifier: `invitation:${email}`,
        value: correctHashedToken,
        expiresAt: new Date(Date.now() + 86400000),
        createdAt: new Date(),
        updatedAt: new Date(),
        metadata: { name: 'Test', role: 'USER', invitedBy: 'admin', invitedAt: '' },
      });

      // Act
      const result = await getInvitationMetadata(email, wrongToken);

      // Assert
      expect(result).toEqual({ valid: false, reason: 'invalid_token' });
    });

    it('should log warning when token mismatch', async () => {
      // Arrange
      const email = 'user@example.com';
      const correctToken = randomBytes(32).toString('hex');
      const wrongToken = randomBytes(32).toString('hex');
      const correctHashedToken = createHash('sha256').update(correctToken).digest('hex');

      vi.mocked(prisma.verification.findFirst).mockResolvedValue({
        id: 'verification-123',
        identifier: `invitation:${email}`,
        value: correctHashedToken,
        expiresAt: new Date(Date.now() + 86400000),
        createdAt: new Date(),
        updatedAt: new Date(),
        metadata: { name: 'Test', role: 'USER', invitedBy: 'admin', invitedAt: '' },
      });

      // Act
      await getInvitationMetadata(email, wrongToken);

      // Assert
      expect(logger.warn).toHaveBeenCalledWith('Invitation token mismatch for metadata lookup', {
        email,
      });
    });
  });

  describe('error handling', () => {
    it('should return not_found and log error on database failure', async () => {
      // Arrange
      const email = 'user@example.com';
      const token = randomBytes(32).toString('hex');
      const dbError = new Error('Database failed');

      vi.mocked(prisma.verification.findFirst).mockRejectedValue(dbError);

      // Act
      const result = await getInvitationMetadata(email, token);

      // Assert
      expect(result).toEqual({ valid: false, reason: 'not_found' });
      expect(logger.error).toHaveBeenCalledWith('Failed to get invitation metadata', dbError, {
        email,
      });
    });
  });
});

/**
 * Integration Test: Full workflow
 */
describe('Full invitation workflow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should handle complete invitation flow', async () => {
    // Arrange
    const email = 'user@example.com';
    const metadata = createMockMetadata();
    let storedToken = '';

    // Mock token generation
    vi.mocked(prisma.verification.create).mockImplementation((args: any) => {
      storedToken = args.data.value;
      return Promise.resolve({
        id: 'verification-123',
        identifier: args.data.identifier,
        value: args.data.value,
        expiresAt: args.data.expiresAt,
        createdAt: new Date(),
        updatedAt: new Date(),
        metadata: null,
      }) as any;
    });

    // Act: Generate token
    const token = await generateInvitationToken(email, metadata);

    // Mock token validation
    vi.mocked(prisma.verification.findFirst).mockResolvedValue({
      id: 'verification-123',
      identifier: `invitation:${email}`,
      value: storedToken,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days from now
      createdAt: new Date(),
      updatedAt: new Date(),
      metadata: null,
    });

    // Act: Validate token
    const isValid = await validateInvitationToken(email, token);

    // Mock token deletion
    vi.mocked(prisma.verification.deleteMany).mockResolvedValue({ count: 1 });

    // Act: Delete token
    await deleteInvitationToken(email);

    // Assert
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect(isValid).toBe(true);
    expect(prisma.verification.deleteMany).toHaveBeenCalledWith({
      where: {
        identifier: `invitation:${email}`,
      },
    });
  });
});
