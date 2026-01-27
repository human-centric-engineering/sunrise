/**
 * Unit Tests for Email Verification Status Utility
 *
 * Tests for getVerificationStatus function that determines email verification state.
 *
 * Coverage:
 * - Returns 'verified' when emailVerified is true
 * - Returns 'pending' when verification token exists and is not expired
 * - Returns 'not_sent' when no verification token exists
 * - Handles expired tokens correctly (treated as not_sent)
 * - Database errors are propagated
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getVerificationStatus } from '@/lib/auth/verification-status';
import type { VerificationStatus } from '@/lib/auth/verification-status';

// Mock Prisma client
vi.mock('@/lib/db/client', () => ({
  prisma: {
    verification: {
      findFirst: vi.fn(),
    },
  },
}));

// Import after mocking
import { prisma } from '@/lib/db/client';

describe('lib/auth/verification-status', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getVerificationStatus', () => {
    const testEmail = 'user@example.com';

    describe('verified state', () => {
      it('should return "verified" when emailVerified is true', async () => {
        // Act
        const status = await getVerificationStatus(testEmail, true);

        // Assert
        expect(status).toBe('verified');
        // Should not query database if already verified
        expect(prisma.verification.findFirst).not.toHaveBeenCalled();
      });

      it('should return "verified" immediately without database query', async () => {
        // Act
        const status = await getVerificationStatus('any@example.com', true);

        // Assert
        expect(status).toBe('verified');
        expect(prisma.verification.findFirst).not.toHaveBeenCalled();
      });
    });

    describe('pending state', () => {
      it('should return "pending" when non-expired verification token exists', async () => {
        // Arrange: Mock valid token
        const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours in future
        vi.mocked(prisma.verification.findFirst).mockResolvedValue({
          id: 'token-id',
          identifier: testEmail,
          value: 'hashed-token',
          expiresAt: futureDate,
          createdAt: new Date(),
          updatedAt: new Date(),
          metadata: null,
        });

        // Act
        const status = await getVerificationStatus(testEmail, false);

        // Assert
        expect(status).toBe('pending');
        expect(prisma.verification.findFirst).toHaveBeenCalledWith({
          where: {
            identifier: testEmail,
            expiresAt: { gt: expect.any(Date) },
          },
          select: { id: true },
        });
      });

      it('should query database with correct email identifier', async () => {
        // Arrange
        vi.mocked(prisma.verification.findFirst).mockResolvedValue({
          id: 'token-id',
          identifier: 'test@example.com',
          value: 'hashed-token',
          expiresAt: new Date(Date.now() + 1000),
          createdAt: new Date(),
          updatedAt: new Date(),
          metadata: null,
        });

        // Act
        await getVerificationStatus('test@example.com', false);

        // Assert
        expect(prisma.verification.findFirst).toHaveBeenCalledWith({
          where: {
            identifier: 'test@example.com',
            expiresAt: { gt: expect.any(Date) },
          },
          select: { id: true },
        });
      });

      it('should only select token id for efficiency', async () => {
        // Arrange
        vi.mocked(prisma.verification.findFirst).mockResolvedValue({
          id: 'token-id',
          identifier: testEmail,
          value: 'hashed-token',
          expiresAt: new Date(Date.now() + 1000),
          createdAt: new Date(),
          updatedAt: new Date(),
          metadata: null,
        });

        // Act
        await getVerificationStatus(testEmail, false);

        // Assert: Only id is selected
        expect(prisma.verification.findFirst).toHaveBeenCalledWith(
          expect.objectContaining({
            select: { id: true },
          })
        );
      });
    });

    describe('not_sent state', () => {
      it('should return "not_sent" when no verification token exists', async () => {
        // Arrange: No token found
        vi.mocked(prisma.verification.findFirst).mockResolvedValue(null);

        // Act
        const status = await getVerificationStatus(testEmail, false);

        // Assert
        expect(status).toBe('not_sent');
      });

      it('should return "not_sent" for unverified email with no token', async () => {
        // Arrange
        vi.mocked(prisma.verification.findFirst).mockResolvedValue(null);

        // Act
        const status = await getVerificationStatus('newuser@example.com', false);

        // Assert
        expect(status).toBe('not_sent');
      });
    });

    describe('expired tokens', () => {
      it('should return "not_sent" when token exists but is expired', async () => {
        // Arrange: Token expired in the past
        // The query filters expired tokens with expiresAt > now, so findFirst returns null
        vi.mocked(prisma.verification.findFirst).mockResolvedValue(null);

        // Act
        const status = await getVerificationStatus(testEmail, false);

        // Assert
        expect(status).toBe('not_sent');
      });

      it('should filter expired tokens using gt (greater than) filter', async () => {
        // Arrange
        vi.mocked(prisma.verification.findFirst).mockResolvedValue(null);
        const beforeCall = Date.now();

        // Act
        await getVerificationStatus(testEmail, false);
        const afterCall = Date.now();

        // Assert: Query should use gt filter with current time
        expect(prisma.verification.findFirst).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({
              expiresAt: {
                gt: expect.any(Date),
              },
            }),
          })
        );

        // Verify the date is current (within test execution time)
        const call = vi.mocked(prisma.verification.findFirst).mock.calls[0]?.[0];
        if (
          call?.where?.expiresAt &&
          typeof call.where.expiresAt === 'object' &&
          'gt' in call.where.expiresAt
        ) {
          const queryDate = (call.where.expiresAt.gt as Date).getTime();
          expect(queryDate).toBeGreaterThanOrEqual(beforeCall);
          expect(queryDate).toBeLessThanOrEqual(afterCall);
        }
      });
    });

    describe('edge cases', () => {
      it('should handle empty email string', async () => {
        // Arrange
        vi.mocked(prisma.verification.findFirst).mockResolvedValue(null);

        // Act
        const status = await getVerificationStatus('', false);

        // Assert
        expect(status).toBe('not_sent');
        expect(prisma.verification.findFirst).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({
              identifier: '',
            }),
          })
        );
      });

      it('should handle email with special characters', async () => {
        // Arrange
        const specialEmail = 'user+test@example.com';
        vi.mocked(prisma.verification.findFirst).mockResolvedValue(null);

        // Act
        const status = await getVerificationStatus(specialEmail, false);

        // Assert
        expect(status).toBe('not_sent');
        expect(prisma.verification.findFirst).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({
              identifier: specialEmail,
            }),
          })
        );
      });

      it('should return correct type annotation', async () => {
        // Arrange
        vi.mocked(prisma.verification.findFirst).mockResolvedValue(null);

        // Act
        const status: VerificationStatus = await getVerificationStatus(testEmail, false);

        // Assert: Type check - should compile
        expect(['verified', 'pending', 'not_sent']).toContain(status);
      });
    });

    describe('database errors', () => {
      it('should propagate database connection errors', async () => {
        // Arrange: Database throws error
        const dbError = new Error('Database connection failed');
        vi.mocked(prisma.verification.findFirst).mockRejectedValue(dbError);

        // Act & Assert
        await expect(getVerificationStatus(testEmail, false)).rejects.toThrow(
          'Database connection failed'
        );
      });

      it('should propagate query errors', async () => {
        // Arrange
        const queryError = new Error('Invalid query');
        vi.mocked(prisma.verification.findFirst).mockRejectedValue(queryError);

        // Act & Assert
        await expect(getVerificationStatus(testEmail, false)).rejects.toThrow('Invalid query');
      });

      it('should not query database when emailVerified=true even if error would occur', async () => {
        // Arrange: Setup to throw error if called
        vi.mocked(prisma.verification.findFirst).mockRejectedValue(
          new Error('Should not be called')
        );

        // Act: Should not throw because we skip database query
        const status = await getVerificationStatus(testEmail, true);

        // Assert
        expect(status).toBe('verified');
        expect(prisma.verification.findFirst).not.toHaveBeenCalled();
      });
    });

    describe('concurrent calls', () => {
      it('should handle multiple concurrent calls correctly', async () => {
        // Arrange
        vi.mocked(prisma.verification.findFirst).mockResolvedValue({
          id: 'token-id',
          identifier: testEmail,
          value: 'hashed-token',
          expiresAt: new Date(Date.now() + 1000),
          createdAt: new Date(),
          updatedAt: new Date(),
          metadata: null,
        });

        // Act: Call function multiple times concurrently
        const results = await Promise.all([
          getVerificationStatus(testEmail, false),
          getVerificationStatus(testEmail, false),
          getVerificationStatus(testEmail, false),
        ]);

        // Assert: All should return same status
        expect(results).toEqual(['pending', 'pending', 'pending']);
        expect(prisma.verification.findFirst).toHaveBeenCalledTimes(3);
      });

      it('should handle mixed verified and unverified calls', async () => {
        // Arrange
        vi.mocked(prisma.verification.findFirst).mockResolvedValue(null);

        // Act
        const results = await Promise.all([
          getVerificationStatus(testEmail, true), // verified
          getVerificationStatus(testEmail, false), // unverified
          getVerificationStatus(testEmail, true), // verified
        ]);

        // Assert
        expect(results).toEqual(['verified', 'not_sent', 'verified']);
        // Only one database call for the unverified case
        expect(prisma.verification.findFirst).toHaveBeenCalledTimes(1);
      });
    });

    describe('real-world scenarios', () => {
      it('should return correct status for new user signup in dev (no verification required)', async () => {
        // Arrange: User just signed up, no email verification sent
        vi.mocked(prisma.verification.findFirst).mockResolvedValue(null);

        // Act
        const status = await getVerificationStatus('newuser@example.com', false);

        // Assert: Should be "not_sent"
        expect(status).toBe('not_sent');
      });

      it('should return correct status after verification email sent', async () => {
        // Arrange: Verification email sent, token exists
        vi.mocked(prisma.verification.findFirst).mockResolvedValue({
          id: 'token-id',
          identifier: testEmail,
          value: 'hashed-token',
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24h
          createdAt: new Date(),
          updatedAt: new Date(),
          metadata: null,
        });

        // Act
        const status = await getVerificationStatus(testEmail, false);

        // Assert: Should be "pending"
        expect(status).toBe('pending');
      });

      it('should return correct status after user verifies email', async () => {
        // Arrange: User clicked verification link, email is now verified
        // (Database still has token but we don't care since emailVerified=true)

        // Act
        const status = await getVerificationStatus(testEmail, true);

        // Assert: Should be "verified" and skip database
        expect(status).toBe('verified');
        expect(prisma.verification.findFirst).not.toHaveBeenCalled();
      });

      it('should return correct status for expired token scenario', async () => {
        // Arrange: User never clicked link, token expired
        // Query filters expired tokens, so returns null
        vi.mocked(prisma.verification.findFirst).mockResolvedValue(null);

        // Act
        const status = await getVerificationStatus(testEmail, false);

        // Assert: Should be "not_sent" (can request new email)
        expect(status).toBe('not_sent');
      });
    });
  });
});
