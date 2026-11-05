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

// Discriminator mocked so these cases exercise the hook's branching; the
// decoding itself is pinned in tests/unit/lib/auth/change-email.test.ts.
// Defaults to "signup" so every pre-existing case keeps its meaning.
vi.mock('@/lib/auth/change-email', () => ({
  parseEmailChangeToken: vi.fn().mockResolvedValue(null),
  getVerificationTokenFromRequest: vi.fn(() => undefined),
}));

vi.mock('@/lib/auth/sessions', () => ({
  revokeUserSessions: vi.fn().mockResolvedValue(0),
}));

vi.mock('@/emails/change-email-approval', () => ({
  default: vi.fn(() => React.createElement('div', {}, 'Change Email Approval')),
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
  let parseEmailChangeToken: ReturnType<typeof vi.fn>;
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
    const changeEmail = await import('@/lib/auth/change-email');
    const authConfig = await import('@/lib/auth/config');

    // `clearAllMocks` wipes declaration-time implementations, so restore the
    // "this is a signup" default the rest of this file assumes.
    parseEmailChangeToken = vi.mocked(changeEmail.parseEmailChangeToken);
    parseEmailChangeToken.mockResolvedValue(null);

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

      try {
        const user = createMockUser({ id: 'user-5', email: 'timer@example.com', name: 'Timer' });
        const url = 'https://example.com/verify?token=abc&callbackURL=%2F';

        // Act
        await sendVerificationEmailHook({ user, url, token: 'abc' });

        // Assert: expiresAt is exactly 24 hours later
        expect(VerifyEmailEmail).toHaveBeenCalledWith(
          expect.objectContaining({ expiresAt: new Date('2026-04-21T12:00:00Z') })
        );
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // better-auth routes the new-address leg of an email CHANGE through this same
  // callback, with `user.email` already set to the NEW address. The invitation
  // skip below is correct for a signup and wrong for a change (#489).
  describe('email change (not a signup)', () => {
    beforeEach(() => {
      parseEmailChangeToken.mockResolvedValue({
        previousEmail: 'old@example.com',
        newEmail: 'new@example.com',
      });
    });

    it('sends to the new address even when it holds a pending invitation', async () => {
      // The strand bug. An existing user moving to an address that happens to
      // have an open invitation would otherwise get no email, no error, and an
      // account stuck mid-change forever — the invitation skip is about signup,
      // and this is not that.
      const user = createMockUser({ id: 'mover-1', email: 'new@example.com', name: 'Mover' });
      getValidInvitation.mockResolvedValue({
        id: 'inv-99',
        email: 'new@example.com',
        metadata: {},
      });

      await sendVerificationEmailHook({
        user,
        url: 'https://example.com/verify?token=abc&callbackURL=%2F',
        token: 'abc',
      });

      expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: 'new@example.com' }));
    });

    it('marks the callback so the page can say the address changed', async () => {
      // The click may leave the user signed out, and on an unverified account
      // verifies nothing, so the page must not take its signup path.
      const user = createMockUser({ id: 'user-30', email: 'new@example.com', name: 'Mover' });

      await sendVerificationEmailHook({
        user,
        url: 'https://example.com/verify?token=abc&callbackURL=%2F',
        token: 'change-token',
      });

      expect(VerifyEmailEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          verificationUrl:
            'https://example.com/verify?token=abc&callbackURL=%2Fverify-email%2Fcallback%3FemailChanged%3D1',
        })
      );
    });

    it('does not consult the invitation table at all for a change', async () => {
      const user = createMockUser({ id: 'mover-2', email: 'new@example.com', name: 'Mover' });

      await sendVerificationEmailHook({
        user,
        url: 'https://example.com/verify?token=abc&callbackURL=%2F',
        token: 'abc',
      });

      expect(getValidInvitation).not.toHaveBeenCalled();
      expect(sendEmail).toHaveBeenCalled();
    });
  });

  describe('invitation acceptance (should skip)', () => {
    // accept-invite runs the signup inside `runInvitedSignup`, after
    // validating the token, and marks the address verified itself (#1136).
    const metadata = {
      name: 'Invited',
      role: 'USER',
      invitedBy: 'admin-id',
      invitedAt: '2026-11-01T10:00:00.000Z',
    };

    it('does not send a verification email for an accept-invite signup, and says why', async () => {
      const { runInvitedSignup } = await import('@/lib/auth/signup-mode');
      const user = createMockUser({
        id: 'invited-1',
        email: 'invited@example.com',
        name: 'Invited',
      });

      await runInvitedSignup(
        () =>
          sendVerificationEmailHook({
            user,
            url: 'https://example.com/verify?token=abc',
            token: 'abc',
          }),
        metadata
      );

      expect(sendEmail).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith(
        'Skipping verification email for invitation acceptance',
        { userId: 'invited-1', email: 'invited@example.com' }
      );
    });

    it('sends a verification email to a public signup for an address with a pending invitation', async () => {
      // No token was presented: the address is unproven, whatever is pending
      // for it. Skipped, it would get no email at all (#1136 security review).
      getValidInvitation.mockResolvedValue({
        email: 'claimed@example.com',
        metadata,
        expiresAt: new Date(Date.now() + 86400000),
        createdAt: new Date(),
      });
      const user = createMockUser({ id: 'claimer', email: 'claimed@example.com', name: 'C' });

      await sendVerificationEmailHook({
        user,
        url: 'https://example.com/verify?token=abc',
        token: 'abc',
      });

      expect(sendEmail).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'claimed@example.com' })
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
  });
});
