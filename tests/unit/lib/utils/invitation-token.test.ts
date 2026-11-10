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
  getAllPendingInvitations,
  findInvitationByToken,
  consumeInvitation,
  deleteInvitationByToken,
  pendingInvitationsFor,
  invitationOrgSlot,
  isPlatformInvitation,
  deleteInvitationsInOrg,
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
      findMany: vi.fn(),
      count: vi.fn(),
      deleteMany: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
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
    it('should return true when a row matches the token hash', async () => {
      const email = 'user@example.com';
      const token = randomBytes(32).toString('hex');
      vi.mocked(prisma.verification.findFirst).mockResolvedValue({ id: 'row-1' } as never);

      const result = await validateInvitationToken(email, token);

      expect(result).toBe(true); // test-review:accept tobe_true — boolean return type; false is the failure case tested separately
    });

    it('should query by identifier, token hash and unexpired, selecting only the id', async () => {
      // Arrange
      const email = 'test@example.com';
      const token = randomBytes(32).toString('hex');
      vi.mocked(prisma.verification.findFirst).mockResolvedValue({ id: 'row-1' } as never);

      // Act
      await validateInvitationToken(email, token);

      // Assert: the hash goes into the query, not the plaintext
      expect(prisma.verification.findFirst).toHaveBeenCalledWith({
        where: {
          identifier: `invitation:${email}`,
          value: createHash('sha256').update(token).digest('hex'),
          expiresAt: { gt: expect.any(Date) },
        },
        select: { id: true },
      });
    });

    it('should query a different hash for a different token', async () => {
      // Arrange
      const email = 'user@example.com';
      const tokenA = randomBytes(32).toString('hex');
      const tokenB = randomBytes(32).toString('hex');
      vi.mocked(prisma.verification.findFirst).mockResolvedValue(null);

      // Act
      await validateInvitationToken(email, tokenA);
      await validateInvitationToken(email, tokenB);

      // Assert
      const calls = vi.mocked(prisma.verification.findFirst).mock.calls;
      expect(calls[0][0]?.where?.value).toBe(createHash('sha256').update(tokenA).digest('hex'));
      expect(calls[1][0]?.where?.value).toBe(createHash('sha256').update(tokenB).digest('hex'));
      expect(calls[0][0]?.where?.value).not.toBe(calls[1][0]?.where?.value);
    });

    it('should log successful validation', async () => {
      const email = 'user@example.com';
      vi.mocked(prisma.verification.findFirst).mockResolvedValue({ id: 'row-1' } as never);

      await validateInvitationToken(email, randomBytes(32).toString('hex'));

      expect(logger.info).toHaveBeenCalledWith('Invitation token validated', { email });
    });
  });

  describe('invalid or expired token', () => {
    it('should return false when no row matches (wrong token or expired, both filtered in the query)', async () => {
      vi.mocked(prisma.verification.findFirst).mockResolvedValue(null);

      const result = await validateInvitationToken(
        'user@example.com',
        randomBytes(32).toString('hex')
      );

      expect(result).toBe(false);
    });

    it('should log warning when no row matches', async () => {
      const email = 'user@example.com';
      vi.mocked(prisma.verification.findFirst).mockResolvedValue(null);

      await validateInvitationToken(email, randomBytes(32).toString('hex'));

      expect(logger.warn).toHaveBeenCalledWith(
        'Invitation token not found, expired or mismatched',
        { email }
      );
    });

    it('should ask the database for unexpired rows only', async () => {
      vi.mocked(prisma.verification.findFirst).mockResolvedValue(null);
      const before = Date.now();

      await validateInvitationToken('user@example.com', randomBytes(32).toString('hex'));

      const gt = vi.mocked(prisma.verification.findFirst).mock.calls[0][0]?.where?.expiresAt as {
        gt: Date;
      };
      expect(gt.gt.getTime()).toBeGreaterThanOrEqual(before);
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

    it('should return null and log warning when record has invalid metadata', async () => {
      // Arrange: parseInvitationMetadata returns null for corrupt/missing metadata fields
      const email = 'user@example.com';
      vi.mocked(prisma.verification.findFirst).mockResolvedValue({
        id: 'verification-123',
        identifier: `invitation:${email}`,
        value: 'hashed-token',
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        createdAt: new Date(),
        updatedAt: new Date(),
        metadata: { corrupt: true }, // Does not conform to InvitationMetadata schema
      });

      // Act
      const result = await getValidInvitation(email);

      // Assert: Invalid metadata should produce null result and a warning log
      expect(result).toBeNull();
      expect(logger.warn).toHaveBeenCalledWith('Invalid invitation metadata', { email });
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
    const mockCreate = () =>
      vi.mocked(prisma.verification.create).mockResolvedValue({
        id: 'verification-new',
        identifier: 'invitation:user@example.com',
        value: 'new-hashed-token',
        expiresAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
        metadata: null,
      });

    it('should delete the same-org row and create a new one', async () => {
      // Arrange
      const email = 'user@example.com';
      const metadata = { ...createMockMetadata(), orgId: 'org-a' };
      vi.mocked(prisma.verification.findMany).mockResolvedValue([
        { id: 'row-a', metadata: { ...createMockMetadata(), orgId: 'org-a' } },
      ] as never);
      vi.mocked(prisma.verification.deleteMany).mockResolvedValue({ count: 1 });
      mockCreate();

      // Act
      const token = await updateInvitationToken(email, metadata);

      // Assert
      expect(token).toMatch(/^[a-f0-9]{64}$/);
      expect(prisma.verification.findMany).toHaveBeenCalledWith({
        where: { identifier: `invitation:${email}` },
        select: { id: true, metadata: true },
      });
      expect(prisma.verification.deleteMany).toHaveBeenCalledWith({
        where: { id: { in: ['row-a'] } },
      });
      expect(prisma.verification.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            identifier: `invitation:${email}`,
            metadata: expect.objectContaining({ orgId: 'org-a', role: metadata.role }),
          }),
        })
      );
    });

    it("should leave another org's row alone", async () => {
      // Arrange
      const email = 'user@example.com';
      vi.mocked(prisma.verification.findMany).mockResolvedValue([
        { id: 'row-a', metadata: { ...createMockMetadata(), orgId: 'org-a' } },
        { id: 'row-b', metadata: { ...createMockMetadata(), orgId: 'org-b' } },
      ] as never);
      vi.mocked(prisma.verification.deleteMany).mockResolvedValue({ count: 1 });
      mockCreate();

      // Act
      await updateInvitationToken(email, { ...createMockMetadata(), orgId: 'org-a' });

      // Assert: only org-a's row is deleted
      expect(prisma.verification.deleteMany).toHaveBeenCalledTimes(1);
      expect(prisma.verification.deleteMany).toHaveBeenCalledWith({
        where: { id: { in: ['row-a'] } },
      });
    });

    it('should leave a row whose metadata cannot be read alone', async () => {
      // Arrange
      const email = 'user@example.com';
      vi.mocked(prisma.verification.findMany).mockResolvedValue([
        { id: 'row-bad', metadata: { garbage: true } },
        { id: 'row-null', metadata: null },
        { id: 'row-a', metadata: { ...createMockMetadata(), orgId: 'org-a' } },
      ] as never);
      vi.mocked(prisma.verification.deleteMany).mockResolvedValue({ count: 1 });
      mockCreate();

      // Act
      await updateInvitationToken(email, { ...createMockMetadata(), orgId: 'org-a' });

      // Assert
      expect(prisma.verification.deleteMany).toHaveBeenCalledWith({
        where: { id: { in: ['row-a'] } },
      });
    });

    it('should treat an absent orgId as matching an absent orgId only', async () => {
      // Arrange
      const email = 'user@example.com';
      vi.mocked(prisma.verification.findMany).mockResolvedValue([
        { id: 'row-platform', metadata: createMockMetadata() },
        { id: 'row-org', metadata: { ...createMockMetadata(), orgId: 'org-a' } },
      ] as never);
      vi.mocked(prisma.verification.deleteMany).mockResolvedValue({ count: 1 });
      mockCreate();

      // Act
      await updateInvitationToken(email, createMockMetadata());

      // Assert
      expect(prisma.verification.deleteMany).toHaveBeenCalledWith({
        where: { id: { in: ['row-platform'] } },
      });
    });

    it('should count the install org named and absent as one org', async () => {
      // Arrange: one install-org row written without orgId, one naming it
      const email = 'user@example.com';
      vi.mocked(prisma.verification.findMany).mockResolvedValue([
        { id: 'row-absent', metadata: createMockMetadata() },
        { id: 'row-named', metadata: { ...createMockMetadata(), orgId: 'install' } },
        { id: 'row-a', metadata: { ...createMockMetadata(), orgId: 'org-a' } },
      ] as never);
      vi.mocked(prisma.verification.deleteMany).mockResolvedValue({ count: 2 });
      mockCreate();

      // Act
      await updateInvitationToken(email, { ...createMockMetadata(), orgId: 'install' });

      // Assert: both install-org rows replaced, org-a's left
      expect(prisma.verification.deleteMany).toHaveBeenCalledWith({
        where: { id: { in: ['row-absent', 'row-named'] } },
      });
    });

    it('should skip the delete when there is nothing to replace', async () => {
      // Arrange
      vi.mocked(prisma.verification.findMany).mockResolvedValue([
        { id: 'row-b', metadata: { ...createMockMetadata(), orgId: 'org-b' } },
      ] as never);
      mockCreate();

      // Act
      await updateInvitationToken('user@example.com', {
        ...createMockMetadata(),
        orgId: 'org-a',
      });

      // Assert
      expect(prisma.verification.deleteMany).not.toHaveBeenCalled();
      expect(prisma.verification.create).toHaveBeenCalledTimes(1);
    });

    it('should log token regeneration with org and replaced count', async () => {
      // Arrange
      const email = 'user@example.com';
      vi.mocked(prisma.verification.findMany).mockResolvedValue([
        { id: 'row-a', metadata: { ...createMockMetadata(), orgId: 'org-a' } },
      ] as never);
      vi.mocked(prisma.verification.deleteMany).mockResolvedValue({ count: 1 });
      mockCreate();

      // Act
      await updateInvitationToken(email, { ...createMockMetadata(), orgId: 'org-a' });

      // Assert
      expect(logger.info).toHaveBeenCalledWith('Invitation token updated (regenerated)', {
        email,
        orgId: 'org-a',
        replaced: 1,
      });
    });

    it('should store only the hash of the returned token', async () => {
      // Arrange
      vi.mocked(prisma.verification.findMany).mockResolvedValue([]);
      mockCreate();

      // Act
      const newToken = await updateInvitationToken('user@example.com', createMockMetadata());

      // Assert
      const stored = vi.mocked(prisma.verification.create).mock.calls[0][0].data.value;
      expect(stored).not.toBe(newToken);
      expect(stored).toBe(createHash('sha256').update(newToken).digest('hex'));
    });
  });

  describe('error handling', () => {
    it('should propagate error if the lookup fails', async () => {
      vi.mocked(prisma.verification.findMany).mockRejectedValue(new Error('Read failed'));

      await expect(updateInvitationToken('user@example.com', createMockMetadata())).rejects.toThrow(
        'Read failed'
      );
      expect(prisma.verification.create).not.toHaveBeenCalled();
    });

    it('should propagate error if delete fails and not create a new row', async () => {
      // Arrange
      vi.mocked(prisma.verification.findMany).mockResolvedValue([
        { id: 'row-a', metadata: createMockMetadata() },
      ] as never);
      vi.mocked(prisma.verification.deleteMany).mockRejectedValue(new Error('Delete failed'));

      // Act & Assert
      await expect(updateInvitationToken('user@example.com', createMockMetadata())).rejects.toThrow(
        'Delete failed'
      );
      expect(prisma.verification.create).not.toHaveBeenCalled();
    });

    it('should propagate error if create fails', async () => {
      // Arrange
      vi.mocked(prisma.verification.findMany).mockResolvedValue([]);
      vi.mocked(prisma.verification.create).mockRejectedValue(new Error('Create failed'));

      // Act & Assert
      await expect(updateInvitationToken('user@example.com', createMockMetadata())).rejects.toThrow(
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
    it('should return invalid_token when the address holds invitations but none with this token', async () => {
      // Arrange: the token's own row is absent, other rows for the address exist
      const email = 'user@example.com';
      const wrongToken = randomBytes(32).toString('hex');
      vi.mocked(prisma.verification.findFirst).mockResolvedValue(null);
      vi.mocked(prisma.verification.count).mockResolvedValue(2);

      // Act
      const result = await getInvitationMetadata(email, wrongToken);

      // Assert
      expect(result).toEqual({ valid: false, reason: 'invalid_token' });
      expect(prisma.verification.count).toHaveBeenCalledWith({
        where: { identifier: `invitation:${email}` },
      });
    });

    it('should look the row up by the token hash, with no expiry filter', async () => {
      // Arrange
      const email = 'user@example.com';
      const token = randomBytes(32).toString('hex');
      vi.mocked(prisma.verification.findFirst).mockResolvedValue(null);
      vi.mocked(prisma.verification.count).mockResolvedValue(0);

      // Act
      await getInvitationMetadata(email, token);

      // Assert: expired rows must be reachable so the caller can say "expired"
      const where = vi.mocked(prisma.verification.findFirst).mock.calls[0][0]?.where;
      expect(where).toEqual({
        identifier: `invitation:${email}`,
        value: createHash('sha256').update(token).digest('hex'),
      });
    });

    it('should log warning when token mismatch', async () => {
      // Arrange
      const email = 'user@example.com';
      vi.mocked(prisma.verification.findFirst).mockResolvedValue(null);
      vi.mocked(prisma.verification.count).mockResolvedValue(1);

      // Act
      await getInvitationMetadata(email, randomBytes(32).toString('hex'));

      // Assert
      expect(logger.warn).toHaveBeenCalledWith('Invitation token mismatch for metadata lookup', {
        email,
      });
    });

    it('should return the row the token matches, not a newer row for another org', async () => {
      // Arrange: lookup is by hash, so the older org-A row is what comes back
      const email = 'user@example.com';
      const token = randomBytes(32).toString('hex');
      const metadata = { ...createMockMetadata(), orgId: 'org-a' };
      vi.mocked(prisma.verification.findFirst).mockResolvedValue({
        ...createMockVerification(email, token, 7),
        metadata,
      });

      // Act
      const result = await getInvitationMetadata(email, token);

      // Assert
      expect(result).toMatchObject({ valid: true, metadata: { orgId: 'org-a' } });
      expect(prisma.verification.count).not.toHaveBeenCalled();
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
 * Test Suite: getAllPendingInvitations()
 */
describe('getAllPendingInvitations()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const makeVerification = (email: string, metadata: object) => ({
    id: `verification-${email}`,
    identifier: `invitation:${email}`,
    value: 'hashed-token',
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
    metadata,
  });

  describe('happy path', () => {
    it('should return invitations and total when records exist', async () => {
      // Arrange
      const invitedAt = new Date('2024-01-01T00:00:00Z').toISOString();
      const verification = makeVerification('alice@example.com', {
        name: 'Alice',
        role: 'USER',
        invitedBy: 'admin-123',
        invitedAt,
      });

      vi.mocked(prisma.verification.findMany).mockResolvedValue([verification]);
      vi.mocked(prisma.verification.count).mockResolvedValue(1);
      vi.mocked(prisma.user.findUnique).mockResolvedValue({ name: 'Admin User' } as any);

      // Act
      const result = await getAllPendingInvitations();

      // Assert
      expect(result.total).toBe(1);
      expect(result.invitations).toHaveLength(1);
      expect(result.invitations[0]).toMatchObject({
        email: 'alice@example.com',
        name: 'Alice',
        role: 'USER',
        invitedBy: 'admin-123',
        invitedByName: 'Admin User',
      });
    });

    it('should carry the org slot and org role on each item', async () => {
      // Arrange: one org row with a role, one install-org row named, one with no org
      const base = {
        name: 'N',
        role: 'USER',
        invitedBy: 'admin-123',
        invitedAt: '2024-01-01T00:00:00Z',
      };
      vi.mocked(prisma.verification.findMany).mockResolvedValue([
        makeVerification('a@example.com', { ...base, orgId: 'org-a', orgRole: 'ADMIN' }),
        makeVerification('b@example.com', { ...base, orgId: 'install' }),
        makeVerification('c@example.com', base),
      ]);
      vi.mocked(prisma.verification.count).mockResolvedValue(3);
      vi.mocked(prisma.user.findUnique).mockResolvedValue(null);

      // Act
      const result = await getAllPendingInvitations();

      // Assert: raw metadata is turned into the slot (null = install org) and a nullable role
      const byEmail = Object.fromEntries(result.invitations.map((i) => [i.email, i]));
      expect(byEmail['a@example.com']).toMatchObject({ orgId: 'org-a', orgRole: 'ADMIN' });
      expect(byEmail['b@example.com']).toMatchObject({ orgId: null, orgRole: null });
      expect(byEmail['c@example.com']).toMatchObject({ orgId: null, orgRole: null });
    });

    it('should return empty list when no pending invitations exist', async () => {
      // Arrange
      vi.mocked(prisma.verification.findMany).mockResolvedValue([]);
      vi.mocked(prisma.verification.count).mockResolvedValue(0);

      // Act
      const result = await getAllPendingInvitations();

      // Assert
      expect(result.total).toBe(0);
      expect(result.invitations).toHaveLength(0);
    });

    it('should skip records with invalid metadata', async () => {
      // Arrange: One valid, one corrupt
      const invitedAt = new Date().toISOString();
      const valid = makeVerification('alice@example.com', {
        name: 'Alice',
        role: 'USER',
        invitedBy: 'admin-123',
        invitedAt,
      });
      const corrupt = makeVerification('broken@example.com', { corrupt: true });

      vi.mocked(prisma.verification.findMany).mockResolvedValue([valid, corrupt]);
      vi.mocked(prisma.verification.count).mockResolvedValue(2);
      vi.mocked(prisma.user.findUnique).mockResolvedValue(null);

      // Act
      const result = await getAllPendingInvitations();

      // Assert: corrupt record is silently skipped; total reflects DB count (unfiltered)
      expect(result.invitations).toHaveLength(1);
      expect(result.invitations[0].email).toBe('alice@example.com');
    });

    it('should apply search filter across email and name', async () => {
      // Arrange
      const invitedAt = new Date().toISOString();
      const alice = makeVerification('alice@example.com', {
        name: 'Alice Smith',
        role: 'USER',
        invitedBy: 'admin-123',
        invitedAt,
      });
      const bob = makeVerification('bob@example.com', {
        name: 'Bob Jones',
        role: 'USER',
        invitedBy: 'admin-123',
        invitedAt,
      });

      vi.mocked(prisma.verification.findMany).mockResolvedValue([alice, bob]);
      vi.mocked(prisma.verification.count).mockResolvedValue(2);
      vi.mocked(prisma.user.findUnique).mockResolvedValue(null);

      // Act
      const result = await getAllPendingInvitations({ search: 'alice' });

      // Assert: Only alice matches the search
      expect(result.invitations).toHaveLength(1);
      expect(result.invitations[0].email).toBe('alice@example.com');
      expect(result.total).toBe(1); // filtered total
    });

    it('should paginate results', async () => {
      // Arrange: 3 invitations, page 2 of limit 2 should return only the 3rd
      const invitedAt = new Date().toISOString();
      const verifications = ['a@example.com', 'b@example.com', 'c@example.com'].map((email) =>
        makeVerification(email, { name: email, role: 'USER', invitedBy: 'admin-123', invitedAt })
      );

      vi.mocked(prisma.verification.findMany).mockResolvedValue(verifications);
      vi.mocked(prisma.verification.count).mockResolvedValue(3);
      vi.mocked(prisma.user.findUnique).mockResolvedValue(null);

      // Act
      const result = await getAllPendingInvitations({ page: 2, limit: 2 });

      // Assert
      expect(result.invitations).toHaveLength(1);
      expect(result.total).toBe(3);
    });

    it('should query only non-expired invitations with the correct identifier prefix', async () => {
      // Arrange
      vi.mocked(prisma.verification.findMany).mockResolvedValue([]);
      vi.mocked(prisma.verification.count).mockResolvedValue(0);

      // Act
      await getAllPendingInvitations();

      // Assert: Both queries use the same base where clause
      const expectedWhere = expect.objectContaining({
        identifier: { startsWith: 'invitation:' },
        expiresAt: { gt: expect.any(Date) },
      });
      expect(prisma.verification.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expectedWhere })
      );
      expect(prisma.verification.count).toHaveBeenCalledWith(
        expect.objectContaining({ where: expectedWhere })
      );
    });
  });

  describe('error handling', () => {
    it('should throw when the database query fails', async () => {
      // Arrange
      const dbError = new Error('Connection refused');
      vi.mocked(prisma.verification.findMany).mockRejectedValue(dbError);
      vi.mocked(prisma.verification.count).mockResolvedValue(0);

      // Act & Assert
      await expect(getAllPendingInvitations()).rejects.toThrow(
        'Failed to fetch pending invitations'
      );
    });

    it('should log error when database query fails', async () => {
      // Arrange
      const dbError = new Error('Connection refused');
      vi.mocked(prisma.verification.findMany).mockRejectedValue(dbError);
      vi.mocked(prisma.verification.count).mockResolvedValue(0);

      // Act
      try {
        await getAllPendingInvitations();
      } catch {
        // Expected to throw
      }

      // Assert
      expect(logger.error).toHaveBeenCalledWith('Failed to fetch pending invitations', dbError);
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
    expect(isValid).toBe(true); // test-review:accept tobe_true — end-to-end workflow; generate→validate→delete asserts the full flow succeeds
    expect(prisma.verification.deleteMany).toHaveBeenCalledWith({
      where: {
        identifier: `invitation:${email}`,
      },
    });
  });
});

/**
 * Test Suite: findInvitationByToken(), consumeInvitation(), deleteInvitationByToken(),
 * pendingInvitationsFor()
 */
describe('findInvitationByToken()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return the id, parsed metadata and expiry of the row the token matches', async () => {
    // Arrange
    const email = 'user@example.com';
    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 86400000);
    const metadata = { ...createMockMetadata(), orgId: 'org-a', orgRole: 'ADMIN' as const };
    vi.mocked(prisma.verification.findFirst).mockResolvedValue({
      id: 'row-1',
      metadata,
      expiresAt,
    } as never);

    // Act
    const found = await findInvitationByToken(email, token);

    // Assert
    expect(found).toEqual({ id: 'row-1', metadata, expiresAt });
    expect(prisma.verification.findFirst).toHaveBeenCalledWith({
      where: {
        identifier: `invitation:${email}`,
        value: createHash('sha256').update(token).digest('hex'),
        expiresAt: { gt: expect.any(Date) },
      },
      select: { id: true, metadata: true, expiresAt: true },
    });
  });

  it('should return null metadata, not null, when the row is valid but unreadable', async () => {
    const expiresAt = new Date(Date.now() + 86400000);
    vi.mocked(prisma.verification.findFirst).mockResolvedValue({
      id: 'row-1',
      metadata: { nonsense: 1 },
      expiresAt,
    } as never);

    const found = await findInvitationByToken('user@example.com', 'tok');

    expect(found).toEqual({ id: 'row-1', metadata: null, expiresAt });
  });

  it('should return null when no row matches', async () => {
    vi.mocked(prisma.verification.findFirst).mockResolvedValue(null);

    expect(await findInvitationByToken('user@example.com', 'tok')).toBeNull();
  });
});

describe('consumeInvitation()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should delete by id and answer true when a row went', async () => {
    vi.mocked(prisma.verification.deleteMany).mockResolvedValue({ count: 1 });

    const result = await consumeInvitation('row-1');

    expect(result).toBe(true); // test-review:accept tobe_true — boolean discriminator, false tested next
    expect(prisma.verification.deleteMany).toHaveBeenCalledWith({ where: { id: 'row-1' } });
  });

  it('should answer false when another request already deleted the row', async () => {
    vi.mocked(prisma.verification.deleteMany).mockResolvedValue({ count: 0 });

    expect(await consumeInvitation('row-1')).toBe(false);
  });
});

describe('deleteInvitationByToken()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should delete only the row matching the identifier and token hash, expired or not', async () => {
    // Arrange
    const email = 'user@example.com';
    const token = randomBytes(32).toString('hex');
    vi.mocked(prisma.verification.deleteMany).mockResolvedValue({ count: 1 });

    // Act
    const result = await deleteInvitationByToken(email, token);

    // Assert
    expect(result).toBe(true); // test-review:accept tobe_true — boolean discriminator, false tested next
    expect(prisma.verification.deleteMany).toHaveBeenCalledWith({
      where: {
        identifier: `invitation:${email}`,
        value: createHash('sha256').update(token).digest('hex'),
      },
    });
  });

  it('should answer false and log deleted:false when nothing matched', async () => {
    vi.mocked(prisma.verification.deleteMany).mockResolvedValue({ count: 0 });

    const result = await deleteInvitationByToken('user@example.com', 'tok');

    expect(result).toBe(false);
    expect(logger.info).toHaveBeenCalledWith('Invitation deleted by token', {
      email: 'user@example.com',
      deleted: false,
    });
  });
});

describe('pendingInvitationsFor()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const row = (id: string, metadata: unknown) => ({
    id,
    identifier: 'invitation:user@example.com',
    value: `hash-${id}`,
    expiresAt: new Date(Date.now() + 86400000),
    createdAt: new Date(),
    updatedAt: new Date(),
    metadata,
  });

  it('should split rows into readable records (with id) and an unreadable count', async () => {
    // Arrange
    const email = 'user@example.com';
    const good = { ...createMockMetadata(), orgId: 'org-a' };
    vi.mocked(prisma.verification.findMany).mockResolvedValue([
      row('r1', good),
      row('r2', { garbage: true }),
      row('r3', null),
      row('r4', { ...createMockMetadata(), orgId: 'org-b' }),
    ] as never);

    // Act
    const result = await pendingInvitationsFor(email);

    // Assert
    expect(result.unreadable).toBe(2);
    expect(result.readable.map((r) => [r.id, r.metadata.orgId, r.email])).toEqual([
      ['r1', 'org-a', email],
      ['r4', 'org-b', email],
    ]);
    expect(prisma.verification.findMany).toHaveBeenCalledWith({
      where: { identifier: `invitation:${email}`, expiresAt: { gt: expect.any(Date) } },
      orderBy: { createdAt: 'desc' },
    });
  });

  it('should return an empty result when there are no rows', async () => {
    vi.mocked(prisma.verification.findMany).mockResolvedValue([]);

    expect(await pendingInvitationsFor('user@example.com')).toEqual({
      readable: [],
      unreadable: 0,
    });
  });

  it('should throw on a failed read rather than answer "none"', async () => {
    vi.mocked(prisma.verification.findMany).mockRejectedValue(new Error('db down'));

    await expect(pendingInvitationsFor('user@example.com')).rejects.toThrow('db down');
  });
});

describe('invitationOrgSlot()', () => {
  it.each([
    ['org-a', 'org-a'],
    ['install', null],
    [null, null],
    [undefined, null],
    ['', null],
  ])('maps %j to %j', (orgId, expected) => {
    expect(invitationOrgSlot(orgId)).toBe(expected);
  });
});

describe('deleteInvitationsInOrg()', () => {
  const email = 'user@example.com';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should look rows up by the address and delete only the named org rows by id', async () => {
    // Arrange
    vi.mocked(prisma.verification.findMany).mockResolvedValue([
      { id: 'row-a', metadata: { ...createMockMetadata(), orgId: 'org-a' } },
      { id: 'row-b', metadata: { ...createMockMetadata(), orgId: 'org-b' } },
      { id: 'row-none', metadata: createMockMetadata() },
    ] as never);
    vi.mocked(prisma.verification.deleteMany).mockResolvedValue({ count: 1 });

    // Act
    const count = await deleteInvitationsInOrg(email, 'org-a');

    // Assert
    expect(count).toBe(1);
    expect(prisma.verification.findMany).toHaveBeenCalledWith({
      where: { identifier: `invitation:${email}` },
      select: { id: true, metadata: true },
    });
    expect(prisma.verification.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['row-a'] } },
    });
    expect(logger.info).toHaveBeenCalledWith('Invitations deleted for one org', {
      email,
      orgId: 'org-a',
      count: 1,
    });
  });

  it('should delete both absent and "install" rows when the org is null, and leave named orgs', async () => {
    vi.mocked(prisma.verification.findMany).mockResolvedValue([
      { id: 'row-absent', metadata: createMockMetadata() },
      { id: 'row-named', metadata: { ...createMockMetadata(), orgId: 'install' } },
      { id: 'row-a', metadata: { ...createMockMetadata(), orgId: 'org-a' } },
    ] as never);
    vi.mocked(prisma.verification.deleteMany).mockResolvedValue({ count: 2 });

    const count = await deleteInvitationsInOrg(email, null);

    expect(count).toBe(2);
    expect(prisma.verification.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['row-absent', 'row-named'] } },
    });
  });

  it('should treat the string "install" as the install org', async () => {
    vi.mocked(prisma.verification.findMany).mockResolvedValue([
      { id: 'row-absent', metadata: createMockMetadata() },
      { id: 'row-a', metadata: { ...createMockMetadata(), orgId: 'org-a' } },
    ] as never);
    vi.mocked(prisma.verification.deleteMany).mockResolvedValue({ count: 1 });

    await deleteInvitationsInOrg(email, 'install');

    expect(prisma.verification.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['row-absent'] } },
    });
  });

  it('should leave a row whose metadata cannot be read', async () => {
    vi.mocked(prisma.verification.findMany).mockResolvedValue([
      { id: 'row-corrupt', metadata: { corrupt: true } },
      { id: 'row-null', metadata: null },
      { id: 'row-a', metadata: { ...createMockMetadata(), orgId: 'org-a' } },
    ] as never);
    vi.mocked(prisma.verification.deleteMany).mockResolvedValue({ count: 1 });

    await deleteInvitationsInOrg(email, 'org-a');

    expect(prisma.verification.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['row-a'] } },
    });
  });

  it('should answer 0 without calling deleteMany when no row is in that org', async () => {
    vi.mocked(prisma.verification.findMany).mockResolvedValue([
      { id: 'row-b', metadata: { ...createMockMetadata(), orgId: 'org-b' } },
    ] as never);

    const count = await deleteInvitationsInOrg(email, 'org-a');

    expect(count).toBe(0);
    expect(prisma.verification.deleteMany).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });
});

describe('isPlatformInvitation (#1199)', () => {
  it.each([
    ['a platform role into a named org', { role: 'ADMIN', orgId: 'org-a' }, true],
    ['no org', { role: 'USER' }, true],
    ['the install org named', { role: 'USER', orgId: 'install' }, true],
    // Code review finding (t-1006): the page and the accept route disagreed here.
    ['an empty org id', { role: 'USER', orgId: '' }, true],
    ['a USER invitation into a named org', { role: 'USER', orgId: 'org-a' }, false],
  ])('%s → %s', (_label, metadata, expected) => {
    expect(isPlatformInvitation(metadata)).toBe(expected);
  });
});
