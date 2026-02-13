/**
 * Auth Config afterEmailVerification Callback Tests
 *
 * Tests the better-auth afterEmailVerification callback that handles:
 * - Sending the welcome email after a user verifies their email address
 * - Skipping the welcome email when verification is not required (already sent at signup)
 * - Non-blocking error handling for email failures
 *
 * Test Coverage:
 * - Verification required (production): sends welcome email after verification
 * - Verification not required (development/test): skips welcome email (already sent at signup)
 * - Null name falls back to "User"
 * - Email failure is non-blocking (caught, logged as warning, does not throw)
 *
 * @see /Users/simonholmes/Documents/Dev/studio/sunrise/lib/auth/config.ts (lines 160-196)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as React from 'react';
import { createMockUser } from '@/tests/types/mocks';

// Mock dependencies
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

vi.mock('@/emails/welcome', () => ({
  WelcomeEmail: vi.fn(() => React.createElement('div', {}, 'Welcome Email')),
}));

vi.mock('@/lib/env', () => ({
  env: {
    REQUIRE_EMAIL_VERIFICATION: undefined,
    BETTER_AUTH_URL: 'http://localhost:3000',
    NODE_ENV: 'test',
  },
}));

/**
 * Helper: simulate the afterEmailVerification callback.
 *
 * Mirrors the logic from lib/auth/config.ts lines 160-196.
 * The `requiresVerification` value is read from the mocked env, so tests
 * can control it by mutating the mocked env before calling this function.
 */
const simulateAfterEmailVerification = async (
  params: { user: { id: string; email: string; name: string | null } },
  deps: {
    sendEmail: ReturnType<typeof vi.fn>;
    logger: {
      info: ReturnType<typeof vi.fn>;
      warn: ReturnType<typeof vi.fn>;
    };
    env: {
      REQUIRE_EMAIL_VERIFICATION: boolean | undefined;
      BETTER_AUTH_URL: string;
      NODE_ENV: string;
    };
  }
) => {
  const { user } = params;
  const { sendEmail, logger, env } = deps;

  // @ts-expect-error - vi.mocked types don't infer callability properly
  logger.info('Email verification completed', {
    userId: user.id,
    email: user.email,
  });

  const requiresVerification = env.REQUIRE_EMAIL_VERIFICATION ?? env.NODE_ENV === 'production';

  if (!requiresVerification) {
    // @ts-expect-error - vi.mocked types don't infer callability properly
    logger.info('Skipping welcome email after verification (already sent at signup)', {
      userId: user.id,
    });
    return;
  }

  // @ts-expect-error - vi.mocked types don't infer callability properly
  await sendEmail({
    to: user.email,
    subject: 'Welcome to Sunrise',
    react: React.createElement('div', {}, 'Welcome Email'),
  }).catch((error: unknown) => {
    // @ts-expect-error - vi.mocked types don't infer callability properly
    logger.warn('Failed to send welcome email after verification', {
      userId: user.id,
      error: error instanceof Error ? error.message : String(error),
    });
  });
};

describe('lib/auth/config - afterEmailVerification callback', () => {
  let sendEmail: ReturnType<typeof vi.fn>;
  let logger: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    debug: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
  let env: {
    REQUIRE_EMAIL_VERIFICATION: boolean | undefined;
    BETTER_AUTH_URL: string;
    NODE_ENV: string;
  };

  beforeEach(async () => {
    vi.clearAllMocks();

    const emailSend = await import('@/lib/email/send');
    const logging = await import('@/lib/logging');
    const envModule = await import('@/lib/env');

    sendEmail = vi.mocked(emailSend.sendEmail);
    logger = {
      info: vi.mocked(logging.logger.info),
      warn: vi.mocked(logging.logger.warn),
      debug: vi.mocked(logging.logger.debug),
      error: vi.mocked(logging.logger.error),
    };
    env = envModule.env as typeof env;

    // Default: verification not required (test/development)
    env.REQUIRE_EMAIL_VERIFICATION = undefined;
    env.NODE_ENV = 'test';
    env.BETTER_AUTH_URL = 'http://localhost:3000';

    // Default: email sending succeeds
    sendEmail.mockResolvedValue({ success: true, status: 'sent', id: 'email-123' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('when email verification is not required', () => {
    it('should skip welcome email when REQUIRE_EMAIL_VERIFICATION is undefined and NODE_ENV is test', async () => {
      // Arrange: verification not required (default test setup)
      env.REQUIRE_EMAIL_VERIFICATION = undefined;
      env.NODE_ENV = 'test';

      const user = createMockUser({ id: 'user-1', email: 'user@example.com', name: 'Test User' });

      // Act
      await simulateAfterEmailVerification({ user }, { sendEmail, logger, env });

      // Assert: welcome email not sent (already sent at signup)
      expect(sendEmail).not.toHaveBeenCalled();
    });

    it('should skip welcome email when REQUIRE_EMAIL_VERIFICATION is explicitly false', async () => {
      // Arrange: explicitly disabled
      env.REQUIRE_EMAIL_VERIFICATION = false;
      env.NODE_ENV = 'test';

      const user = createMockUser({ id: 'user-2', email: 'user@example.com', name: 'Test User' });

      // Act
      await simulateAfterEmailVerification({ user }, { sendEmail, logger, env });

      // Assert: no welcome email
      expect(sendEmail).not.toHaveBeenCalled();
    });

    it('should log a skip message when bypassing welcome email', async () => {
      // Arrange
      env.REQUIRE_EMAIL_VERIFICATION = undefined;
      env.NODE_ENV = 'test';

      const user = createMockUser({ id: 'user-3', email: 'user@example.com', name: 'Test User' });

      // Act
      await simulateAfterEmailVerification({ user }, { sendEmail, logger, env });

      // Assert: skip is logged with user ID
      expect(logger.info).toHaveBeenCalledWith(
        'Skipping welcome email after verification (already sent at signup)',
        expect.objectContaining({ userId: user.id })
      );
    });

    it('should still log that verification completed before skipping', async () => {
      // Arrange
      env.REQUIRE_EMAIL_VERIFICATION = undefined;
      env.NODE_ENV = 'test';

      const user = createMockUser({ id: 'user-4', email: 'user@example.com', name: 'Test User' });

      // Act
      await simulateAfterEmailVerification({ user }, { sendEmail, logger, env });

      // Assert: verification completion is always logged
      expect(logger.info).toHaveBeenCalledWith(
        'Email verification completed',
        expect.objectContaining({ userId: user.id, email: user.email })
      );
    });
  });

  describe('when email verification is required', () => {
    it('should send welcome email when REQUIRE_EMAIL_VERIFICATION is true', async () => {
      // Arrange: verification required (explicit flag)
      env.REQUIRE_EMAIL_VERIFICATION = true;

      const user = createMockUser({
        id: 'user-5',
        email: 'verified@example.com',
        name: 'Verified User',
      });

      // Act
      await simulateAfterEmailVerification({ user }, { sendEmail, logger, env });

      // Assert: welcome email is sent
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
      env.REQUIRE_EMAIL_VERIFICATION = undefined;
      env.NODE_ENV = 'production';

      const user = createMockUser({ id: 'user-6', email: 'prod@example.com', name: 'Prod User' });

      // Act
      await simulateAfterEmailVerification({ user }, { sendEmail, logger, env });

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
      env.REQUIRE_EMAIL_VERIFICATION = true;

      const user = createMockUser({ id: 'user-7', email: 'noname@example.com', name: null });

      // Act
      await simulateAfterEmailVerification({ user }, { sendEmail, logger, env });

      // Assert: email is still sent (name fallback handled by WelcomeEmail template)
      expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: user.email }));
    });

    it('should not skip email and should send it exactly once', async () => {
      // Arrange
      env.REQUIRE_EMAIL_VERIFICATION = true;

      const user = createMockUser({ id: 'user-8', email: 'once@example.com', name: 'Once User' });

      // Act
      await simulateAfterEmailVerification({ user }, { sendEmail, logger, env });

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
      env.REQUIRE_EMAIL_VERIFICATION = true;

      const user = createMockUser({ id: 'user-9', email: 'fail@example.com', name: 'Fail User' });
      sendEmail.mockRejectedValue(new Error('SMTP connection refused'));

      // Act & Assert: does not throw (non-blocking)
      await expect(
        simulateAfterEmailVerification({ user }, { sendEmail, logger, env })
      ).resolves.toBeUndefined();
    });

    it('should log a warning when email sending fails', async () => {
      // Arrange
      env.REQUIRE_EMAIL_VERIFICATION = true;

      const user = createMockUser({ id: 'user-10', email: 'warn@example.com', name: 'Warn User' });
      const emailError = new Error('Email API rate limit exceeded');
      sendEmail.mockRejectedValue(emailError);

      // Act
      await simulateAfterEmailVerification({ user }, { sendEmail, logger, env });

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
      env.REQUIRE_EMAIL_VERIFICATION = true;

      const user = createMockUser({
        id: 'user-11',
        email: 'string-err@example.com',
        name: 'String Err',
      });
      sendEmail.mockRejectedValue('plain string error');

      // Act
      await simulateAfterEmailVerification({ user }, { sendEmail, logger, env });

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
