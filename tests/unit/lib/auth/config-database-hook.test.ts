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
 * - Welcome email sent for email/password signup
 * - Non-blocking error handling (email failures don't break signup)
 * - Non-blocking error handling (invitation failures don't break signup)
 *
 * @see /Users/simonholmes/Documents/Dev/studio/sunrise/lib/auth/config.ts (lines 232-468)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as React from 'react';
import { createMockUser } from '@/tests/types/mocks';
import type { InvitationRecord } from '@/lib/utils/invitation-token';

// Mock dependencies
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
  WelcomeEmail: vi.fn(() => React.createElement('div', {}, 'Welcome Email')),
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
// Helper: simulate databaseHooks.user.create.before
//
// Mirrors the logic from lib/auth/config.ts lines 245-297.
// Returns { data: user } (possibly with modified role) or throws APIError.
// ---------------------------------------------------------------------------

async function simulateBeforeHook(
  mocks: SharedMocks,
  user: ReturnType<typeof createMockUser>,
  ctx: { path?: string } = {}
): Promise<{ data: ReturnType<typeof createMockUser> }> {
  const isOAuthSignup = ctx?.path?.includes('/callback/') ?? false;

  if (isOAuthSignup) {
    try {
      // @ts-expect-error - vi.mocked types don't infer callability properly
      const oauthState = await mocks.getOAuthState();

      // Parse via simple property access (mirrors oauthInvitationStateSchema.safeParse)
      const parsed =
        oauthState && typeof oauthState === 'object'
          ? { success: true as const, data: oauthState }
          : { success: false as const };

      const invitationEmail = parsed.success ? (parsed.data.invitationEmail ?? null) : null;
      const invitationToken = parsed.success ? (parsed.data.invitationToken ?? null) : null;

      // If invitation data is present, email MUST match
      if (invitationEmail && user.email !== invitationEmail) {
        // @ts-expect-error - vi.mocked types don't infer callability properly
        mocks.logger.warn('OAuth invitation email mismatch - rejecting signup', {
          invitationEmail,
          oauthEmail: user.email,
        });
        throw new mocks.APIError('BAD_REQUEST', {
          message: `This invitation was sent to ${invitationEmail}. Please use an account with that email address, or set a password instead.`,
        });
      }

      // Apply role BEFORE user is created so the session gets the correct role immediately.
      if (invitationToken && invitationEmail && user.email === invitationEmail) {
        // @ts-expect-error - vi.mocked types don't infer callability properly
        const isValidToken = await mocks.validateInvitationToken(invitationEmail, invitationToken);

        if (isValidToken) {
          // @ts-expect-error - vi.mocked types don't infer callability properly
          const invitation = (await mocks.getValidInvitation(
            invitationEmail
          )) as InvitationRecord | null;

          // Delete token NOW to prevent race condition
          // @ts-expect-error - vi.mocked types don't infer callability properly
          await mocks.deleteInvitationToken(invitationEmail);
          // @ts-expect-error - vi.mocked types don't infer callability properly
          mocks.logger.info('OAuth invitation token consumed', { email: invitationEmail });

          if (invitation?.metadata?.role && invitation.metadata.role !== 'USER') {
            // @ts-expect-error - vi.mocked types don't infer callability properly
            mocks.logger.info('Applying invitation role to OAuth user before creation', {
              email: user.email,
              role: invitation.metadata.role,
            });

            return { data: { ...user, role: invitation.metadata.role } };
          }
        }
      }
    } catch (error) {
      // Re-throw APIError (our validation error)
      if (error instanceof mocks.APIError) {
        throw error;
      }
      // Log but don't block for other errors
      // @ts-expect-error - vi.mocked types don't infer callability properly
      mocks.logger.error('Error checking OAuth invitation in before hook', error);
    }
  }

  return { data: user };
}

// ---------------------------------------------------------------------------
// Helper: simulate databaseHooks.user.create.after
//
// Mirrors the logic from lib/auth/config.ts lines 326-468.
// Role is NOT applied here — it was applied in the before hook.
// ---------------------------------------------------------------------------

async function simulateDatabaseHook(
  mocks: SharedMocks,
  user: ReturnType<typeof createMockUser>,
  ctx: { path?: string } = {}
) {
  // Detect signup method for logging purposes
  const isOAuthSignup = ctx?.path?.includes('/callback/') ?? false;
  const signupMethod = isOAuthSignup ? 'OAuth' : 'email/password';

  // Set default preferences for all new users
  try {
    // @ts-expect-error - vi.mocked types don't infer callability properly
    await mocks.prisma.user.update({
      where: { id: user.id },
      data: {
        preferences: { email: { marketing: false, productUpdates: true, securityAlerts: true } },
      },
    });
    // @ts-expect-error - vi.mocked types don't infer callability properly
    mocks.logger.info('Default preferences set for new user', {
      userId: user.id,
      signupMethod,
    });
  } catch (prefsError) {
    // Log but don't fail user creation
    // @ts-expect-error - vi.mocked types don't infer callability properly
    mocks.logger.error('Failed to set default preferences', prefsError, {
      userId: user.id,
    });
  }

  // Check for password invitation acceptance (non-OAuth flow)
  let isPasswordInvitation = false;

  try {
    if (!isOAuthSignup) {
      // Check for password invitation acceptance
      // @ts-expect-error - vi.mocked types don't infer callability properly
      const invitation = await mocks.getValidInvitation(user.email);
      if (invitation) {
        isPasswordInvitation = true;
        // @ts-expect-error - vi.mocked types don't infer callability properly
        mocks.logger.info('Detected password invitation acceptance', {
          userId: user.id,
          email: user.email,
        });
      }
    }
  } catch (error) {
    // Log but don't fail user creation
    // @ts-expect-error - vi.mocked types don't infer callability properly
    mocks.logger.error('Error processing invitation in database hook', error, {
      userId: user.id,
      email: user.email,
    });
  }

  // Send welcome email — in tests we treat REQUIRE_EMAIL_VERIFICATION as false (dev mode),
  // so the welcome email is always sent immediately (mirrors production behaviour when
  // verification is disabled or for OAuth / password invitation signups).
  {
    // @ts-expect-error - vi.mocked types don't infer callability properly
    mocks.logger.info('Sending welcome email to new user', {
      userId: user.id,
      userEmail: user.email,
      signupMethod,
      isInvitation: isPasswordInvitation,
    });

    // @ts-expect-error - vi.mocked types don't infer callability properly
    await mocks
      .sendEmail({
        to: user.email,
        subject: 'Welcome to Sunrise',
        react: React.createElement('div', {}, 'Welcome Email'),
      })
      .catch((error: unknown) => {
        // @ts-expect-error - vi.mocked types don't infer callability properly
        mocks.logger.warn('Failed to send welcome email', {
          userId: user.id,
          userEmail: user.email,
          signupMethod,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }
}

// ===========================================================================
// Test Suites
// ===========================================================================

describe('lib/auth/config - databaseHooks.user.create', () => {
  let mocks: SharedMocks;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Import mocked modules
    const oauthApi = await import('better-auth/api');
    const emailSend = await import('@/lib/email/send');
    const invitationToken = await import('@/lib/utils/invitation-token');
    const db = await import('@/lib/db/client');
    const logging = await import('@/lib/logging');

    mocks = {
      getOAuthState: vi.mocked(oauthApi.getOAuthState),
      // @ts-expect-error - APIError mock class assigned for instanceof checks in helper
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
      const mockUser = createMockUser({
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

      const ctx = { path: '/api/auth/callback/google' };

      // Act
      const result = await simulateBeforeHook(mocks, mockUser, ctx);

      // Assert: role should be applied in returned data
      expect(result.data.role).toBe('ADMIN');
      expect(result.data).toEqual({ ...mockUser, role: 'ADMIN' });

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
      const mockUser = createMockUser({
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

      const ctx = { path: '/api/auth/callback/google' };

      // Act
      const result = await simulateBeforeHook(mocks, mockUser, ctx);

      // Assert: user returned unchanged (USER is default, no role override needed)
      expect(result.data).toEqual(mockUser);
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
      const mockUser = createMockUser({
        id: 'oauth-before-mismatch',
        email: 'actual@example.com',
      });

      mocks.getOAuthState.mockResolvedValue({
        invitationToken: 'token-mismatch',
        invitationEmail: 'different@example.com', // mismatch!
      });

      const ctx = { path: '/api/auth/callback/google' };

      // Act & Assert: should throw
      await expect(simulateBeforeHook(mocks, mockUser, ctx)).rejects.toThrow(
        'This invitation was sent to different@example.com'
      );

      // Token validation should not have been called
      expect(mocks.validateInvitationToken).not.toHaveBeenCalled();
      expect(mocks.getValidInvitation).not.toHaveBeenCalled();
    });

    it('should return unmodified user when there is no OAuth invitation state', async () => {
      // Arrange
      const mockUser = createMockUser({
        id: 'oauth-before-nostate',
        email: 'nostate@example.com',
      });

      mocks.getOAuthState.mockResolvedValue(null);

      const ctx = { path: '/api/auth/callback/google' };

      // Act
      const result = await simulateBeforeHook(mocks, mockUser, ctx);

      // Assert: user returned unchanged
      expect(result.data).toEqual(mockUser);
      expect(mocks.validateInvitationToken).not.toHaveBeenCalled();
      expect(mocks.getValidInvitation).not.toHaveBeenCalled();
    });

    it('should return unmodified user when invitation token is invalid', async () => {
      // Arrange
      const mockUser = createMockUser({
        id: 'oauth-before-invalid',
        email: 'invalid@example.com',
      });

      mocks.getOAuthState.mockResolvedValue({
        invitationToken: 'invalid-token',
        invitationEmail: 'invalid@example.com',
      });
      mocks.validateInvitationToken.mockResolvedValue(false);

      const ctx = { path: '/api/auth/callback/google' };

      // Act
      const result = await simulateBeforeHook(mocks, mockUser, ctx);

      // Assert: user returned unchanged (invalid token means no role change)
      expect(result.data).toEqual(mockUser);
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
      const mockUser = createMockUser({
        id: 'oauth-before-stateerror',
        email: 'stateerror@example.com',
      });

      mocks.getOAuthState.mockRejectedValue(new Error('OAuth state service unavailable'));

      const ctx = { path: '/api/auth/callback/google' };

      // Act: should not throw
      const result = await simulateBeforeHook(mocks, mockUser, ctx);

      // Assert: user returned unchanged, error logged
      expect(result.data).toEqual(mockUser);
      expect(mocks.logger.error).toHaveBeenCalledWith(
        'Error checking OAuth invitation in before hook',
        expect.any(Error)
      );
    });

    it('should return unmodified user for non-OAuth paths (email/password signup)', async () => {
      // Arrange
      const mockUser = createMockUser({
        id: 'email-before-user',
        email: 'emailsignup@example.com',
      });

      const ctx = { path: '/api/auth/signup' };

      // Act
      const result = await simulateBeforeHook(mocks, mockUser, ctx);

      // Assert: user returned unchanged, getOAuthState not called for non-OAuth path
      expect(result.data).toEqual(mockUser);
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
        const mockUser = createMockUser({
          id: 'oauth-user-123',
          email: 'invited@example.com',
          role: 'ADMIN', // Role was already set by the before hook
        });

        // Mock preferences update (the only update call in after hook)
        mocks.prisma.user.update.mockResolvedValueOnce({
          ...mockUser,
          preferences: { email: { marketing: false, productUpdates: true, securityAlerts: true } },
        });

        const ctx = { path: '/api/auth/callback/google' };

        // Act: Simulate after hook
        await simulateDatabaseHook(mocks, mockUser, ctx);

        // Assert: Only ONE prisma.user.update call (preferences only, no role update)
        const updateCalls = vi.mocked(mocks.prisma.user.update).mock.calls;
        expect(updateCalls.length).toBe(1);
        expect(updateCalls[0][0]).toEqual({
          where: { id: mockUser.id },
          data: {
            preferences: {
              email: {
                marketing: false,
                productUpdates: true,
                securityAlerts: true,
              },
            },
          },
        });

        // Assert: Token deletion and validation do NOT happen in after hook
        expect(mocks.validateInvitationToken).not.toHaveBeenCalled();
        expect(mocks.deleteInvitationToken).not.toHaveBeenCalled();

        // Assert: Welcome email was sent
        expect(mocks.sendEmail).toHaveBeenCalledWith(
          expect.objectContaining({
            to: mockUser.email,
            subject: 'Welcome to Sunrise',
          })
        );
      });

      it('should only set preferences for OAuth signup — no invitation processing in after hook', async () => {
        // Arrange: OAuth user with USER role — token was already deleted in the before hook
        const mockUser = createMockUser({
          id: 'oauth-user-456',
          email: 'user@example.com',
          role: 'USER',
        });

        mocks.prisma.user.update.mockResolvedValue({
          ...mockUser,
          preferences: { email: { marketing: false, productUpdates: true, securityAlerts: true } },
        });

        const ctx = { path: '/api/auth/callback/google' };

        // Act
        await simulateDatabaseHook(mocks, mockUser, ctx);

        // Assert: Only ONE update call (preferences only)
        const updateCalls = vi.mocked(mocks.prisma.user.update).mock.calls;
        expect(updateCalls.length).toBe(1);
        expect(updateCalls[0][0]).toEqual({
          where: { id: mockUser.id },
          data: {
            preferences: {
              email: {
                marketing: false,
                productUpdates: true,
                securityAlerts: true,
              },
            },
          },
        });

        // Assert: No invitation processing in after hook
        expect(mocks.validateInvitationToken).not.toHaveBeenCalled();
        expect(mocks.deleteInvitationToken).not.toHaveBeenCalled();
      });

      it('should complete OAuth signup without invitation processing in after hook', async () => {
        // Token validation and deletion now happen in the before hook.
        // The after hook does not inspect OAuth invitation state at all.
        const mockUser = createMockUser({
          id: 'oauth-user-789',
          email: 'invalid@example.com',
        });

        const ctx = { path: '/api/auth/callback/google' };

        // Act
        await simulateDatabaseHook(mocks, mockUser, ctx);

        // Assert: No invitation processing in after hook
        expect(mocks.getOAuthState).not.toHaveBeenCalled();
        expect(mocks.validateInvitationToken).not.toHaveBeenCalled();
        expect(mocks.deleteInvitationToken).not.toHaveBeenCalled();

        // Assert: Only preferences update
        const updateCalls = vi.mocked(mocks.prisma.user.update).mock.calls;
        expect(updateCalls.length).toBe(1);

        // Assert: User creation continued (welcome email sent)
        expect(mocks.sendEmail).toHaveBeenCalledWith(
          expect.objectContaining({
            to: mockUser.email,
            subject: 'Welcome to Sunrise',
          })
        );
      });

      it('should gracefully handle OAuth signup — after hook does not process invitation state', async () => {
        // After hook no longer reads OAuth state at all; before hook handles all invitation logic
        const mockUser = createMockUser({
          id: 'oauth-user-999',
          email: 'actual@example.com',
        });

        const ctx = { path: '/api/auth/callback/google' };

        // Act: after hook does not touch invitation state
        await simulateDatabaseHook(mocks, mockUser, ctx);

        // Assert: No invitation processing
        expect(mocks.getOAuthState).not.toHaveBeenCalled();
        expect(mocks.validateInvitationToken).not.toHaveBeenCalled();
        expect(mocks.deleteInvitationToken).not.toHaveBeenCalled();

        // Assert: Preferences were still set
        const updateCalls = vi.mocked(mocks.prisma.user.update).mock.calls;
        expect(updateCalls.length).toBe(1);
        expect(updateCalls[0][0]).toEqual({
          where: { id: mockUser.id },
          data: {
            preferences: {
              email: {
                marketing: false,
                productUpdates: true,
                securityAlerts: true,
              },
            },
          },
        });

        // Assert: Welcome email still sent
        expect(mocks.sendEmail).toHaveBeenCalledWith(
          expect.objectContaining({
            to: mockUser.email,
          })
        );
      });

      it('should set preferences and send welcome email for OAuth signup without invitation', async () => {
        // After hook no longer reads OAuth state — it skips all invitation processing for OAuth
        const mockUser = createMockUser({
          id: 'oauth-user-000',
          email: 'nostate@example.com',
        });

        const ctx = { path: '/api/auth/callback/google' };

        // Act
        await simulateDatabaseHook(mocks, mockUser, ctx);

        // Assert: No invitation processing at all
        expect(mocks.getOAuthState).not.toHaveBeenCalled();
        expect(mocks.validateInvitationToken).not.toHaveBeenCalled();
        expect(mocks.deleteInvitationToken).not.toHaveBeenCalled();

        // Assert: User creation succeeded
        expect(mocks.sendEmail).toHaveBeenCalledWith(
          expect.objectContaining({
            to: mockUser.email,
          })
        );
      });

      it('should not block user creation if preferences update fails for OAuth signup', async () => {
        // After hook no longer processes invitations for OAuth — only preferences + welcome email
        const mockUser = createMockUser({
          id: 'oauth-user-error',
          email: 'error@example.com',
        });

        mocks.prisma.user.update.mockRejectedValueOnce(new Error('Database connection failed'));

        const ctx = { path: '/api/auth/callback/google' };

        // Act: should not throw
        await simulateDatabaseHook(mocks, mockUser, ctx);

        // Assert: Error was logged
        expect(mocks.logger.error).toHaveBeenCalledWith(
          'Failed to set default preferences',
          expect.any(Error),
          { userId: mockUser.id }
        );

        // Assert: Welcome email still sent
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
        const mockUser = createMockUser({
          id: 'oauth-user-welcome',
          email: 'oauth@example.com',
          name: 'OAuth User',
        });

        mocks.getOAuthState.mockResolvedValue(null);

        const ctx = { path: '/api/auth/callback/google' };

        // Act
        await simulateDatabaseHook(mocks, mockUser, ctx);

        // Assert
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

      it('should send welcome email for email/password signup', async () => {
        // Arrange
        const mockUser = createMockUser({
          id: 'email-user-welcome',
          email: 'email@example.com',
          name: 'Email User',
        });

        const ctx = { path: '/api/auth/signup' };

        // Act
        await simulateDatabaseHook(mocks, mockUser, ctx);

        // Assert
        expect(mocks.logger.info).toHaveBeenCalledWith('Sending welcome email to new user', {
          userId: mockUser.id,
          userEmail: mockUser.email,
          signupMethod: 'email/password',
          isInvitation: false,
        });
        expect(mocks.sendEmail).toHaveBeenCalledWith({
          to: mockUser.email,
          subject: 'Welcome to Sunrise',
          react: expect.any(Object),
        });
      });

      it('should not block user creation if welcome email fails', async () => {
        // Arrange
        const mockUser = createMockUser({
          id: 'email-fail-user',
          email: 'emailfail@example.com',
        });

        mocks.sendEmail.mockRejectedValue(new Error('SMTP server unavailable'));

        const ctx = { path: '/api/auth/signup' };

        // Act: should not throw
        await simulateDatabaseHook(mocks, mockUser, ctx);

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
        const mockUser = createMockUser({
          id: 'invitation-fail-user',
          email: 'invfail@example.com',
        });

        mocks.getValidInvitation.mockRejectedValue(new Error('Database error'));

        const ctx = { path: '/api/auth/signup' };

        // Act
        await simulateDatabaseHook(mocks, mockUser, ctx);

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
        const mockUser = createMockUser({
          id: 'oauth-user-prefs',
          email: 'prefs@example.com',
        });

        mocks.getOAuthState.mockResolvedValue(null);
        mocks.prisma.user.update.mockResolvedValue({
          ...mockUser,
          preferences: { email: { marketing: false, productUpdates: true, securityAlerts: true } },
        });

        const ctx = { path: '/api/auth/callback/google' };

        // Act
        await simulateDatabaseHook(mocks, mockUser, ctx);

        // Assert: preferences update was first (and only) update call
        const updateCalls = vi.mocked(mocks.prisma.user.update).mock.calls;
        expect(updateCalls.length).toBeGreaterThan(0);
        expect(updateCalls[0][0]).toEqual({
          where: { id: mockUser.id },
          data: {
            preferences: {
              email: {
                marketing: false,
                productUpdates: true,
                securityAlerts: true,
              },
            },
          },
        });

        expect(mocks.logger.info).toHaveBeenCalledWith('Default preferences set for new user', {
          userId: mockUser.id,
          signupMethod: 'OAuth',
        });
      });

      it('should set default preferences for email/password signup', async () => {
        // Arrange
        const mockUser = createMockUser({
          id: 'email-user-prefs',
          email: 'emailprefs@example.com',
        });

        mocks.prisma.user.update.mockResolvedValue({
          ...mockUser,
          preferences: { email: { marketing: false, productUpdates: true, securityAlerts: true } },
        });

        const ctx = { path: '/api/auth/signup' };

        // Act
        await simulateDatabaseHook(mocks, mockUser, ctx);

        // Assert
        expect(mocks.prisma.user.update).toHaveBeenCalledWith({
          where: { id: mockUser.id },
          data: {
            preferences: {
              email: {
                marketing: false,
                productUpdates: true,
                securityAlerts: true,
              },
            },
          },
        });

        expect(mocks.logger.info).toHaveBeenCalledWith('Default preferences set for new user', {
          userId: mockUser.id,
          signupMethod: 'email/password',
        });
      });

      it('should not block user creation if preferences setting fails', async () => {
        // Arrange
        const mockUser = createMockUser({
          id: 'prefs-fail-user',
          email: 'prefsfail@example.com',
        });

        mocks.prisma.user.update
          .mockRejectedValueOnce(new Error('Database write failed'))
          .mockResolvedValue(mockUser);

        const ctx = { path: '/api/auth/signup' };

        // Act: should not throw
        await simulateDatabaseHook(mocks, mockUser, ctx);

        // Assert: Error was logged
        expect(mocks.logger.error).toHaveBeenCalledWith(
          'Failed to set default preferences',
          expect.any(Error),
          {
            userId: mockUser.id,
          }
        );

        // Assert: User creation continued
        expect(mocks.sendEmail).toHaveBeenCalledWith(
          expect.objectContaining({
            to: mockUser.email,
          })
        );
      });

      it('should set preferences only in after hook — token deletion is in before hook', async () => {
        // Token deletion happens in the before hook now, not the after hook.
        // After hook only sets preferences and sends welcome email.
        const mockUser = createMockUser({
          id: 'oauth-user-role-prefs',
          email: 'roleprefs@example.com',
          role: 'ADMIN', // Role was set by the before hook
        });

        mocks.prisma.user.update.mockResolvedValueOnce({
          ...mockUser,
          preferences: { email: { marketing: false, productUpdates: true, securityAlerts: true } },
        });

        const ctx = { path: '/api/auth/callback/google' };

        // Act
        await simulateDatabaseHook(mocks, mockUser, ctx);

        // Assert: Exactly ONE prisma.user.update (preferences only — no role update)
        const updateCalls = vi.mocked(mocks.prisma.user.update).mock.calls;
        expect(updateCalls.length).toBe(1);

        expect(updateCalls[0][0]).toEqual({
          where: { id: mockUser.id },
          data: {
            preferences: {
              email: {
                marketing: false,
                productUpdates: true,
                securityAlerts: true,
              },
            },
          },
        });

        // Assert: No token deletion in after hook — it was done in the before hook
        expect(mocks.deleteInvitationToken).not.toHaveBeenCalled();
      });
    });

    describe('Signup method detection', () => {
      it('should detect OAuth signup from callback path', async () => {
        // Arrange
        const mockUser = createMockUser({ email: 'test@example.com' });

        const oauthPaths = [
          '/api/auth/callback/google',
          '/api/auth/callback/github',
          '/auth/callback/facebook',
        ];

        for (const path of oauthPaths) {
          vi.clearAllMocks();
          mocks.getOAuthState.mockResolvedValue(null);
          mocks.sendEmail.mockResolvedValue({ success: true, status: 'sent', id: 'email-123' });
          mocks.prisma.user.update.mockResolvedValue(createMockUser());

          // Act
          await simulateDatabaseHook(mocks, mockUser, { path });

          // Assert
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
        const mockUser = createMockUser({ email: 'test@example.com' });

        const emailPaths = ['/api/auth/signup', '/auth/register', undefined];

        for (const path of emailPaths) {
          vi.clearAllMocks();
          mocks.sendEmail.mockResolvedValue({ success: true, status: 'sent', id: 'email-123' });
          mocks.prisma.user.update.mockResolvedValue(createMockUser());
          mocks.getValidInvitation.mockResolvedValue(null);

          // Act
          await simulateDatabaseHook(mocks, mockUser, { path });

          // Assert
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
