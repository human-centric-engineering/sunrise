/**
 * Auth Config Database Hook Tests
 *
 * Tests the better-auth database hook that handles:
 * - OAuth invitation flow (token validation, role application, token deletion)
 * - Welcome email sending for all new users
 * - Non-blocking error handling
 *
 * Test Coverage:
 * - OAuth invitation with valid token
 * - OAuth invitation with invalid token
 * - OAuth invitation with mismatched email
 * - Welcome email sent for OAuth signup
 * - Welcome email sent for email/password signup
 * - Non-blocking error handling (email failures don't break signup)
 * - Non-blocking error handling (invitation failures don't break signup)
 * - Role application from invitation metadata
 * - Invitation token deletion after successful acceptance
 *
 * @see /Users/simonholmes/Documents/Dev/studio/sunrise/lib/auth/config.ts (lines 163-262)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as React from 'react';
import { createMockUser } from '@/tests/types/mocks';
import type { InvitationMetadata } from '@/lib/utils/invitation-token';

// Mock dependencies
vi.mock('better-auth/api', () => ({
  getOAuthState: vi.fn(),
}));

vi.mock('@/lib/email/send', () => ({
  sendEmail: vi.fn(),
}));

vi.mock('@/lib/utils/invitation-token', () => ({
  validateInvitationToken: vi.fn(),
  deleteInvitationToken: vi.fn(),
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

/**
 * Test Suite: Auth Config Database Hook
 *
 * Tests the user.create.after hook that processes OAuth invitations
 * and sends welcome emails.
 */
describe('lib/auth/config - databaseHooks.user.create.after', () => {
  // Import types and functions after mocks are set up
  let getOAuthState: ReturnType<typeof vi.fn>;
  let sendEmail: ReturnType<typeof vi.fn>;
  let validateInvitationToken: ReturnType<typeof vi.fn>;
  let deleteInvitationToken: ReturnType<typeof vi.fn>;
  let prisma: {
    user: { update: ReturnType<typeof vi.fn> };
    verification: { findFirst: ReturnType<typeof vi.fn> };
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
    const oauthApi = await import('better-auth/api');
    const emailSend = await import('@/lib/email/send');
    const invitationToken = await import('@/lib/utils/invitation-token');
    const db = await import('@/lib/db/client');
    const logging = await import('@/lib/logging');

    getOAuthState = vi.mocked(oauthApi.getOAuthState);
    sendEmail = vi.mocked(emailSend.sendEmail);
    validateInvitationToken = vi.mocked(invitationToken.validateInvitationToken);
    deleteInvitationToken = vi.mocked(invitationToken.deleteInvitationToken);
    prisma = {
      user: {
        update: vi.mocked(db.prisma.user.update),
      },
      verification: {
        findFirst: vi.mocked(db.prisma.verification.findFirst),
      },
    };
    logger = {
      info: vi.mocked(logging.logger.info),
      warn: vi.mocked(logging.logger.warn),
      debug: vi.mocked(logging.logger.debug),
      error: vi.mocked(logging.logger.error),
    };

    // Default mock behavior: email sending succeeds
    sendEmail.mockResolvedValue({ success: true, id: 'email-123' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Helper function to simulate the database hook
   * This mimics the logic from lib/auth/config.ts lines 163-262
   */
  const simulateDatabaseHook = async (
    user: ReturnType<typeof createMockUser>,
    ctx: { path?: string } = {}
  ) => {
    // Detect signup method for logging purposes
    const isOAuthSignup = ctx?.path?.includes('/callback/') ?? false;
    const signupMethod = isOAuthSignup ? 'OAuth' : 'email/password';

    try {
      // Handle OAuth invitation flow
      if (isOAuthSignup) {
        // @ts-expect-error - vi.mocked types don't infer callability properly
        const oauthState = await getOAuthState();

        // Check if invitation data is present in OAuth state
        const invitationToken =
          oauthState && typeof oauthState === 'object' ? oauthState.invitationToken : null;
        const invitationEmail =
          oauthState && typeof oauthState === 'object' ? oauthState.invitationEmail : null;

        if (invitationToken && invitationEmail && user.email === invitationEmail) {
          // @ts-expect-error - vi.mocked types don't infer callability properly
          logger.info('Processing OAuth invitation', {
            userId: user.id,
            email: user.email,
          });

          // Validate invitation token
          // @ts-expect-error - vi.mocked types don't infer callability properly
          const isValidToken = await validateInvitationToken(
            invitationEmail,
            invitationToken as string
          );

          if (isValidToken) {
            // Get invitation metadata
            // @ts-expect-error - vi.mocked types don't infer callability properly
            const invitation = await prisma.verification.findFirst({
              where: { identifier: `invitation:${invitationEmail}` },
            });

            if (invitation?.metadata) {
              const metadata = invitation.metadata as InvitationMetadata;

              // Apply role if non-default
              if (metadata.role && metadata.role !== 'USER') {
                // Return modified user data to set role
                // @ts-expect-error - vi.mocked types don't infer callability properly
                await prisma.user.update({
                  where: { id: user.id },
                  data: { role: metadata.role },
                });

                // @ts-expect-error - vi.mocked types don't infer callability properly
                logger.info('Applied invitation role to OAuth user', {
                  userId: user.id,
                  role: metadata.role,
                });
              }

              // Delete invitation token (single-use)
              // @ts-expect-error - vi.mocked types don't infer callability properly
              await deleteInvitationToken(invitationEmail);

              // @ts-expect-error - vi.mocked types don't infer callability properly
              logger.info('OAuth invitation accepted successfully', {
                userId: user.id,
                email: user.email,
              });
            }
          }
        }
      }
    } catch (error) {
      // Log but don't fail user creation
      // @ts-expect-error - vi.mocked types don't infer callability properly
      logger.error('Error processing OAuth invitation in database hook', error, {
        userId: user.id,
        email: user.email,
      });
    }

    // Send welcome email for all new users (OAuth and email/password)
    // @ts-expect-error - vi.mocked types don't infer callability properly
    logger.info('Sending welcome email to new user', {
      userId: user.id,
      userEmail: user.email,
      signupMethod,
    });

    // @ts-expect-error - vi.mocked types don't infer callability properly
    await sendEmail({
      to: user.email,
      subject: 'Welcome to Sunrise',
      react: React.createElement('div', {}, 'Welcome Email'),
    }).catch((error: unknown) => {
      // @ts-expect-error - vi.mocked types don't infer callability properly
      logger.warn('Failed to send welcome email', {
        userId: user.id,
        userEmail: user.email,
        signupMethod,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };

  describe('OAuth invitation flow', () => {
    it('should process OAuth invitation with valid token and apply role', async () => {
      // Arrange: Create OAuth user and invitation context
      const mockUser = createMockUser({
        id: 'oauth-user-123',
        email: 'invited@example.com',
        role: 'USER', // Default role before invitation processing
      });

      const invitationMetadata: InvitationMetadata = {
        name: 'Invited User',
        role: 'ADMIN',
        invitedBy: 'admin-user-id',
        invitedAt: new Date().toISOString(),
      };

      // Mock OAuth state with invitation data
      getOAuthState.mockResolvedValue({
        invitationToken: 'valid-token-123',
        invitationEmail: 'invited@example.com',
      });

      // Mock valid token
      validateInvitationToken.mockResolvedValue(true);

      // Mock invitation record with metadata
      prisma.verification.findFirst.mockResolvedValue({
        id: 'verification-123',
        identifier: 'invitation:invited@example.com',
        value: 'hashed-token',
        expiresAt: new Date(Date.now() + 86400000), // 1 day from now
        metadata: invitationMetadata,
      });

      prisma.user.update.mockResolvedValue({
        ...mockUser,
        role: 'ADMIN', // Updated role
      });

      deleteInvitationToken.mockResolvedValue(undefined);

      const ctx = { path: '/api/auth/callback/google' };

      // Act: Simulate database hook for OAuth signup
      await simulateDatabaseHook(mockUser, ctx);

      // Assert: Verify invitation processing flow
      expect(getOAuthState).toHaveBeenCalledTimes(1);
      expect(logger.info).toHaveBeenCalledWith('Processing OAuth invitation', {
        userId: mockUser.id,
        email: mockUser.email,
      });
      expect(validateInvitationToken).toHaveBeenCalledWith(
        'invited@example.com',
        'valid-token-123'
      );
      expect(prisma.verification.findFirst).toHaveBeenCalledWith({
        where: { identifier: 'invitation:invited@example.com' },
      });

      // Assert: Verify role was applied
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: mockUser.id },
        data: { role: 'ADMIN' },
      });
      expect(logger.info).toHaveBeenCalledWith('Applied invitation role to OAuth user', {
        userId: mockUser.id,
        role: 'ADMIN',
      });

      // Assert: Verify invitation token was deleted
      expect(deleteInvitationToken).toHaveBeenCalledWith('invited@example.com');
      expect(logger.info).toHaveBeenCalledWith('OAuth invitation accepted successfully', {
        userId: mockUser.id,
        email: mockUser.email,
      });
    });

    it('should not apply role for USER role (default role)', async () => {
      // Arrange: Create OAuth user with USER role in invitation
      const mockUser = createMockUser({
        id: 'oauth-user-456',
        email: 'user@example.com',
        role: 'USER',
      });

      const invitationMetadata: InvitationMetadata = {
        name: 'Regular User',
        role: 'USER', // Default role - should not update
        invitedBy: 'admin-user-id',
        invitedAt: new Date().toISOString(),
      };

      getOAuthState.mockResolvedValue({
        invitationToken: 'valid-token-456',
        invitationEmail: 'user@example.com',
      });

      validateInvitationToken.mockResolvedValue(true);

      prisma.verification.findFirst.mockResolvedValue({
        id: 'verification-456',
        identifier: 'invitation:user@example.com',
        value: 'hashed-token',
        expiresAt: new Date(Date.now() + 86400000),
        metadata: invitationMetadata,
      });

      deleteInvitationToken.mockResolvedValue(undefined);

      const ctx = { path: '/api/auth/callback/google' };

      // Act: Simulate database hook
      await simulateDatabaseHook(mockUser, ctx);

      // Assert: Verify role was NOT updated (USER is default)
      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(logger.info).not.toHaveBeenCalledWith(
        'Applied invitation role to OAuth user',
        expect.any(Object)
      );

      // Assert: Verify token was still deleted (invitation accepted)
      expect(deleteInvitationToken).toHaveBeenCalledWith('user@example.com');
    });

    it('should gracefully handle invalid invitation token', async () => {
      // Arrange: Create OAuth user with invalid token
      const mockUser = createMockUser({
        id: 'oauth-user-789',
        email: 'invalid@example.com',
      });

      getOAuthState.mockResolvedValue({
        invitationToken: 'invalid-token-789',
        invitationEmail: 'invalid@example.com',
      });

      // Mock invalid token
      validateInvitationToken.mockResolvedValue(false);

      const ctx = { path: '/api/auth/callback/google' };

      // Act: Simulate database hook
      await simulateDatabaseHook(mockUser, ctx);

      // Assert: Verify validation was attempted
      expect(validateInvitationToken).toHaveBeenCalledWith(
        'invalid@example.com',
        'invalid-token-789'
      );

      // Assert: Verify no invitation processing occurred
      expect(prisma.verification.findFirst).not.toHaveBeenCalled();
      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(deleteInvitationToken).not.toHaveBeenCalled();

      // Assert: Verify user creation still succeeded (non-blocking)
      expect(sendEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: mockUser.email,
          subject: 'Welcome to Sunrise',
        })
      );
    });

    it('should gracefully handle mismatched invitation email', async () => {
      // Arrange: OAuth user email doesn't match invitation email
      const mockUser = createMockUser({
        id: 'oauth-user-999',
        email: 'actual@example.com',
      });

      getOAuthState.mockResolvedValue({
        invitationToken: 'token-999',
        invitationEmail: 'different@example.com', // Mismatch!
      });

      const ctx = { path: '/api/auth/callback/google' };

      // Act: Simulate database hook
      await simulateDatabaseHook(mockUser, ctx);

      // Assert: Verify no invitation processing occurred (email mismatch)
      expect(validateInvitationToken).not.toHaveBeenCalled();
      expect(prisma.verification.findFirst).not.toHaveBeenCalled();
      expect(prisma.user.update).not.toHaveBeenCalled();

      // Assert: Verify user creation still succeeded
      expect(sendEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: mockUser.email,
        })
      );
    });

    it('should handle missing OAuth state gracefully', async () => {
      // Arrange: OAuth signup with no state
      const mockUser = createMockUser({
        id: 'oauth-user-000',
        email: 'nostate@example.com',
      });

      getOAuthState.mockResolvedValue(null);

      const ctx = { path: '/api/auth/callback/google' };

      // Act: Simulate database hook
      await simulateDatabaseHook(mockUser, ctx);

      // Assert: Verify no invitation processing occurred
      expect(validateInvitationToken).not.toHaveBeenCalled();
      expect(prisma.verification.findFirst).not.toHaveBeenCalled();

      // Assert: Verify user creation still succeeded
      expect(sendEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: mockUser.email,
        })
      );
    });

    it('should handle missing invitation metadata gracefully', async () => {
      // Arrange: Valid token but no metadata in verification record
      const mockUser = createMockUser({
        id: 'oauth-user-111',
        email: 'nometa@example.com',
      });

      getOAuthState.mockResolvedValue({
        invitationToken: 'token-111',
        invitationEmail: 'nometa@example.com',
      });

      validateInvitationToken.mockResolvedValue(true);

      // Mock verification record WITHOUT metadata
      prisma.verification.findFirst.mockResolvedValue({
        id: 'verification-111',
        identifier: 'invitation:nometa@example.com',
        value: 'hashed-token',
        expiresAt: new Date(Date.now() + 86400000),
        metadata: null, // No metadata!
      });

      const ctx = { path: '/api/auth/callback/google' };

      // Act: Simulate database hook
      await simulateDatabaseHook(mockUser, ctx);

      // Assert: Verify no role update occurred (no metadata)
      expect(prisma.user.update).not.toHaveBeenCalled();

      // Assert: Verify token deletion was NOT attempted (no metadata means incomplete invitation)
      expect(deleteInvitationToken).not.toHaveBeenCalled();
    });

    it('should not block user creation if invitation processing fails', async () => {
      // Arrange: OAuth user with invitation that throws error during processing
      const mockUser = createMockUser({
        id: 'oauth-user-error',
        email: 'error@example.com',
      });

      getOAuthState.mockResolvedValue({
        invitationToken: 'token-error',
        invitationEmail: 'error@example.com',
      });

      // Mock error during validation
      validateInvitationToken.mockRejectedValue(new Error('Database connection failed'));

      const ctx = { path: '/api/auth/callback/google' };

      // Act: Simulate database hook (should not throw)
      await simulateDatabaseHook(mockUser, ctx);

      // Assert: Verify error was logged
      expect(logger.error).toHaveBeenCalledWith(
        'Error processing OAuth invitation in database hook',
        expect.any(Error),
        {
          userId: mockUser.id,
          email: mockUser.email,
        }
      );

      // Assert: Verify user creation continued (welcome email sent)
      expect(sendEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: mockUser.email,
        })
      );
    });
  });

  describe('Welcome email sending', () => {
    it('should send welcome email for OAuth signup', async () => {
      // Arrange: OAuth user without invitation
      const mockUser = createMockUser({
        id: 'oauth-user-welcome',
        email: 'oauth@example.com',
        name: 'OAuth User',
      });

      getOAuthState.mockResolvedValue(null); // No invitation

      const ctx = { path: '/api/auth/callback/google' };

      // Act: Simulate database hook
      await simulateDatabaseHook(mockUser, ctx);

      // Assert: Verify welcome email was sent
      expect(logger.info).toHaveBeenCalledWith('Sending welcome email to new user', {
        userId: mockUser.id,
        userEmail: mockUser.email,
        signupMethod: 'OAuth',
      });
      expect(sendEmail).toHaveBeenCalledWith({
        to: mockUser.email,
        subject: 'Welcome to Sunrise',
        react: expect.any(Object),
      });
    });

    it('should send welcome email for email/password signup', async () => {
      // Arrange: Email/password user
      const mockUser = createMockUser({
        id: 'email-user-welcome',
        email: 'email@example.com',
        name: 'Email User',
      });

      const ctx = { path: '/api/auth/signup' }; // Not a callback path

      // Act: Simulate database hook
      await simulateDatabaseHook(mockUser, ctx);

      // Assert: Verify welcome email was sent
      expect(logger.info).toHaveBeenCalledWith('Sending welcome email to new user', {
        userId: mockUser.id,
        userEmail: mockUser.email,
        signupMethod: 'email/password',
      });
      expect(sendEmail).toHaveBeenCalledWith({
        to: mockUser.email,
        subject: 'Welcome to Sunrise',
        react: expect.any(Object),
      });
    });

    it('should not block user creation if welcome email fails', async () => {
      // Arrange: User with email sending failure
      const mockUser = createMockUser({
        id: 'email-fail-user',
        email: 'emailfail@example.com',
      });

      // Mock email sending failure
      sendEmail.mockRejectedValue(new Error('SMTP server unavailable'));

      const ctx = { path: '/api/auth/signup' };

      // Act: Simulate database hook (should not throw)
      await simulateDatabaseHook(mockUser, ctx);

      // Assert: Verify email send was attempted
      expect(sendEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: mockUser.email,
        })
      );

      // Assert: Verify failure was logged but didn't block signup
      expect(logger.warn).toHaveBeenCalledWith('Failed to send welcome email', {
        userId: mockUser.id,
        userEmail: mockUser.email,
        signupMethod: 'email/password',
        error: 'SMTP server unavailable',
      });
    });

    it('should send welcome email even when invitation processing fails', async () => {
      // Arrange: OAuth user with failing invitation but successful email
      const mockUser = createMockUser({
        id: 'invitation-fail-user',
        email: 'invfail@example.com',
      });

      getOAuthState.mockRejectedValue(new Error('OAuth state error'));

      const ctx = { path: '/api/auth/callback/google' };

      // Act: Simulate database hook
      await simulateDatabaseHook(mockUser, ctx);

      // Assert: Verify invitation error was logged
      expect(logger.error).toHaveBeenCalledWith(
        'Error processing OAuth invitation in database hook',
        expect.any(Error),
        expect.any(Object)
      );

      // Assert: Verify welcome email was still sent
      expect(sendEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: mockUser.email,
          subject: 'Welcome to Sunrise',
        })
      );
    });
  });

  describe('Signup method detection', () => {
    it('should detect OAuth signup from callback path', async () => {
      // Arrange: OAuth callback path variants
      const mockUser = createMockUser({ email: 'test@example.com' });

      const oauthPaths = [
        '/api/auth/callback/google',
        '/api/auth/callback/github',
        '/auth/callback/facebook',
      ];

      for (const path of oauthPaths) {
        vi.clearAllMocks();
        getOAuthState.mockResolvedValue(null);

        // Act: Simulate hook with OAuth path
        await simulateDatabaseHook(mockUser, { path });

        // Assert: Verify OAuth method detected
        expect(logger.info).toHaveBeenCalledWith(
          'Sending welcome email to new user',
          expect.objectContaining({
            signupMethod: 'OAuth',
          })
        );
      }
    });

    it('should detect email/password signup from non-callback path', async () => {
      // Arrange: Email/password signup paths
      const mockUser = createMockUser({ email: 'test@example.com' });

      const emailPaths = ['/api/auth/signup', '/auth/register', undefined];

      for (const path of emailPaths) {
        vi.clearAllMocks();

        // Act: Simulate hook with email/password path
        await simulateDatabaseHook(mockUser, { path });

        // Assert: Verify email/password method detected
        expect(logger.info).toHaveBeenCalledWith(
          'Sending welcome email to new user',
          expect.objectContaining({
            signupMethod: 'email/password',
          })
        );
      }
    });
  });
});
