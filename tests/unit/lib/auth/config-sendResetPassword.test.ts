/**
 * Auth Config sendResetPassword Callback Tests
 *
 * Tests the better-auth sendResetPassword callback that handles:
 * - Password reset emails for users with password accounts
 * - Security-conscious handling of OAuth-only users (no password)
 * - Proper logging and error handling
 * - Correct prop wiring to ResetPasswordEmail component
 *
 * Test Coverage:
 * - User with password account (should send email)
 * - OAuth-only user (should not send email, should log)
 * - User with both OAuth and password accounts (should send email)
 * - User with null name (should use "User" fallback)
 * - User with empty string name (should use "User" fallback)
 * - Correct userName, resetUrl, and expiresAt passed to ResetPasswordEmail
 * - Email sending failure (should propagate error)
 * - Database query failure (should propagate error)
 *
 * @see lib/auth/config.ts (sendResetPasswordHook)
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
 * Tests the hook that determines whether to send password reset emails
 * based on the user's authentication method (password vs OAuth-only).
 */
describe('lib/auth/config - sendResetPassword callback', () => {
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
  let ResetPasswordEmail: ReturnType<typeof vi.fn>;
  let sendResetPasswordHook: (params: {
    user: { id: string; email: string; name: string | null };
    url: string;
    token: string;
  }) => Promise<void>;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Import mocked modules
    const emailSend = await import('@/lib/email/send');
    const db = await import('@/lib/db/client');
    const logging = await import('@/lib/logging');
    const resetPasswordEmail = await import('@/emails/reset-password');
    const authConfig = await import('@/lib/auth/config');

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
    ResetPasswordEmail = vi.mocked(resetPasswordEmail.default);
    sendResetPasswordHook = authConfig.sendResetPasswordHook;

    // Default mock behavior: email sending succeeds
    sendEmail.mockResolvedValue({ success: true, status: 'sent', id: 'email-123' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

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

      prisma.account.findFirst.mockResolvedValue(mockPasswordAccount);

      const resetUrl = 'https://example.com/reset?token=abc123';
      const resetToken = 'abc123';

      // Act: Call the real hook
      await sendResetPasswordHook({
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
        name: null, // Null name triggers fallback
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

      // Act: Call the real hook with null name
      await sendResetPasswordHook({
        user: { ...mockUser, name: null },
        url: 'https://example.com/reset?token=xyz789',
        token: 'xyz789',
      });

      // Assert: ResetPasswordEmail was called with "User" fallback, not null
      expect(ResetPasswordEmail).toHaveBeenCalledWith(
        expect.objectContaining({ userName: 'User' })
      );
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

      // Act: Call the real hook
      await sendResetPasswordHook({
        user: mockUser,
        url: 'https://example.com/reset?token=def456',
        token: 'def456',
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

      // Act: Call the real hook
      await sendResetPasswordHook({
        user: mockUser,
        url: 'https://example.com/reset?token=oauth123',
        token: 'oauth123',
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

      // Assert: Verify OAuth-only user event was logged with userId and email
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

      // Act: Call the real hook
      await sendResetPasswordHook({
        user: mockUser,
        url: 'https://example.com/reset?token=google999',
        token: 'google999',
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

      // Act & Assert: Should not throw error
      await expect(
        sendResetPasswordHook({
          user: mockUser,
          url: 'https://example.com/reset?token=silent123',
          token: 'silent123',
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

      // Act & Assert: Should throw error (not caught by hook)
      await expect(
        sendResetPasswordHook({
          user: mockUser,
          url: 'https://example.com/reset?token=fail123',
          token: 'fail123',
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

      // Act & Assert: Should throw database error
      await expect(
        sendResetPasswordHook({
          user: mockUser,
          url: 'https://example.com/reset?token=dbfail123',
          token: 'dbfail123',
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

      // Act & Assert: Error should propagate (not swallowed)
      await expect(
        sendResetPasswordHook({
          user: mockUser,
          url: 'https://example.com/reset?token=error123',
          token: 'error123',
        })
      ).rejects.toThrow('Email API rate limit exceeded');

      // Assert: Verify no error was logged (error thrown, not caught)
      expect(logger.error).not.toHaveBeenCalled();
    });
  });

  describe('Edge cases', () => {
    it('should handle user with empty string name', async () => {
      // Arrange: User with empty string name — should fall back to "User"
      const mockUser = createMockUser({
        id: 'empty-name-user',
        email: 'emptyname@example.com',
        name: '',
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

      // Act: Call the real hook with empty string name
      await sendResetPasswordHook({
        user: { ...mockUser, name: '' },
        url: 'https://example.com/reset?token=empty123',
        token: 'empty123',
      });

      // Assert: Empty string is falsy, so ResetPasswordEmail receives "User" fallback
      expect(ResetPasswordEmail).toHaveBeenCalledWith(
        expect.objectContaining({ userName: 'User' })
      );
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

      // Act: Call the real hook
      await sendResetPasswordHook({
        user: mockUser,
        url: 'https://example.com/reset?token=special123',
        token: 'special123',
      });

      // Assert: Verify email was sent with special character email preserved verbatim
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

      // Act: Call the real hook
      await sendResetPasswordHook({
        user: mockUser,
        url: resetUrl,
        token: longToken,
      });

      // Assert: Verify email was sent (hook does not truncate URLs)
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
      const passwordResult = await sendResetPasswordHook({
        user: passwordUser,
        url: resetUrl,
        token: resetToken,
      });

      // Act: Test OAuth-only user
      prisma.account.findFirst.mockResolvedValue(null);
      const oauthResult = await sendResetPasswordHook({
        user: oauthUser,
        url: resetUrl,
        token: resetToken,
      });

      // Assert: Both should return undefined (same response shape to caller)
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

      // Act: Call the real hook
      await sendResetPasswordHook({
        user: mockUser,
        url: 'https://example.com/reset?token=sec123',
        token: 'sec123',
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

  describe('ResetPasswordEmail prop wiring', () => {
    it('should pass user.name as userName when populated', async () => {
      // Arrange: User with a populated name
      const mockUser = createMockUser({
        id: 'alice-user',
        email: 'alice@example.com',
        name: 'Alice Example',
      });

      prisma.account.findFirst.mockResolvedValue({
        id: 'account-alice',
        userId: mockUser.id,
        accountId: 'credential-account',
        providerId: 'credential',
        password: 'hashed-password',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Act: Call the real hook with a populated name
      await sendResetPasswordHook({
        user: mockUser,
        url: 'https://example.com/reset?token=alice123',
        token: 'alice123',
      });

      // Assert: Hook passes the actual name through, not the fallback
      expect(ResetPasswordEmail).toHaveBeenCalledWith(
        expect.objectContaining({ userName: 'Alice Example' })
      );
    });

    it('should pass url through as resetUrl', async () => {
      // Arrange: User with password account and a known URL
      const mockUser = createMockUser({
        id: 'url-test-user',
        email: 'urltest@example.com',
        name: 'URL Test User',
      });

      prisma.account.findFirst.mockResolvedValue({
        id: 'account-url',
        userId: mockUser.id,
        accountId: 'credential-account',
        providerId: 'credential',
        password: 'hashed-password',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const specificUrl = 'https://app.example.com/reset?token=abc123';

      // Act: Call the real hook with the specific URL
      await sendResetPasswordHook({
        user: mockUser,
        url: specificUrl,
        token: 'abc123',
      });

      // Assert: The url param is forwarded verbatim as the resetUrl prop
      expect(ResetPasswordEmail).toHaveBeenCalledWith(
        expect.objectContaining({ resetUrl: specificUrl })
      );
    });

    it('should set expiresAt approximately 1 hour from now', async () => {
      // Arrange: Freeze time so we can assert the exact computed value
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-04-18T12:00:00Z'));

      const mockUser = createMockUser({
        id: 'timer-test-user',
        email: 'timer@example.com',
        name: 'Timer Test User',
      });

      prisma.account.findFirst.mockResolvedValue({
        id: 'account-timer',
        userId: mockUser.id,
        accountId: 'credential-account',
        providerId: 'credential',
        password: 'hashed-password',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Act: Call the real hook under frozen clock
      await sendResetPasswordHook({
        user: mockUser,
        url: 'https://example.com/reset?token=timer123',
        token: 'timer123',
      });

      vi.useRealTimers();

      // Assert: expiresAt should be exactly 1 hour after the frozen "now"
      expect(ResetPasswordEmail).toHaveBeenCalledWith(
        expect.objectContaining({ expiresAt: new Date('2026-04-18T13:00:00Z') })
      );
    });
  });
});
