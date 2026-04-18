/**
 * Auth Config Database Hook Tests
 *
 * Tests the better-auth database hooks that handle:
 * - OAuth invitation email validation BEFORE user creation (before hook)
 * - Role assignment BEFORE user creation via return value (before hook)
 * - OAuth invitation token deletion in before hook (prevents race conditions)
 * - Default user preferences setting for all new users (after hook)
 * - Welcome email sending for all new users (after hook)
 * - Non-blocking error handling
 *
 * Test Coverage:
 * Before hook:
 * - Apply admin role when valid invitation token and matching email
 * - Do not apply role when role is 'USER' (default)
 * - Reject when invitation email doesn't match OAuth email (throws APIError)
 * - Reject when invitationEmail present but invitationToken absent (throws APIError)
 * - Return unmodified user when no invitation state
 * - Return unmodified user when token is invalid
 * - Not block signup if getOAuthState throws (non-APIError)
 * - Not apply role for non-OAuth paths
 *
 * After hook:
 * - Default preferences set for OAuth signup
 * - Default preferences set for email/password signup
 * - Non-blocking error handling (preferences failures don't break signup)
 * - OAuth signup: no invitation processing (token already deleted in before hook)
 * - Welcome email sent for OAuth signup
 * - Welcome email sent for email/password signup when requiresVerification=false
 * - Welcome email skipped for email/password signup when requiresVerification=true
 * - Non-blocking error handling (email failures don't break signup)
 * - Non-blocking error handling (invitation failures don't break signup)
 *
 * @see /Users/simonholmes/Documents/Dev/studio/sunrise/lib/auth/config.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as React from 'react';
import { createMockUser } from '@/tests/types/mocks';
import type { InvitationRecord } from '@/lib/utils/invitation-token';
import type { UserCreateData, DatabaseHookContext } from '@/lib/auth/config';

// ---------------------------------------------------------------------------
// Mutable env object — individual tests mutate fields to exercise branches.
// Reset in beforeEach.
// ---------------------------------------------------------------------------

const mockEnv = {
  REQUIRE_EMAIL_VERIFICATION: undefined as boolean | undefined,
  NODE_ENV: 'test' as 'test' | 'development' | 'production',
  BETTER_AUTH_URL: 'http://localhost:3000',
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

vi.mock('@/lib/utils/invitation-token', () => ({
  validateInvitationToken: vi.fn(),
  deleteInvitationToken: vi.fn(),
  getValidInvitation: vi.fn(),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    user: {
      update: vi.fn(),
    },
    account: {
      findFirst: vi.fn(),
    },
    verification: {
      findFirst: vi.fn(),
    },
  },
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

vi.mock('@/emails/verify-email', () => ({
  default: vi.fn(() => React.createElement('div', {}, 'Verify Email')),
}));

vi.mock('@/emails/reset-password', () => ({
  default: vi.fn(() => React.createElement('div', {}, 'Reset Password Email')),
}));

// ---------------------------------------------------------------------------
// Shared mock references (populated in beforeEach)
// ---------------------------------------------------------------------------

type MockedFn = ReturnType<typeof vi.fn>;

interface SharedMocks {
  getOAuthState: MockedFn;
  sendEmail: MockedFn;
  validateInvitationToken: MockedFn;
  deleteInvitationToken: MockedFn;
  getValidInvitation: MockedFn;
  APIError: new (
    status: string,
    body?: { code?: string; message?: string }
  ) => Error & {
    status: string;
  };
  prisma: {
    user: { update: MockedFn };
    verification: { findFirst: MockedFn };
  };
  logger: {
    info: MockedFn;
    warn: MockedFn;
    debug: MockedFn;
    error: MockedFn;
  };
}

// ---------------------------------------------------------------------------
// Helper: build a UserCreateData-compatible object from createMockUser.
// UserCreateData requires emailVerified: boolean which MockUser lacks.
// ---------------------------------------------------------------------------

function makeUserCreateData(
  overrides?: Partial<ReturnType<typeof createMockUser>> & { emailVerified?: boolean }
): UserCreateData {
  const base = createMockUser(overrides);
  return {
    ...base,
    emailVerified: overrides?.emailVerified ?? false,
  } as UserCreateData;
}

// ===========================================================================
// Test Suites
// ===========================================================================

describe('lib/auth/config - databaseHooks.user.create', () => {
  let mocks: SharedMocks;
  let userCreateBeforeHook: (
    user: UserCreateData,
    ctx: DatabaseHookContext
  ) => Promise<{ data: UserCreateData }>;
  let userCreateAfterHook: (user: UserCreateData, ctx: DatabaseHookContext) => Promise<void>;

  beforeEach(async () => {
    // Reset env to safe defaults — individual tests override as needed
    mockEnv.REQUIRE_EMAIL_VERIFICATION = undefined;
    mockEnv.NODE_ENV = 'test';
    mockEnv.BETTER_AUTH_URL = 'http://localhost:3000';

    vi.clearAllMocks();

    // Import mocked modules
    const oauthApi = await import('better-auth/api');
    const emailSend = await import('@/lib/email/send');
    const invitationToken = await import('@/lib/utils/invitation-token');
    const db = await import('@/lib/db/client');
    const logging = await import('@/lib/logging');

    // Import real hook implementations
    const config = await import('@/lib/auth/config');
    userCreateBeforeHook = config.userCreateBeforeHook;
    userCreateAfterHook = config.userCreateAfterHook;

    mocks = {
      getOAuthState: vi.mocked(oauthApi.getOAuthState),
      // @ts-expect-error - APIError mock class assigned for instanceof checks
      APIError: oauthApi.APIError,
      sendEmail: vi.mocked(emailSend.sendEmail),
      validateInvitationToken: vi.mocked(invitationToken.validateInvitationToken),
      deleteInvitationToken: vi.mocked(invitationToken.deleteInvitationToken),
      getValidInvitation: vi.mocked(invitationToken.getValidInvitation),
      prisma: {
        user: {
          update: vi.mocked(db.prisma.user.update),
        },
        verification: {
          findFirst: vi.mocked(db.prisma.verification.findFirst),
        },
      },
      logger: {
        info: vi.mocked(logging.logger.info),
        warn: vi.mocked(logging.logger.warn),
        debug: vi.mocked(logging.logger.debug),
        error: vi.mocked(logging.logger.error),
      },
    };

    // Default mock behavior: email sending succeeds
    mocks.sendEmail.mockResolvedValue({ success: true, status: 'sent', id: 'email-123' });

    // Default mock behavior: preferences update succeeds
    mocks.prisma.user.update.mockResolvedValue(createMockUser());

    // Default mock behavior: no valid invitation
    mocks.getValidInvitation.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // =========================================================================
  // before hook
  // =========================================================================

  describe('databaseHooks.user.create.before', () => {
    it('should apply admin role when valid invitation token and matching email', async () => {
      // Arrange
      const mockUser = makeUserCreateData({
        id: 'oauth-before-admin',
        email: 'admin@example.com',
        role: 'USER',
      });

      const mockInvitation: InvitationRecord = {
        email: 'admin@example.com',
        metadata: {
          name: 'Admin User',
          role: 'ADMIN',
          invitedBy: 'super-admin-id',
          invitedAt: new Date().toISOString(),
        },
        expiresAt: new Date(Date.now() + 86400000),
        createdAt: new Date(),
      };

      mocks.getOAuthState.mockResolvedValue({
        invitationToken: 'valid-token-admin',
        invitationEmail: 'admin@example.com',
      });
      mocks.validateInvitationToken.mockResolvedValue(true);
      mocks.getValidInvitation.mockResolvedValue(mockInvitation);
      mocks.deleteInvitationToken.mockResolvedValue(undefined);

      const ctx: DatabaseHookContext = { path: '/api/auth/callback/google' };

      // Act
      const result = await userCreateBeforeHook(mockUser, ctx);

      // Assert: role should be applied in returned data
      expect(result.data.role).toBe('ADMIN');
      expect(result.data).toEqual(expect.objectContaining({ ...mockUser, role: 'ADMIN' }));

      expect(mocks.validateInvitationToken).toHaveBeenCalledWith(
        'admin@example.com',
        'valid-token-admin'
      );
      expect(mocks.getValidInvitation).toHaveBeenCalledWith('admin@example.com');
      // Token consumed immediately in before hook to prevent race conditions
      expect(mocks.deleteInvitationToken).toHaveBeenCalledWith('admin@example.com');
      expect(mocks.logger.info).toHaveBeenCalledWith('OAuth invitation token consumed', {
        email: 'admin@example.com',
      });
      expect(mocks.logger.info).toHaveBeenCalledWith(
        'Applying invitation role to OAuth user before creation',
        { email: mockUser.email, role: 'ADMIN' }
      );
    });

    it('should NOT apply role when invitation role is USER (default role)', async () => {
      // Arrange
      const mockUser = makeUserCreateData({
        id: 'oauth-before-user',
        email: 'user@example.com',
        role: 'USER',
      });

      const mockInvitation: InvitationRecord = {
        email: 'user@example.com',
        metadata: {
          name: 'Regular User',
          role: 'USER',
          invitedBy: 'admin-id',
          invitedAt: new Date().toISOString(),
        },
        expiresAt: new Date(Date.now() + 86400000),
        createdAt: new Date(),
      };

      mocks.getOAuthState.mockResolvedValue({
        invitationToken: 'valid-token-user',
        invitationEmail: 'user@example.com',
      });
      mocks.validateInvitationToken.mockResolvedValue(true);
      mocks.getValidInvitation.mockResolvedValue(mockInvitation);
      mocks.deleteInvitationToken.mockResolvedValue(undefined);

      const ctx: DatabaseHookContext = { path: '/api/auth/callback/google' };

      // Act
      const result = await userCreateBeforeHook(mockUser, ctx);

      // Assert: user returned unchanged (USER is default, no role override needed)
      expect(result.data).toEqual(expect.objectContaining(mockUser));
      expect(result.data.role).toBe('USER');

      // Token is still consumed even for USER-role invitations (prevent reuse)
      expect(mocks.deleteInvitationToken).toHaveBeenCalledWith('user@example.com');

      // Role-apply log should NOT have been called
      expect(mocks.logger.info).not.toHaveBeenCalledWith(
        'Applying invitation role to OAuth user before creation',
        expect.any(Object)
      );
    });

    it('should throw APIError when invitation email does not match OAuth email', async () => {
      // Arrange
      const mockUser = makeUserCreateData({
        id: 'oauth-before-mismatch',
        email: 'actual@example.com',
      });

      mocks.getOAuthState.mockResolvedValue({
        invitationToken: 'token-mismatch',
        invitationEmail: 'different@example.com', // mismatch!
      });

      const ctx: DatabaseHookContext = { path: '/api/auth/callback/google' };

      // Act & Assert: should throw with the invitation email in the message
      await expect(userCreateBeforeHook(mockUser, ctx)).rejects.toThrow(
        'This invitation was sent to different@example.com'
      );

      // Token validation should not have been called (rejected before reaching that branch)
      expect(mocks.validateInvitationToken).not.toHaveBeenCalled();
      expect(mocks.getValidInvitation).not.toHaveBeenCalled();
    });

    it("should throw APIError when invitationEmail is present but user's OAuth email does not match", async () => {
      // Arrange: OAuth state has invitationEmail but no invitationToken.
      // The email matches so we reach the token branch — but since there is no token,
      // validateInvitationToken is never called and user is returned unmodified.
      // However if the emails differ, the hook throws immediately before the token check.
      // This test covers the email-mismatch path where invitationToken is absent.
      const mockUser = makeUserCreateData({
        id: 'oauth-before-no-token',
        email: 'other@example.com',
      });

      mocks.getOAuthState.mockResolvedValue({
        invitationEmail: 'invitee@example.com',
        // invitationToken deliberately absent
      });

      const ctx: DatabaseHookContext = { path: '/api/auth/callback/google' };

      // Act & Assert: email mismatch → APIError mentioning the invitee address
      await expect(userCreateBeforeHook(mockUser, ctx)).rejects.toThrow('invitee@example.com');

      expect(mocks.validateInvitationToken).not.toHaveBeenCalled();
    });

    it('should return unmodified user when there is no OAuth invitation state', async () => {
      // Arrange
      const mockUser = makeUserCreateData({
        id: 'oauth-before-nostate',
        email: 'nostate@example.com',
      });

      mocks.getOAuthState.mockResolvedValue(null);

      const ctx: DatabaseHookContext = { path: '/api/auth/callback/google' };

      // Act
      const result = await userCreateBeforeHook(mockUser, ctx);

      // Assert: user returned unchanged
      expect(result.data).toEqual(expect.objectContaining(mockUser));
      expect(mocks.validateInvitationToken).not.toHaveBeenCalled();
      expect(mocks.getValidInvitation).not.toHaveBeenCalled();
    });

    it('should return unmodified user when invitation token is invalid', async () => {
      // Arrange
      const mockUser = makeUserCreateData({
        id: 'oauth-before-invalid',
        email: 'invalid@example.com',
      });

      mocks.getOAuthState.mockResolvedValue({
        invitationToken: 'invalid-token',
        invitationEmail: 'invalid@example.com',
      });
      mocks.validateInvitationToken.mockResolvedValue(false);

      const ctx: DatabaseHookContext = { path: '/api/auth/callback/google' };

      // Act
      const result = await userCreateBeforeHook(mockUser, ctx);

      // Assert: user returned unchanged (invalid token means no role change)
      expect(result.data).toEqual(expect.objectContaining(mockUser));
      expect(mocks.getValidInvitation).not.toHaveBeenCalled();
      // Token not consumed — validation failed so we never reached deleteInvitationToken
      expect(mocks.deleteInvitationToken).not.toHaveBeenCalled();
      expect(mocks.logger.info).not.toHaveBeenCalledWith(
        'Applying invitation role to OAuth user before creation',
        expect.any(Object)
      );
    });

    it('should not block signup if getOAuthState throws a non-APIError', async () => {
      // Arrange
      const mockUser = makeUserCreateData({
        id: 'oauth-before-stateerror',
        email: 'stateerror@example.com',
      });

      mocks.getOAuthState.mockRejectedValue(new Error('OAuth state service unavailable'));

      const ctx: DatabaseHookContext = { path: '/api/auth/callback/google' };

      // Act: should not throw
      const result = await userCreateBeforeHook(mockUser, ctx);

      // Assert: user returned unchanged, error logged
      expect(result.data).toEqual(expect.objectContaining(mockUser));
      expect(mocks.logger.error).toHaveBeenCalledWith(
        'Error checking OAuth invitation in before hook',
        expect.any(Error)
      );
    });

    it('should not block signup when getValidInvitation throws inside the invitation-valid branch', async () => {
      // Arrange: set up a matching email + valid token so we enter the isValidToken branch
      const mockUser = makeUserCreateData({
        id: 'oauth-before-getinv-throws',
        email: 'invitee@example.com',
      });

      mocks.getOAuthState.mockResolvedValue({
        invitationEmail: 'invitee@example.com',
        invitationToken: 'valid-token',
      });
      mocks.validateInvitationToken.mockResolvedValue(true);
      // getValidInvitation throws — outer catch should swallow it and return user unchanged
      const dbError = new Error('DB connection lost');
      mocks.getValidInvitation.mockRejectedValue(dbError);

      const ctx: DatabaseHookContext = { path: '/callback/google' };

      // Act
      const result = await userCreateBeforeHook(mockUser, ctx);

      // Assert: hook returns user unchanged (no role applied, no throw)
      expect(result).toEqual({ data: mockUser });
      expect(result.data.role).toBe(mockUser.role);

      // Assert: error logged with the thrown error
      expect(mocks.logger.error).toHaveBeenCalledWith(
        'Error checking OAuth invitation in before hook',
        dbError
      );

      // Assert: deleteInvitationToken was NOT called — getValidInvitation threw before
      // deleteInvitationToken is reached (source order: getValidInvitation L95, deleteInvitationToken L99)
      expect(mocks.deleteInvitationToken).not.toHaveBeenCalled();
    });

    it('should return unmodified user for non-OAuth paths (email/password signup)', async () => {
      // Arrange
      const mockUser = makeUserCreateData({
        id: 'email-before-user',
        email: 'emailsignup@example.com',
      });

      const ctx: DatabaseHookContext = { path: '/api/auth/signup' };

      // Act
      const result = await userCreateBeforeHook(mockUser, ctx);

      // Assert: user returned unchanged, getOAuthState not called for non-OAuth path
      expect(result.data).toEqual(expect.objectContaining(mockUser));
      expect(mocks.getOAuthState).not.toHaveBeenCalled();
      expect(mocks.validateInvitationToken).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // after hook
  // =========================================================================

  describe('databaseHooks.user.create.after', () => {
    describe('OAuth invitation flow', () => {
      it('should set preferences and send welcome email for OAuth invitation user (token already deleted in before hook)', async () => {
        // Arrange: Create OAuth user — role and token deletion were handled in the before hook
        const mockUser = makeUserCreateData({
          id: 'oauth-user-123',
          email: 'invited@example.com',
          role: 'ADMIN', // Role was already set by the before hook
        });

        // Mock preferences update (the only update call in after hook)
        mocks.prisma.user.update.mockResolvedValueOnce({
          ...mockUser,
          preferences: { email: { marketing: false, productUpdates: true, securityAlerts: true } },
        });

        const ctx: DatabaseHookContext = { path: '/api/auth/callback/google' };

        // Act
        await userCreateAfterHook(mockUser, ctx);

        // Assert: Only ONE prisma.user.update call (preferences only, no role update)
        const updateCalls = vi.mocked(mocks.prisma.user.update).mock.calls;
        expect(updateCalls.length).toBe(1);
        expect(updateCalls[0]?.[0]).toEqual(
          expect.objectContaining({
            where: { id: mockUser.id },
            data: expect.objectContaining({
              preferences: expect.objectContaining({
                email: expect.objectContaining({
                  marketing: false,
                  productUpdates: true,
                  securityAlerts: true,
                }),
              }),
            }),
          })
        );

        // Assert: Token deletion and validation do NOT happen in after hook
        expect(mocks.validateInvitationToken).not.toHaveBeenCalled();
        expect(mocks.deleteInvitationToken).not.toHaveBeenCalled();

        // Assert: Welcome email was sent (OAuth → always sent immediately)
        expect(mocks.sendEmail).toHaveBeenCalledWith(
          expect.objectContaining({
            to: mockUser.email,
            subject: 'Welcome to Sunrise',
          })
        );
      });

      it('should only set preferences for OAuth signup — no invitation processing in after hook', async () => {
        // Arrange: OAuth user with USER role — token was already deleted in the before hook
        const mockUser = makeUserCreateData({
          id: 'oauth-user-456',
          email: 'user@example.com',
          role: 'USER',
        });

        mocks.prisma.user.update.mockResolvedValue({
          ...mockUser,
          preferences: { email: { marketing: false, productUpdates: true, securityAlerts: true } },
        });

        const ctx: DatabaseHookContext = { path: '/api/auth/callback/google' };

        // Act
        await userCreateAfterHook(mockUser, ctx);

        // Assert: Only ONE update call (preferences only)
        const updateCalls = vi.mocked(mocks.prisma.user.update).mock.calls;
        expect(updateCalls.length).toBe(1);
        expect(updateCalls[0]?.[0]).toEqual(
          expect.objectContaining({
            where: { id: mockUser.id },
          })
        );

        // Assert: No invitation processing in after hook
        expect(mocks.validateInvitationToken).not.toHaveBeenCalled();
        expect(mocks.deleteInvitationToken).not.toHaveBeenCalled();
      });

      it('should complete OAuth signup without invitation processing in after hook', async () => {
        // Token validation and deletion now happen in the before hook.
        // The after hook does not inspect OAuth invitation state at all.
        const mockUser = makeUserCreateData({
          id: 'oauth-user-789',
          email: 'invalid@example.com',
        });

        const ctx: DatabaseHookContext = { path: '/api/auth/callback/google' };

        // Act
        await userCreateAfterHook(mockUser, ctx);

        // Assert: No invitation processing in after hook
        expect(mocks.getOAuthState).not.toHaveBeenCalled();
        expect(mocks.validateInvitationToken).not.toHaveBeenCalled();
        expect(mocks.deleteInvitationToken).not.toHaveBeenCalled();

        // Assert: Only preferences update
        const updateCalls = vi.mocked(mocks.prisma.user.update).mock.calls;
        expect(updateCalls.length).toBe(1);

        // Assert: User creation continued (welcome email sent — OAuth path)
        expect(mocks.sendEmail).toHaveBeenCalledWith(
          expect.objectContaining({
            to: mockUser.email,
            subject: 'Welcome to Sunrise',
          })
        );
      });

      it('should gracefully handle OAuth signup — after hook does not process invitation state', async () => {
        // After hook no longer reads OAuth state at all; before hook handles all invitation logic
        const mockUser = makeUserCreateData({
          id: 'oauth-user-999',
          email: 'actual@example.com',
        });

        const ctx: DatabaseHookContext = { path: '/api/auth/callback/google' };

        // Act: after hook does not touch invitation state
        await userCreateAfterHook(mockUser, ctx);

        // Assert: No invitation processing
        expect(mocks.getOAuthState).not.toHaveBeenCalled();
        expect(mocks.validateInvitationToken).not.toHaveBeenCalled();
        expect(mocks.deleteInvitationToken).not.toHaveBeenCalled();

        // Assert: Preferences were still set
        const updateCalls = vi.mocked(mocks.prisma.user.update).mock.calls;
        expect(updateCalls.length).toBe(1);
        expect(updateCalls[0]?.[0]).toEqual(
          expect.objectContaining({
            where: { id: mockUser.id },
            data: expect.objectContaining({
              preferences: expect.objectContaining({
                email: expect.objectContaining({
                  marketing: false,
                  productUpdates: true,
                  securityAlerts: true,
                }),
              }),
            }),
          })
        );

        // Assert: Welcome email still sent (OAuth path is always immediate)
        expect(mocks.sendEmail).toHaveBeenCalledWith(
          expect.objectContaining({
            to: mockUser.email,
          })
        );
      });

      it('should set preferences and send welcome email for OAuth signup without invitation', async () => {
        // After hook no longer reads OAuth state — it skips all invitation processing for OAuth
        const mockUser = makeUserCreateData({
          id: 'oauth-user-000',
          email: 'nostate@example.com',
        });

        const ctx: DatabaseHookContext = { path: '/api/auth/callback/google' };

        // Act
        await userCreateAfterHook(mockUser, ctx);

        // Assert: No invitation processing at all
        expect(mocks.getOAuthState).not.toHaveBeenCalled();
        expect(mocks.validateInvitationToken).not.toHaveBeenCalled();
        expect(mocks.deleteInvitationToken).not.toHaveBeenCalled();

        // Assert: User creation succeeded (welcome email sent)
        expect(mocks.sendEmail).toHaveBeenCalledWith(
          expect.objectContaining({
            to: mockUser.email,
          })
        );
      });

      it('should not block user creation if preferences update fails for OAuth signup', async () => {
        // After hook no longer processes invitations for OAuth — only preferences + welcome email
        const mockUser = makeUserCreateData({
          id: 'oauth-user-error',
          email: 'error@example.com',
        });

        mocks.prisma.user.update.mockRejectedValueOnce(new Error('Database connection failed'));

        const ctx: DatabaseHookContext = { path: '/api/auth/callback/google' };

        // Act: should not throw
        await userCreateAfterHook(mockUser, ctx);

        // Assert: Error was logged
        expect(mocks.logger.error).toHaveBeenCalledWith(
          'Failed to set default preferences',
          expect.any(Error),
          { userId: mockUser.id }
        );

        // Assert: Welcome email still sent (error in preferences does not block email)
        expect(mocks.sendEmail).toHaveBeenCalledWith(
          expect.objectContaining({
            to: mockUser.email,
          })
        );
      });
    });

    describe('Welcome email sending', () => {
      it('should send welcome email for OAuth signup', async () => {
        // Arrange
        const mockUser = makeUserCreateData({
          id: 'oauth-user-welcome',
          email: 'oauth@example.com',
          name: 'OAuth User',
        });

        const ctx: DatabaseHookContext = { path: '/api/auth/callback/google' };

        // Act
        await userCreateAfterHook(mockUser, ctx);

        // Assert: welcome email sent and logged
        expect(mocks.logger.info).toHaveBeenCalledWith('Sending welcome email to new user', {
          userId: mockUser.id,
          userEmail: mockUser.email,
          signupMethod: 'OAuth',
          isInvitation: false,
        });
        expect(mocks.sendEmail).toHaveBeenCalledWith({
          to: mockUser.email,
          subject: 'Welcome to Sunrise',
          react: expect.any(Object),
        });
      });

      it('should send welcome email when requiresVerification=false and signup is email/password', async () => {
        // Arrange: verification disabled → welcome sent immediately
        mockEnv.REQUIRE_EMAIL_VERIFICATION = false;

        const mockUser = makeUserCreateData({
          id: 'email-user-welcome',
          email: 'email@example.com',
          name: 'Email User',
        });

        const ctx: DatabaseHookContext = { path: '/api/auth/signup' };

        // Act
        await userCreateAfterHook(mockUser, ctx);

        // Assert: welcome sent immediately
        expect(mocks.logger.info).toHaveBeenCalledWith('Sending welcome email to new user', {
          userId: mockUser.id,
          userEmail: mockUser.email,
          signupMethod: 'email/password',
          isInvitation: false,
        });
        expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
        expect(mocks.sendEmail).toHaveBeenCalledWith({
          to: mockUser.email,
          subject: 'Welcome to Sunrise',
          react: expect.any(Object),
        });
      });

      it('should skip welcome email when requiresVerification=true and signup is email/password non-invitation', async () => {
        // Arrange: verification required → welcome deferred until after verification
        mockEnv.REQUIRE_EMAIL_VERIFICATION = true;

        const mockUser = makeUserCreateData({
          id: 'email-user-skip',
          email: 'skipwelcome@example.com',
          name: 'Skip User',
        });

        // No active invitation
        mocks.getValidInvitation.mockResolvedValue(null);

        const ctx: DatabaseHookContext = { path: '/api/auth/signup' };

        // Act
        await userCreateAfterHook(mockUser, ctx);

        // Assert: welcome email NOT sent; skip message logged
        expect(mocks.sendEmail).not.toHaveBeenCalled();
        expect(mocks.logger.info).toHaveBeenCalledWith(
          'Skipping welcome email (will send after email verification)',
          {
            userId: mockUser.id,
            userEmail: mockUser.email,
            signupMethod: 'email/password',
          }
        );
      });

      it('should not block user creation if welcome email fails', async () => {
        // Arrange
        mockEnv.REQUIRE_EMAIL_VERIFICATION = false;

        const mockUser = makeUserCreateData({
          id: 'email-fail-user',
          email: 'emailfail@example.com',
        });

        mocks.sendEmail.mockRejectedValue(new Error('SMTP server unavailable'));

        const ctx: DatabaseHookContext = { path: '/api/auth/signup' };

        // Act: should not throw
        await userCreateAfterHook(mockUser, ctx);

        // Assert: Send was attempted
        expect(mocks.sendEmail).toHaveBeenCalledWith(
          expect.objectContaining({
            to: mockUser.email,
          })
        );

        // Assert: Failure logged, signup not blocked
        expect(mocks.logger.warn).toHaveBeenCalledWith('Failed to send welcome email', {
          userId: mockUser.id,
          userEmail: mockUser.email,
          signupMethod: 'email/password',
          error: 'SMTP server unavailable',
        });
      });

      it('should send welcome email even when invitation processing fails (password signup)', async () => {
        // Invitation processing for password signups calls getValidInvitation — verify
        // a failure there doesn't block the welcome email.
        mockEnv.REQUIRE_EMAIL_VERIFICATION = false;

        const mockUser = makeUserCreateData({
          id: 'invitation-fail-user',
          email: 'invfail@example.com',
        });

        mocks.getValidInvitation.mockRejectedValue(new Error('Database error'));

        const ctx: DatabaseHookContext = { path: '/api/auth/signup' };

        // Act
        await userCreateAfterHook(mockUser, ctx);

        // Assert: invitation error was logged
        expect(mocks.logger.error).toHaveBeenCalledWith(
          'Error processing invitation in database hook',
          expect.any(Error),
          expect.any(Object)
        );

        // Assert: welcome email still sent
        expect(mocks.sendEmail).toHaveBeenCalledWith(
          expect.objectContaining({
            to: mockUser.email,
            subject: 'Welcome to Sunrise',
          })
        );
      });
    });

    describe('Default preferences setting', () => {
      it('should set default preferences for OAuth signup', async () => {
        // Arrange
        const mockUser = makeUserCreateData({
          id: 'oauth-user-prefs',
          email: 'prefs@example.com',
        });

        mocks.prisma.user.update.mockResolvedValue({
          ...mockUser,
          preferences: { email: { marketing: false, productUpdates: true, securityAlerts: true } },
        });

        const ctx: DatabaseHookContext = { path: '/api/auth/callback/google' };

        // Act
        await userCreateAfterHook(mockUser, ctx);

        // Assert: preferences update was first (and only) update call
        const updateCalls = vi.mocked(mocks.prisma.user.update).mock.calls;
        expect(updateCalls.length).toBe(1);
        expect(updateCalls[0]?.[0]).toEqual(
          expect.objectContaining({
            where: { id: mockUser.id },
            data: expect.objectContaining({
              preferences: expect.objectContaining({
                email: expect.objectContaining({
                  marketing: false,
                  productUpdates: true,
                  securityAlerts: true,
                }),
              }),
            }),
          })
        );

        expect(mocks.logger.info).toHaveBeenCalledWith('Default preferences set for new user', {
          userId: mockUser.id,
          signupMethod: 'OAuth',
        });
      });

      it('should set default preferences for email/password signup', async () => {
        // Arrange
        mockEnv.REQUIRE_EMAIL_VERIFICATION = false;

        const mockUser = makeUserCreateData({
          id: 'email-user-prefs',
          email: 'emailprefs@example.com',
        });

        mocks.prisma.user.update.mockResolvedValue({
          ...mockUser,
          preferences: { email: { marketing: false, productUpdates: true, securityAlerts: true } },
        });

        const ctx: DatabaseHookContext = { path: '/api/auth/signup' };

        // Act
        await userCreateAfterHook(mockUser, ctx);

        // Assert: correct update arguments passed to prisma
        expect(mocks.prisma.user.update).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { id: mockUser.id },
            data: expect.objectContaining({
              preferences: expect.objectContaining({
                email: expect.objectContaining({
                  marketing: false,
                  productUpdates: true,
                  securityAlerts: true,
                }),
              }),
            }),
          })
        );

        expect(mocks.logger.info).toHaveBeenCalledWith('Default preferences set for new user', {
          userId: mockUser.id,
          signupMethod: 'email/password',
        });
      });

      it('should not block user creation if preferences setting fails', async () => {
        // Arrange
        mockEnv.REQUIRE_EMAIL_VERIFICATION = false;

        const mockUser = makeUserCreateData({
          id: 'prefs-fail-user',
          email: 'prefsfail@example.com',
        });

        mocks.prisma.user.update
          .mockRejectedValueOnce(new Error('Database write failed'))
          .mockResolvedValue(mockUser);

        const ctx: DatabaseHookContext = { path: '/api/auth/signup' };

        // Act: should not throw
        await userCreateAfterHook(mockUser, ctx);

        // Assert: Error was logged
        expect(mocks.logger.error).toHaveBeenCalledWith(
          'Failed to set default preferences',
          expect.any(Error),
          {
            userId: mockUser.id,
          }
        );

        // Assert: User creation continued (welcome email still attempted)
        expect(mocks.sendEmail).toHaveBeenCalledWith(
          expect.objectContaining({
            to: mockUser.email,
          })
        );
      });

      it('should set preferences only in after hook — token deletion is in before hook', async () => {
        // Token deletion happens in the before hook now, not the after hook.
        // After hook only sets preferences and sends welcome email.
        const mockUser = makeUserCreateData({
          id: 'oauth-user-role-prefs',
          email: 'roleprefs@example.com',
          role: 'ADMIN', // Role was set by the before hook
        });

        mocks.prisma.user.update.mockResolvedValueOnce({
          ...mockUser,
          preferences: { email: { marketing: false, productUpdates: true, securityAlerts: true } },
        });

        const ctx: DatabaseHookContext = { path: '/api/auth/callback/google' };

        // Act
        await userCreateAfterHook(mockUser, ctx);

        // Assert: Exactly ONE prisma.user.update (preferences only — no role update)
        const updateCalls = vi.mocked(mocks.prisma.user.update).mock.calls;
        expect(updateCalls.length).toBe(1);

        expect(updateCalls[0]?.[0]).toEqual(
          expect.objectContaining({
            where: { id: mockUser.id },
            data: expect.objectContaining({
              preferences: expect.objectContaining({
                email: expect.objectContaining({
                  marketing: false,
                  productUpdates: true,
                  securityAlerts: true,
                }),
              }),
            }),
          })
        );

        // Assert: No token deletion in after hook — it was done in the before hook
        expect(mocks.deleteInvitationToken).not.toHaveBeenCalled();
      });
    });

    describe('Signup method detection', () => {
      it('should detect OAuth signup from callback path', async () => {
        // Arrange
        const mockUser = makeUserCreateData({ email: 'test@example.com' });

        const oauthPaths = [
          '/api/auth/callback/google',
          '/api/auth/callback/github',
          '/auth/callback/facebook',
        ];

        for (const path of oauthPaths) {
          vi.clearAllMocks();
          mocks.sendEmail.mockResolvedValue({ success: true, status: 'sent', id: 'email-123' });
          mocks.prisma.user.update.mockResolvedValue(createMockUser());

          // Act
          await userCreateAfterHook(mockUser, { path });

          // Assert: OAuth signup method detected and logged
          expect(mocks.logger.info).toHaveBeenCalledWith(
            'Sending welcome email to new user',
            expect.objectContaining({
              signupMethod: 'OAuth',
            })
          );
        }
      });

      it('should detect email/password signup from non-callback path', async () => {
        // Arrange
        mockEnv.REQUIRE_EMAIL_VERIFICATION = false;
        const mockUser = makeUserCreateData({ email: 'test@example.com' });

        const emailPaths = ['/api/auth/signup', '/auth/register', undefined];

        for (const path of emailPaths) {
          vi.clearAllMocks();
          // Re-set env after clearAllMocks (clearAllMocks doesn't reset mockEnv)
          mockEnv.REQUIRE_EMAIL_VERIFICATION = false;
          mocks.sendEmail.mockResolvedValue({ success: true, status: 'sent', id: 'email-123' });
          mocks.prisma.user.update.mockResolvedValue(createMockUser());
          mocks.getValidInvitation.mockResolvedValue(null);

          // Act
          await userCreateAfterHook(mockUser, path !== undefined ? { path } : null);

          // Assert: email/password signup method detected and logged
          expect(mocks.logger.info).toHaveBeenCalledWith(
            'Sending welcome email to new user',
            expect.objectContaining({
              signupMethod: 'email/password',
            })
          );
        }
      });
    });
  });
});
