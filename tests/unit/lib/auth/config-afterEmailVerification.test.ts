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
  // Identity passthrough — lib/auth/config.ts wraps its `hooks.before` body in
  // this at module load, so an unmocked export throws on import (#463).
  createAuthMiddleware: vi.fn((fn: unknown) => fn),
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

// Distinctive brand name so the welcome-subject assertion proves BRAND.name
// interpolation rather than the "Sunrise" default (covered by lib/brand.test.tsx).
vi.mock('@/lib/brand', () => ({ BRAND: { name: 'Aurora Labs' } }));

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

vi.mock('@/emails/change-email-approval', () => ({
  default: vi.fn(() => React.createElement('div', {}, 'Change Email Approval')),
}));

// The discriminator is mocked here so these cases exercise the hook's BRANCHING
// rather than JWT decoding — the decoding itself is pinned in
// tests/unit/lib/auth/change-email.test.ts. Defaults to "signup" so every
// pre-existing case in this file keeps its original meaning.
vi.mock('@/lib/auth/change-email', () => ({
  parseEmailChangeToken: vi.fn().mockResolvedValue(null),
  getVerificationTokenFromRequest: vi.fn(() => undefined),
}));

vi.mock('@/lib/auth/sessions', () => ({
  revokeUserSessions: vi.fn().mockResolvedValue(0),
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
  let afterEmailVerificationHook: (
    user: {
      id: string;
      email: string;
      name: string | null;
    },
    request?: Request
  ) => Promise<void>;
  let parseEmailChangeToken: ReturnType<typeof vi.fn>;
  let revokeUserSessions: ReturnType<typeof vi.fn>;
  let getSessionMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Reset env to safe defaults
    mockEnv.REQUIRE_EMAIL_VERIFICATION = undefined;
    mockEnv.NODE_ENV = 'test';
    mockEnv.BETTER_AUTH_URL = 'http://localhost:3000';

    // Import mocked modules and real hook
    const emailSend = await import('@/lib/email/send');
    const logging = await import('@/lib/logging');
    const changeEmail = await import('@/lib/auth/change-email');
    const sessions = await import('@/lib/auth/sessions');
    const authConfig = await import('@/lib/auth/config');

    sendEmail = vi.mocked(emailSend.sendEmail);
    logger = {
      info: vi.mocked(logging.logger.info),
      warn: vi.mocked(logging.logger.warn),
      debug: vi.mocked(logging.logger.debug),
      error: vi.mocked(logging.logger.error),
    };
    afterEmailVerificationHook = authConfig.afterEmailVerificationHook;

    // `clearAllMocks` wipes implementations set at declaration, so restore the
    // "this is a signup" default every case below (except the change block)
    // depends on.
    parseEmailChangeToken = vi.mocked(changeEmail.parseEmailChangeToken);
    parseEmailChangeToken.mockResolvedValue(null);
    revokeUserSessions = vi.mocked(sessions.revokeUserSessions);
    revokeUserSessions.mockResolvedValue(0);

    // `auth` is a real module-level export of `betterAuth(...)`'s mocked
    // return value — grab this call's `getSession` to control what "the
    // current session" looks like per case.
    getSessionMock = vi.mocked(authConfig.auth.api.getSession);
    getSessionMock.mockResolvedValue(null);

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
          subject: 'Welcome to Aurora Labs',
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
          subject: 'Welcome to Aurora Labs',
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

  // better-auth fires this same callback at the end of an email CHANGE, not
  // just a signup verification, and hands it an already-updated user — so
  // nothing in the arguments distinguishes the two. Getting it wrong greets an
  // established user with "Welcome!" and, worse, leaves the sessions that
  // predate the change alive (#489).
  describe('when the verification completed an email CHANGE', () => {
    const changeRequest = new Request(
      'https://app.example.com/api/auth/verify-email?token=change-token'
    );

    beforeEach(() => {
      parseEmailChangeToken.mockResolvedValue({
        previousEmail: 'old@example.com',
        newEmail: 'new@example.com',
      });
    });

    it('revokes the user other sessions', async () => {
      // The point of the whole issue: this is the moment the address actually
      // moves, so a session stolen beforehand must not survive it.
      mockEnv.REQUIRE_EMAIL_VERIFICATION = true;
      const user = createMockUser({ id: 'user-20', email: 'new@example.com', name: 'Mover' });

      await afterEmailVerificationHook(user, changeRequest);

      expect(revokeUserSessions).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-20', reason: 'email_changed' })
      );
    });

    it('spares the session getSession can identify on the request', async () => {
      getSessionMock.mockResolvedValue({ session: { token: 'visible-session-token' } });
      mockEnv.REQUIRE_EMAIL_VERIFICATION = true;
      const user = createMockUser({ id: 'user-24', email: 'new@example.com', name: 'Mover' });

      await afterEmailVerificationHook(user, changeRequest);

      expect(revokeUserSessions).toHaveBeenCalledWith(
        expect.objectContaining({ exceptSessionToken: 'visible-session-token' })
      );
    });

    it('spares no session when the request carries no visible one', async () => {
      // Clicking the new-address link from a device or browser with no app
      // cookie is the ORDINARY case for a mail link. better-auth mints no
      // session for it (since 1.7.16), so sparing "the newest row" would spare
      // a session from before the change, which may be the stolen one.
      getSessionMock.mockResolvedValue(null);
      mockEnv.REQUIRE_EMAIL_VERIFICATION = true;
      const user = createMockUser({ id: 'user-25', email: 'new@example.com', name: 'Mover' });

      await afterEmailVerificationHook(user, changeRequest);

      expect(revokeUserSessions).toHaveBeenCalledWith({
        userId: 'user-25',
        exceptSessionToken: null,
        reason: 'email_changed',
      });
    });

    it('does NOT send the welcome email, even in production', async () => {
      // The signup guard below only asks whether verification was required,
      // which is true in production — so without an explicit change check an
      // existing user gets welcomed to the product all over again.
      mockEnv.REQUIRE_EMAIL_VERIFICATION = true;
      const user = createMockUser({ id: 'user-21', email: 'new@example.com', name: 'Mover' });

      await afterEmailVerificationHook(user, changeRequest);

      expect(sendEmail).not.toHaveBeenCalled();
    });

    it('still completes when session revocation fails', async () => {
      // better-auth does NOT wrap this callback in its error handling, so a
      // throw here surfaces as a failed verification click for a change that
      // already committed to the database.
      mockEnv.REQUIRE_EMAIL_VERIFICATION = true;
      revokeUserSessions.mockRejectedValue(new Error('database unreachable'));
      const user = createMockUser({ id: 'user-22', email: 'new@example.com', name: 'Mover' });

      await expect(afterEmailVerificationHook(user, changeRequest)).resolves.toBeUndefined();
      expect(logger.error).toHaveBeenCalledWith(
        'Failed to revoke sessions after email change',
        expect.anything(),
        expect.objectContaining({ userId: 'user-22' })
      );
    });

    it('leaves the ordinary signup path alone when it is not a change', async () => {
      // Guards the other direction: a signup must still get its welcome email
      // and must NOT have its sessions revoked.
      parseEmailChangeToken.mockResolvedValue(null);
      mockEnv.REQUIRE_EMAIL_VERIFICATION = true;
      const user = createMockUser({ id: 'user-23', email: 'new@example.com', name: 'Newbie' });

      await afterEmailVerificationHook(user, changeRequest);

      expect(revokeUserSessions).not.toHaveBeenCalled();
      expect(sendEmail).toHaveBeenCalledTimes(1);
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
