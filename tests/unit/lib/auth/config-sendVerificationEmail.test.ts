/**
 * Auth Config sendVerificationEmail Callback Tests
 *
 * Tests the better-auth sendVerificationEmail callback that handles:
 * - Sending verification emails to new users during signup
 * - Skipping verification emails for invitation acceptances
 * - Rewriting the callbackURL to point at the verification callback page
 * - Correct prop wiring to VerifyEmailEmail component
 *
 * @see lib/auth/config.ts (sendVerificationEmailHook)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as React from 'react';
import { createMockUser } from '@/tests/types/mocks';

// ---------------------------------------------------------------------------
// Mock dependencies
// ---------------------------------------------------------------------------

vi.mock('@/lib/db/client', () => ({
  prisma: {
    user: { update: vi.fn() },
    account: { findFirst: vi.fn() },
  },
}));

vi.mock('@/lib/email/send', () => ({
  sendEmail: vi.fn(),
}));

vi.mock('@/lib/email/client', () => ({
  validateEmailConfig: vi.fn(),
}));

vi.mock('@/lib/logging', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@/lib/env', () => ({
  env: {
    REQUIRE_EMAIL_VERIFICATION: undefined,
    BETTER_AUTH_URL: 'http://localhost:3000',
    NODE_ENV: 'test',
    BETTER_AUTH_SECRET: 'x'.repeat(32),
    RESEND_API_KEY: 'test-resend-key',
    EMAIL_FROM: 'test@example.com',
    DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
    NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
  },
}));

vi.mock('better-auth', () => ({
  betterAuth: vi.fn(() => ({
    api: { getSession: vi.fn() },
    handler: vi.fn(),
  })),
}));

vi.mock('better-auth/adapters/prisma', () => ({
  prismaAdapter: vi.fn(() => ({})),
}));

vi.mock('better-auth/api', () => ({
  getOAuthState: vi.fn(),
  APIError: class APIError extends Error {
    status: string;
    body: { code?: string; message?: string };
    statusCode: number;
    constructor(status: string, body: { code?: string; message?: string } = {}) {
      super(body.message ?? status);
      this.name = 'APIError';
      this.status = status;
      this.body = body;
      this.statusCode = 400;
    }
  },
}));

vi.mock('@/lib/utils/invitation-token', () => ({
  validateInvitationToken: vi.fn(),
  deleteInvitationToken: vi.fn(),
  getValidInvitation: vi.fn(),
}));

vi.mock('@/lib/validations/user', () => ({
  DEFAULT_USER_PREFERENCES: {
    email: { marketing: false, productUpdates: true, securityAlerts: true },
  },
}));

vi.mock('@/emails/verify-email', () => ({
  default: vi.fn(() => React.createElement('div', {}, 'Verify Email')),
}));

vi.mock('@/emails/welcome', () => ({
  default: vi.fn(() => React.createElement('div', {}, 'Welcome Email')),
}));

vi.mock('@/emails/reset-password', () => ({
  default: vi.fn(() => React.createElement('div', {}, 'Reset Password Email')),
}));

/**
 * Test Suite: Auth Config sendVerificationEmail Callback
 *
 * Tests the hook that sends verification emails on signup,
 * skipping invitation acceptances.
 */
describe('lib/auth/config - sendVerificationEmail callback', () => {
  let sendEmail: ReturnType<typeof vi.fn>;
  let logger: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
  let getValidInvitation: ReturnType<typeof vi.fn>;
  let VerifyEmailEmail: ReturnType<typeof vi.fn>;
  let sendVerificationEmailHook: (params: {
    user: { id: string; email: string; name: string | null };
    url: string;
    token: string;
  }) => Promise<void>;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Import mocked modules and real hook
    const emailSend = await import('@/lib/email/send');
    const logging = await import('@/lib/logging');
    const invitationToken = await import('@/lib/utils/invitation-token');
    const verifyEmailTemplate = await import('@/emails/verify-email');
    const authConfig = await import('@/lib/auth/config');

    sendEmail = vi.mocked(emailSend.sendEmail);
    logger = {
      info: vi.mocked(logging.logger.info),
      warn: vi.mocked(logging.logger.warn),
      error: vi.mocked(logging.logger.error),
    };
    getValidInvitation = vi.mocked(invitationToken.getValidInvitation);
    VerifyEmailEmail = vi.mocked(verifyEmailTemplate.default);
    sendVerificationEmailHook = authConfig.sendVerificationEmailHook;

    // Default: no invitation, email sending succeeds
    getValidInvitation.mockResolvedValue(null);
    sendEmail.mockResolvedValue({ success: true, status: 'sent', id: 'email-123' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('regular signup (no invitation)', () => {
    it('should send verification email for a normal signup', async () => {
      // Arrange
      const user = createMockUser({ id: 'user-1', email: 'new@example.com', name: 'New User' });
      const url = 'https://example.com/verify?token=abc&callbackURL=%2F';

      // Act
      await sendVerificationEmailHook({ user, url, token: 'abc' });

      // Assert
      expect(sendEmail).toHaveBeenCalledWith({
        to: 'new@example.com',
        subject: 'Verify your email address',
        react: expect.any(Object),
      });
    });

    it('should rewrite callbackURL to verification callback page', async () => {
      // Arrange
      const user = createMockUser({ id: 'user-2', email: 'rewrite@example.com', name: 'Rewrite' });
      const url = 'https://example.com/verify?token=xyz&callbackURL=%2F';

      // Act
      await sendVerificationEmailHook({ user, url, token: 'xyz' });

      // Assert: VerifyEmailEmail receives the rewritten URL
      expect(VerifyEmailEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          verificationUrl:
            'https://example.com/verify?token=xyz&callbackURL=%2Fverify-email%2Fcallback',
        })
      );
    });

    it('should pass URL through unchanged when callbackURL pattern is not present', async () => {
      // Arrange: URL without the expected callbackURL=%2F pattern
      const user = createMockUser({
        id: 'user-3',
        email: 'nopattern@example.com',
        name: 'No Pattern',
      });
      const url = 'https://example.com/verify?token=abc';

      // Act
      await sendVerificationEmailHook({ user, url, token: 'abc' });

      // Assert: URL passed through unchanged
      expect(VerifyEmailEmail).toHaveBeenCalledWith(
        expect.objectContaining({ verificationUrl: url })
      );
    });

    it('should use "User" fallback when name is null', async () => {
      // Arrange
      const user = createMockUser({ id: 'user-4', email: 'null@example.com', name: null });
      const url = 'https://example.com/verify?token=abc&callbackURL=%2F';

      // Act
      await sendVerificationEmailHook({ user, url, token: 'abc' });

      // Assert
      expect(VerifyEmailEmail).toHaveBeenCalledWith(expect.objectContaining({ userName: 'User' }));
    });

    it('should set expiresAt to 24 hours from now', async () => {
      // Arrange
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-04-20T12:00:00Z'));

      const user = createMockUser({ id: 'user-5', email: 'timer@example.com', name: 'Timer' });
      const url = 'https://example.com/verify?token=abc&callbackURL=%2F';

      // Act
      await sendVerificationEmailHook({ user, url, token: 'abc' });

      vi.useRealTimers();

      // Assert: expiresAt is exactly 24 hours later
      expect(VerifyEmailEmail).toHaveBeenCalledWith(
        expect.objectContaining({ expiresAt: new Date('2026-04-21T12:00:00Z') })
      );
    });
  });

  describe('invitation acceptance (should skip)', () => {
    it('should not send verification email when user has a valid invitation', async () => {
      // Arrange: invitation exists
      const user = createMockUser({
        id: 'invited-1',
        email: 'invited@example.com',
        name: 'Invited',
      });
      getValidInvitation.mockResolvedValue({
        id: 'inv-1',
        email: 'invited@example.com',
        metadata: { role: 'ADMIN' },
      });

      // Act
      await sendVerificationEmailHook({
        user,
        url: 'https://example.com/verify?token=abc',
        token: 'abc',
      });

      // Assert: no email sent
      expect(sendEmail).not.toHaveBeenCalled();
    });

    it('should log skip message for invitation acceptance', async () => {
      // Arrange
      const user = createMockUser({
        id: 'invited-2',
        email: 'invited2@example.com',
        name: 'Invited 2',
      });
      getValidInvitation.mockResolvedValue({
        id: 'inv-2',
        email: 'invited2@example.com',
        metadata: {},
      });

      // Act
      await sendVerificationEmailHook({
        user,
        url: 'https://example.com/verify?token=abc',
        token: 'abc',
      });

      // Assert
      expect(logger.info).toHaveBeenCalledWith(
        'Skipping verification email for invitation acceptance',
        { userId: 'invited-2', email: 'invited2@example.com' }
      );
    });
  });

  describe('error handling', () => {
    it('should propagate error when email sending fails', async () => {
      // Arrange
      const user = createMockUser({ id: 'fail-1', email: 'fail@example.com', name: 'Fail' });
      sendEmail.mockRejectedValue(new Error('SMTP unavailable'));

      // Act & Assert
      await expect(
        sendVerificationEmailHook({
          user,
          url: 'https://example.com/verify?token=abc&callbackURL=%2F',
          token: 'abc',
        })
      ).rejects.toThrow('SMTP unavailable');
    });

    it('should propagate error when getValidInvitation fails', async () => {
      // Arrange
      const user = createMockUser({ id: 'fail-2', email: 'fail2@example.com', name: 'Fail 2' });
      getValidInvitation.mockRejectedValue(new Error('DB connection lost'));

      // Act & Assert
      await expect(
        sendVerificationEmailHook({
          user,
          url: 'https://example.com/verify?token=abc',
          token: 'abc',
        })
      ).rejects.toThrow('DB connection lost');
    });
  });
});
