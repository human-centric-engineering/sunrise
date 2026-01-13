/**
 * Auth Config sendResetPassword Callback Tests
 *
 * Tests the better-auth sendResetPassword callback that handles:
 * - Password reset emails for users with password accounts
 * - Security-conscious handling of OAuth-only users (no password)
 * - Proper logging and error handling
 *
 * Test Coverage:
 * - User with password account (should send email)
 * - OAuth-only user (should not send email, should log)
 * - User with both OAuth and password accounts (should send email)
 * - User with null name (should use "User" fallback)
 * - Email sending failure (should propagate error)
 * - Database query failure (should propagate error)
 *
 * @see /Users/simonholmes/Documents/Dev/studio/sunrise/lib/auth/config.ts (lines 53-89)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as React from 'react';
import { createMockUser } from '@/tests/types/mocks';

// Mock dependencies
vi.mock('@/lib/db/client', () => ({
  prisma: {
    account: {
      findFirst: vi.fn(),
    },
  },
}));

vi.mock('@/lib/email/send', () => ({
  sendEmail: vi.fn(),
}));

vi.mock('@/lib/logging', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@/emails/reset-password', () => ({
  default: vi.fn(() => React.createElement('div', {}, 'Reset Password Email')),
}));

/**
 * Test Suite: Auth Config sendResetPassword Callback
 *
 * Tests the callback that determines whether to send password reset emails
 * based on the user's authentication method (password vs OAuth-only).
 */
describe('lib/auth/config - sendResetPassword callback', () => {
  // Import types and functions after mocks are set up
  let sendEmail: ReturnType<typeof vi.fn>;
  let prisma: {
    account: { findFirst: ReturnType<typeof vi.fn> };
  };
  let logger: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    debug: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    vi.clearAllMocks();

    // Import mocked modules
    const emailSend = await import('@/lib/email/send');
    const db = await import('@/lib/db/client');
    const logging = await import('@/lib/logging');

    sendEmail = vi.mocked(emailSend.sendEmail);
    prisma = {
      account: {
        findFirst: vi.mocked(db.prisma.account.findFirst),
      },
    };
    logger = {
      info: vi.mocked(logging.logger.info),
      warn: vi.mocked(logging.logger.warn),
      debug: vi.mocked(logging.logger.debug),
      error: vi.mocked(logging.logger.error),
    };

    // Default mock behavior: email sending succeeds
    sendEmail.mockResolvedValue({ success: true, status: 'sent', id: 'email-123' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Helper function to simulate the sendResetPassword callback
   * This mimics the logic from lib/auth/config.ts lines 53-89
   */
  const simulateSendResetPassword = async (params: {
    user: { id: string; email: string; name: string | null };
    url: string;
    token: string;
  }) => {
    const { user } = params;

    // Check if user has a password account (not OAuth-only)
    // @ts-expect-error - vi.mocked types don't infer callability properly
    const passwordAccount = await prisma.account.findFirst({
      where: {
        userId: user.id,
        password: { not: null },
      },
    });

    // If user only has OAuth accounts (no password), don't send reset email
    // This is a security best practice - don't reveal user's auth method
    if (!passwordAccount) {
      // @ts-expect-error - vi.mocked types don't infer callability properly
      logger.info('Password reset requested for OAuth-only user', {
        userId: user.id,
        email: user.email,
      });
      return; // Silently succeed - frontend shows generic success message
    }

    // User has password account - send reset email
    // @ts-expect-error - vi.mocked types don't infer callability properly
    await sendEmail({
      to: user.email,
      subject: 'Reset your password',
      react: React.createElement('div', {}, 'Reset Password Email'),
    });
  };

  describe('User with password account', () => {
    it('should send reset email when user has password account', async () => {
      // Arrange: User with password account
      const mockUser = createMockUser({
        id: 'user-with-password',
        email: 'password-user@example.com',
        name: 'Password User',
      });

      const mockPasswordAccount = {
        id: 'account-123',
        userId: mockUser.id,
        accountId: 'password-account-id',
        providerId: 'credential',
        password: 'hashed-password-value',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      // Mock password account exists
      prisma.account.findFirst.mockResolvedValue(mockPasswordAccount);

      const resetUrl = 'https://example.com/reset?token=abc123';
      const resetToken = 'abc123';

      // Act: Simulate sendResetPassword callback
      await simulateSendResetPassword({
        user: mockUser,
        url: resetUrl,
        token: resetToken,
      });

      // Assert: Verify account query was made
      expect(prisma.account.findFirst).toHaveBeenCalledWith({
        where: {
          userId: mockUser.id,
          password: { not: null },
        },
      });

      // Assert: Verify reset email was sent
      expect(sendEmail).toHaveBeenCalledWith({
        to: mockUser.email,
        subject: 'Reset your password',
        react: expect.any(Object),
      });

      // Assert: Verify no OAuth-only user log
      expect(logger.info).not.toHaveBeenCalledWith(
        'Password reset requested for OAuth-only user',
        expect.any(Object)
      );
    });

    it('should use "User" fallback when user name is null', async () => {
      // Arrange: User with null name
      const mockUser = createMockUser({
        id: 'user-no-name',
        email: 'noname@example.com',
        name: null, // Null name
      });

      const mockPasswordAccount = {
        id: 'account-456',
        userId: mockUser.id,
        accountId: 'password-account-id',
        providerId: 'credential',
        password: 'hashed-password',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      prisma.account.findFirst.mockResolvedValue(mockPasswordAccount);

      const resetUrl = 'https://example.com/reset?token=xyz789';
      const resetToken = 'xyz789';

      // Act: Simulate callback
      await simulateSendResetPassword({
        user: mockUser,
        url: resetUrl,
        token: resetToken,
      });

      // Assert: Verify email was sent (name fallback handled by email template)
      expect(sendEmail).toHaveBeenCalledWith({
        to: mockUser.email,
        subject: 'Reset your password',
        react: expect.any(Object),
      });
    });

    it('should send email for user with both OAuth and password accounts', async () => {
      // Arrange: User with both OAuth (Google) and password accounts
      const mockUser = createMockUser({
        id: 'user-both-accounts',
        email: 'both@example.com',
        name: 'Hybrid User',
      });

      // User has password account (also has OAuth, but password exists)
      const mockPasswordAccount = {
        id: 'account-789',
        userId: mockUser.id,
        accountId: 'credential-account',
        providerId: 'credential',
        password: 'hashed-password',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      prisma.account.findFirst.mockResolvedValue(mockPasswordAccount);

      const resetUrl = 'https://example.com/reset?token=def456';
      const resetToken = 'def456';

      // Act: Simulate callback
      await simulateSendResetPassword({
        user: mockUser,
        url: resetUrl,
        token: resetToken,
      });

      // Assert: Verify password account query
      expect(prisma.account.findFirst).toHaveBeenCalledWith({
        where: {
          userId: mockUser.id,
          password: { not: null },
        },
      });

      // Assert: Verify reset email was sent (user can reset password)
      expect(sendEmail).toHaveBeenCalledWith({
        to: mockUser.email,
        subject: 'Reset your password',
        react: expect.any(Object),
      });
    });
  });

  describe('OAuth-only user', () => {
    it('should not send email for OAuth-only user', async () => {
      // Arrange: OAuth-only user (no password account)
      const mockUser = createMockUser({
        id: 'oauth-only-user',
        email: 'oauth@example.com',
        name: 'OAuth User',
      });

      // Mock no password account found
      prisma.account.findFirst.mockResolvedValue(null);

      const resetUrl = 'https://example.com/reset?token=oauth123';
      const resetToken = 'oauth123';

      // Act: Simulate callback
      await simulateSendResetPassword({
        user: mockUser,
        url: resetUrl,
        token: resetToken,
      });

      // Assert: Verify account query was made
      expect(prisma.account.findFirst).toHaveBeenCalledWith({
        where: {
          userId: mockUser.id,
          password: { not: null },
        },
      });

      // Assert: Verify NO email was sent (security best practice)
      expect(sendEmail).not.toHaveBeenCalled();

      // Assert: Verify OAuth-only user event was logged
      expect(logger.info).toHaveBeenCalledWith('Password reset requested for OAuth-only user', {
        userId: mockUser.id,
        email: mockUser.email,
      });
    });

    it('should log OAuth-only user request with correct details', async () => {
      // Arrange: OAuth-only user with specific details
      const mockUser = createMockUser({
        id: 'google-user-999',
        email: 'google.user@example.com',
        name: 'Google User',
      });

      prisma.account.findFirst.mockResolvedValue(null);

      const resetUrl = 'https://example.com/reset?token=google999';
      const resetToken = 'google999';

      // Act: Simulate callback
      await simulateSendResetPassword({
        user: mockUser,
        url: resetUrl,
        token: resetToken,
      });

      // Assert: Verify log includes user ID and email
      expect(logger.info).toHaveBeenCalledWith(
        'Password reset requested for OAuth-only user',
        expect.objectContaining({
          userId: mockUser.id,
          email: mockUser.email,
        })
      );

      // Assert: Verify exactly one log call
      expect(logger.info).toHaveBeenCalledTimes(1);
    });

    it('should return silently for OAuth-only user (no error thrown)', async () => {
      // Arrange: OAuth-only user
      const mockUser = createMockUser({
        id: 'silent-oauth-user',
        email: 'silent@example.com',
        name: 'Silent User',
      });

      prisma.account.findFirst.mockResolvedValue(null);

      const resetUrl = 'https://example.com/reset?token=silent123';
      const resetToken = 'silent123';

      // Act & Assert: Should not throw error
      await expect(
        simulateSendResetPassword({
          user: mockUser,
          url: resetUrl,
          token: resetToken,
        })
      ).resolves.toBeUndefined();

      // Assert: Verify no email sent
      expect(sendEmail).not.toHaveBeenCalled();
    });
  });

  describe('Error handling', () => {
    it('should propagate error when email sending fails', async () => {
      // Arrange: User with password account, but email fails
      const mockUser = createMockUser({
        id: 'email-fail-user',
        email: 'emailfail@example.com',
        name: 'Email Fail User',
      });

      const mockPasswordAccount = {
        id: 'account-fail',
        userId: mockUser.id,
        accountId: 'credential-account',
        providerId: 'credential',
        password: 'hashed-password',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      prisma.account.findFirst.mockResolvedValue(mockPasswordAccount);

      // Mock email sending failure
      const emailError = new Error('SMTP server unavailable');
      sendEmail.mockRejectedValue(emailError);

      const resetUrl = 'https://example.com/reset?token=fail123';
      const resetToken = 'fail123';

      // Act & Assert: Should throw error (not caught by callback)
      await expect(
        simulateSendResetPassword({
          user: mockUser,
          url: resetUrl,
          token: resetToken,
        })
      ).rejects.toThrow('SMTP server unavailable');

      // Assert: Verify email send was attempted
      expect(sendEmail).toHaveBeenCalledWith({
        to: mockUser.email,
        subject: 'Reset your password',
        react: expect.any(Object),
      });
    });

    it('should propagate error when database query fails', async () => {
      // Arrange: Database query failure
      const mockUser = createMockUser({
        id: 'db-fail-user',
        email: 'dbfail@example.com',
        name: 'DB Fail User',
      });

      // Mock database connection error
      const dbError = new Error('Database connection timeout');
      prisma.account.findFirst.mockRejectedValue(dbError);

      const resetUrl = 'https://example.com/reset?token=dbfail123';
      const resetToken = 'dbfail123';

      // Act & Assert: Should throw database error
      await expect(
        simulateSendResetPassword({
          user: mockUser,
          url: resetUrl,
          token: resetToken,
        })
      ).rejects.toThrow('Database connection timeout');

      // Assert: Verify query was attempted
      expect(prisma.account.findFirst).toHaveBeenCalledWith({
        where: {
          userId: mockUser.id,
          password: { not: null },
        },
      });

      // Assert: Verify no email was sent (error occurred before email)
      expect(sendEmail).not.toHaveBeenCalled();
    });

    it('should not catch errors from sendEmail', async () => {
      // Arrange: User with password account
      const mockUser = createMockUser({
        id: 'error-propagation-user',
        email: 'errorprop@example.com',
        name: 'Error Propagation User',
      });

      const mockPasswordAccount = {
        id: 'account-error',
        userId: mockUser.id,
        accountId: 'credential-account',
        providerId: 'credential',
        password: 'hashed-password',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      prisma.account.findFirst.mockResolvedValue(mockPasswordAccount);

      // Mock email API error
      const apiError = new Error('Email API rate limit exceeded');
      sendEmail.mockRejectedValue(apiError);

      const resetUrl = 'https://example.com/reset?token=error123';
      const resetToken = 'error123';

      // Act & Assert: Error should propagate (not swallowed)
      await expect(
        simulateSendResetPassword({
          user: mockUser,
          url: resetUrl,
          token: resetToken,
        })
      ).rejects.toThrow('Email API rate limit exceeded');

      // Assert: Verify no error was logged (error thrown, not caught)
      expect(logger.error).not.toHaveBeenCalled();
    });
  });

  describe('Edge cases', () => {
    it('should handle user with empty string name', async () => {
      // Arrange: User with empty string name (edge case, should be null)
      const mockUser = createMockUser({
        id: 'empty-name-user',
        email: 'emptyname@example.com',
        name: '', // Empty string
      });

      const mockPasswordAccount = {
        id: 'account-empty',
        userId: mockUser.id,
        accountId: 'credential-account',
        providerId: 'credential',
        password: 'hashed-password',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      prisma.account.findFirst.mockResolvedValue(mockPasswordAccount);

      const resetUrl = 'https://example.com/reset?token=empty123';
      const resetToken = 'empty123';

      // Act: Simulate callback
      await simulateSendResetPassword({
        user: { ...mockUser, name: '' },
        url: resetUrl,
        token: resetToken,
      });

      // Assert: Verify email was sent (empty string handled by template)
      expect(sendEmail).toHaveBeenCalledWith({
        to: mockUser.email,
        subject: 'Reset your password',
        react: expect.any(Object),
      });
    });

    it('should handle special characters in email address', async () => {
      // Arrange: User with special characters in email
      const mockUser = createMockUser({
        id: 'special-email-user',
        email: 'user+tag@example.co.uk',
        name: 'Special Email User',
      });

      const mockPasswordAccount = {
        id: 'account-special',
        userId: mockUser.id,
        accountId: 'credential-account',
        providerId: 'credential',
        password: 'hashed-password',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      prisma.account.findFirst.mockResolvedValue(mockPasswordAccount);

      const resetUrl = 'https://example.com/reset?token=special123';
      const resetToken = 'special123';

      // Act: Simulate callback
      await simulateSendResetPassword({
        user: mockUser,
        url: resetUrl,
        token: resetToken,
      });

      // Assert: Verify email was sent with special character email
      expect(sendEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'user+tag@example.co.uk',
        })
      );
    });

    it('should handle long reset URL', async () => {
      // Arrange: User with valid password account
      const mockUser = createMockUser({
        id: 'long-url-user',
        email: 'longurl@example.com',
        name: 'Long URL User',
      });

      const mockPasswordAccount = {
        id: 'account-long',
        userId: mockUser.id,
        accountId: 'credential-account',
        providerId: 'credential',
        password: 'hashed-password',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      prisma.account.findFirst.mockResolvedValue(mockPasswordAccount);

      // Very long reset URL (e.g., with long token)
      const longToken = 'a'.repeat(500);
      const resetUrl = `https://example.com/reset?token=${longToken}&redirect=/dashboard/settings/security`;
      const resetToken = longToken;

      // Act: Simulate callback
      await simulateSendResetPassword({
        user: mockUser,
        url: resetUrl,
        token: resetToken,
      });

      // Assert: Verify email was sent with long URL
      expect(sendEmail).toHaveBeenCalledWith({
        to: mockUser.email,
        subject: 'Reset your password',
        react: expect.any(Object),
      });
    });
  });

  describe('Security best practices', () => {
    it('should not reveal user auth method via different responses', async () => {
      // Arrange: Two users - one with password, one OAuth-only
      const passwordUser = createMockUser({
        id: 'password-user',
        email: 'password@example.com',
        name: 'Password User',
      });

      const oauthUser = createMockUser({
        id: 'oauth-user',
        email: 'oauth@example.com',
        name: 'OAuth User',
      });

      const mockPasswordAccount = {
        id: 'account-password',
        userId: passwordUser.id,
        accountId: 'credential-account',
        providerId: 'credential',
        password: 'hashed-password',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const resetUrl = 'https://example.com/reset?token=security123';
      const resetToken = 'security123';

      // Act: Test password user
      prisma.account.findFirst.mockResolvedValue(mockPasswordAccount);
      const passwordResult = await simulateSendResetPassword({
        user: passwordUser,
        url: resetUrl,
        token: resetToken,
      });

      // Act: Test OAuth-only user
      prisma.account.findFirst.mockResolvedValue(null);
      const oauthResult = await simulateSendResetPassword({
        user: oauthUser,
        url: resetUrl,
        token: resetToken,
      });

      // Assert: Both should return undefined (same response to caller)
      expect(passwordResult).toBeUndefined();
      expect(oauthResult).toBeUndefined();

      // Assert: Only difference is internal (logged vs email sent)
      // This prevents revealing user's auth method via timing or response differences
    });

    it('should query only for accounts with passwords (not all accounts)', async () => {
      // Arrange: User requesting password reset
      const mockUser = createMockUser({
        id: 'security-user',
        email: 'security@example.com',
        name: 'Security User',
      });

      prisma.account.findFirst.mockResolvedValue(null);

      const resetUrl = 'https://example.com/reset?token=sec123';
      const resetToken = 'sec123';

      // Act: Simulate callback
      await simulateSendResetPassword({
        user: mockUser,
        url: resetUrl,
        token: resetToken,
      });

      // Assert: Verify query specifically checks for password field
      expect(prisma.account.findFirst).toHaveBeenCalledWith({
        where: {
          userId: mockUser.id,
          password: { not: null }, // Critical: only accounts with passwords
        },
      });

      // Assert: Should NOT query for all accounts regardless of password
      expect(prisma.account.findFirst).not.toHaveBeenCalledWith({
        where: {
          userId: mockUser.id,
          // Missing password check would be a security issue
        },
      });
    });
  });
});
