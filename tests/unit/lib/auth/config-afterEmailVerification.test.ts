/**
 * Auth Config afterEmailVerification Callback Tests
 *
 * Tests the real afterEmailVerificationHook from lib/auth/config.ts that handles:
 * - Sending the welcome email after a user verifies their email address
 * - Skipping the welcome email when verification is not required (already sent at signup)
 * - Non-blocking error handling for email failures
 *
 * Test Coverage:
 * - Verification required (production): sends welcome email after verification
 * - Verification not required (development/test): skips welcome email (already sent at signup)
 * - Null name falls back to "User" (handled by WelcomeEmail template)
 * - Email failure is non-blocking (caught, logged as warning, does not throw)
 *
 * @see lib/auth/config.ts (afterEmailVerificationHook)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as React from 'react';
import { createMockUser } from '@/tests/types/mocks';

// ---------------------------------------------------------------------------
// Mutable env object — individual tests mutate fields to exercise branches.
// Reset in beforeEach.
// ---------------------------------------------------------------------------

const mockEnv = {
  REQUIRE_EMAIL_VERIFICATION: undefined as boolean | undefined,
  BETTER_AUTH_URL: 'http://localhost:3000',
  NODE_ENV: 'test' as 'test' | 'development' | 'production',
  BETTER_AUTH_SECRET: 'x'.repeat(32),
  RESEND_API_KEY: 'test-resend-key',
  EMAIL_FROM: 'test@example.com',
  DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
  NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
};

// ---------------------------------------------------------------------------
// Mock dependencies — declared before any imports from @/lib/auth/config
// ---------------------------------------------------------------------------

vi.mock('@/lib/env', () => ({
  env: mockEnv,
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

vi.mock('@/emails/welcome', () => ({
  default: vi.fn(() => React.createElement('div', {}, 'Welcome Email')),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    user: { update: vi.fn() },
    account: { findFirst: vi.fn() },
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

vi.mock('@/emails/reset-password', () => ({
  default: vi.fn(() => React.createElement('div', {}, 'Reset Password Email')),
}));

/**
 * Test Suite: Auth Config afterEmailVerification Callback
 *
 * Tests the real hook by importing it directly from config. All module-level
 * dependencies (sendEmail, logger, env) are replaced by vi.mock above.
 */
describe('lib/auth/config - afterEmailVerification callback', () => {
  let sendEmail: ReturnType<typeof vi.fn>;
  let logger: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    debug: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
  let afterEmailVerificationHook: (user: {
    id: string;
    email: string;
    name: string | null;
  }) => Promise<void>;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Reset env to safe defaults
    mockEnv.REQUIRE_EMAIL_VERIFICATION = undefined;
    mockEnv.NODE_ENV = 'test';
    mockEnv.BETTER_AUTH_URL = 'http://localhost:3000';

    // Import mocked modules and real hook
    const emailSend = await import('@/lib/email/send');
    const logging = await import('@/lib/logging');
    const authConfig = await import('@/lib/auth/config');

    sendEmail = vi.mocked(emailSend.sendEmail);
    logger = {
      info: vi.mocked(logging.logger.info),
      warn: vi.mocked(logging.logger.warn),
      debug: vi.mocked(logging.logger.debug),
      error: vi.mocked(logging.logger.error),
    };
    afterEmailVerificationHook = authConfig.afterEmailVerificationHook;

    // Default: email sending succeeds
    sendEmail.mockResolvedValue({ success: true, status: 'sent', id: 'email-123' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('when email verification is not required', () => {
    it('should skip welcome email when REQUIRE_EMAIL_VERIFICATION is undefined and NODE_ENV is test', async () => {
      // Arrange: verification not required (default test setup)
      mockEnv.REQUIRE_EMAIL_VERIFICATION = undefined;
      mockEnv.NODE_ENV = 'test';

      const user = createMockUser({ id: 'user-1', email: 'user@example.com', name: 'Test User' });

      // Act: call the real hook
      await afterEmailVerificationHook(user);

      // Assert: welcome email not sent (already sent at signup)
      expect(sendEmail).not.toHaveBeenCalled();
    });

    it('should skip welcome email when REQUIRE_EMAIL_VERIFICATION is explicitly false', async () => {
      // Arrange: explicitly disabled
      mockEnv.REQUIRE_EMAIL_VERIFICATION = false;
      mockEnv.NODE_ENV = 'test';

      const user = createMockUser({ id: 'user-2', email: 'user@example.com', name: 'Test User' });

      // Act
      await afterEmailVerificationHook(user);

      // Assert: no welcome email
      expect(sendEmail).not.toHaveBeenCalled();
    });

    it('should log a skip message when bypassing welcome email', async () => {
      // Arrange
      mockEnv.REQUIRE_EMAIL_VERIFICATION = undefined;
      mockEnv.NODE_ENV = 'test';

      const user = createMockUser({ id: 'user-3', email: 'user@example.com', name: 'Test User' });

      // Act
      await afterEmailVerificationHook(user);

      // Assert: skip is logged with user ID
      expect(logger.info).toHaveBeenCalledWith(
        'Skipping welcome email after verification (already sent at signup)',
        expect.objectContaining({ userId: user.id })
      );
    });

    it('should still log that verification completed before skipping', async () => {
      // Arrange
      mockEnv.REQUIRE_EMAIL_VERIFICATION = undefined;
      mockEnv.NODE_ENV = 'test';

      const user = createMockUser({ id: 'user-4', email: 'user@example.com', name: 'Test User' });

      // Act
      await afterEmailVerificationHook(user);

      // Assert: verification completion is always logged first
      expect(logger.info).toHaveBeenCalledWith(
        'Email verification completed',
        expect.objectContaining({ userId: user.id, email: user.email })
      );
    });
  });

  describe('when email verification is required', () => {
    it('should send welcome email when REQUIRE_EMAIL_VERIFICATION is true', async () => {
      // Arrange: verification required (explicit flag)
      mockEnv.REQUIRE_EMAIL_VERIFICATION = true;

      const user = createMockUser({
        id: 'user-5',
        email: 'verified@example.com',
        name: 'Verified User',
      });

      // Act
      await afterEmailVerificationHook(user);

      // Assert: welcome email is sent with correct address and subject
      expect(sendEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: user.email,
          subject: 'Welcome to Sunrise',
          react: expect.any(Object),
        })
      );
    });

    it('should send welcome email when REQUIRE_EMAIL_VERIFICATION is undefined and NODE_ENV is production', async () => {
      // Arrange: production defaults to requiring verification
      mockEnv.REQUIRE_EMAIL_VERIFICATION = undefined;
      mockEnv.NODE_ENV = 'production';

      const user = createMockUser({ id: 'user-6', email: 'prod@example.com', name: 'Prod User' });

      // Act
      await afterEmailVerificationHook(user);

      // Assert: welcome email is sent after verification in production
      expect(sendEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: user.email,
          subject: 'Welcome to Sunrise',
        })
      );
    });

    it('should use "User" fallback when user name is null', async () => {
      // Arrange
      mockEnv.REQUIRE_EMAIL_VERIFICATION = true;

      const user = createMockUser({ id: 'user-7', email: 'noname@example.com', name: null });

      // Act
      await afterEmailVerificationHook(user);

      // Assert: email is still sent to the correct address
      expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: user.email }));
    });

    it('should not skip email and should send it exactly once', async () => {
      // Arrange
      mockEnv.REQUIRE_EMAIL_VERIFICATION = true;

      const user = createMockUser({ id: 'user-8', email: 'once@example.com', name: 'Once User' });

      // Act
      await afterEmailVerificationHook(user);

      // Assert: sent exactly once
      expect(sendEmail).toHaveBeenCalledTimes(1);

      // Assert: skip log was NOT emitted
      expect(logger.info).not.toHaveBeenCalledWith(
        'Skipping welcome email after verification (already sent at signup)',
        expect.any(Object)
      );
    });
  });

  describe('error handling', () => {
    it('should not throw when email sending fails', async () => {
      // Arrange: email fails
      mockEnv.REQUIRE_EMAIL_VERIFICATION = true;

      const user = createMockUser({ id: 'user-9', email: 'fail@example.com', name: 'Fail User' });
      sendEmail.mockRejectedValue(new Error('SMTP connection refused'));

      // Act & Assert: does not throw (non-blocking)
      await expect(afterEmailVerificationHook(user)).resolves.toBeUndefined();
    });

    it('should log a warning when email sending fails', async () => {
      // Arrange
      mockEnv.REQUIRE_EMAIL_VERIFICATION = true;

      const user = createMockUser({
        id: 'user-10',
        email: 'warn@example.com',
        name: 'Warn User',
      });
      const emailError = new Error('Email API rate limit exceeded');
      sendEmail.mockRejectedValue(emailError);

      // Act
      await afterEmailVerificationHook(user);

      // Assert: warning logged with user ID and error message
      expect(logger.warn).toHaveBeenCalledWith(
        'Failed to send welcome email after verification',
        expect.objectContaining({
          userId: user.id,
          error: 'Email API rate limit exceeded',
        })
      );
    });

    it('should log warning with stringified error when non-Error is thrown', async () => {
      // Arrange
      mockEnv.REQUIRE_EMAIL_VERIFICATION = true;

      const user = createMockUser({
        id: 'user-11',
        email: 'string-err@example.com',
        name: 'String Err',
      });
      sendEmail.mockRejectedValue('plain string error');

      // Act
      await afterEmailVerificationHook(user);

      // Assert: non-Error is stringified
      expect(logger.warn).toHaveBeenCalledWith(
        'Failed to send welcome email after verification',
        expect.objectContaining({
          error: 'plain string error',
        })
      );
    });
  });
});
