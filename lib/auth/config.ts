import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { getOAuthState, APIError } from 'better-auth/api';
import { prisma } from '@/lib/db/client';
import { env } from '@/lib/env';
import { sendEmail } from '@/lib/email/send';
import { validateEmailConfig } from '@/lib/email/client';
import VerifyEmailEmail from '@/emails/verify-email';
import ResetPasswordEmail from '@/emails/reset-password';
import WelcomeEmail from '@/emails/welcome';
import { logger } from '@/lib/logging';
import {
  validateInvitationToken,
  deleteInvitationToken,
  getValidInvitation,
} from '@/lib/utils/invitation-token';
import { DEFAULT_USER_PREFERENCES } from '@/types';

/**
 * Better Auth Configuration
 *
 * Provides authentication using email/password and social providers (Google).
 * Uses Prisma ORM for unified database management.
 *
 * Environment Variables Required:
 * - BETTER_AUTH_SECRET: Secret key for JWT signing (min 32 characters)
 * - BETTER_AUTH_URL: Base URL of the application
 * - DATABASE_URL: PostgreSQL connection string (used by Prisma)
 * - GOOGLE_CLIENT_ID: Google OAuth client ID (optional)
 * - GOOGLE_CLIENT_SECRET: Google OAuth client secret (optional)
 *
 * Features:
 * - Email/password authentication
 * - Social OAuth (Google)
 * - Email verification
 * - Password reset
 * - Invitation acceptance via OAuth (custom hook)
 *
 * @see .context/environment/reference.md for complete environment variable reference
 */
export const auth = betterAuth({
  database: prismaAdapter(prisma, {
    provider: 'postgresql',
  }),

  // Base URL for the application
  baseURL: env.BETTER_AUTH_URL,

  // Secret for JWT signing
  secret: env.BETTER_AUTH_SECRET,

  // Enable email and password authentication
  emailAndPassword: {
    enabled: true,
    // Email verification: enabled by default in production, disabled in development
    // Override with REQUIRE_EMAIL_VERIFICATION environment variable
    // Note: Verification email sending is configured in emailVerification block below
    requireEmailVerification: env.REQUIRE_EMAIL_VERIFICATION ?? env.NODE_ENV === 'production',
    sendResetPassword: async ({
      user,
      url,
    }: {
      user: { id: string; email: string; name: string | null };
      url: string;
      token: string;
    }) => {
      // Check if user has a password account (not OAuth-only)
      const passwordAccount = await prisma.account.findFirst({
        where: {
          userId: user.id,
          password: { not: null },
        },
      });

      // If user only has OAuth accounts (no password), don't send reset email
      // This is a security best practice - don't reveal user's auth method
      if (!passwordAccount) {
        logger.info('Password reset requested for OAuth-only user', {
          userId: user.id,
          email: user.email,
        });
        return; // Silently succeed - frontend shows generic success message
      }

      // User has password account - send reset email
      await sendEmail({
        to: user.email,
        subject: 'Reset your password',
        react: ResetPasswordEmail({
          userName: user.name || 'User',
          resetUrl: url,
          expiresAt: new Date(Date.now() + 1 * 60 * 60 * 1000), // 1 hour
        }),
      });
    },
  },

  // Email verification configuration
  emailVerification: {
    // Trigger verification email on signup when required
    sendOnSignUp: env.REQUIRE_EMAIL_VERIFICATION ?? env.NODE_ENV === 'production',

    // Automatically sign in user after successful email verification
    autoSignInAfterVerification: true,

    // Token expiration time in seconds (24 hours to match email messaging)
    expiresIn: 86400, // 24 hours

    // Send verification email callback (better-auth calls this)
    sendVerificationEmail: async ({
      user,
      url,
    }: {
      user: { id: string; email: string; name: string | null };
      url: string;
      token: string;
    }) => {
      // Check if this is an invitation acceptance - if so, skip verification email
      // The invitation acceptance flow marks email as verified immediately
      const invitation = await getValidInvitation(user.email);

      if (invitation) {
        logger.info('Skipping verification email for invitation acceptance', {
          userId: user.id,
          email: user.email,
        });
        return; // Don't send verification email for invitation acceptance
      }

      // Replace the default callbackURL (/) with our verification callback page
      // This page handles both success (redirect to dashboard) and error states (show resend option)
      const verificationUrl = url.replace(
        'callbackURL=%2F',
        'callbackURL=%2Fverify-email%2Fcallback'
      );

      await sendEmail({
        to: user.email,
        subject: 'Verify your email address',
        react: VerifyEmailEmail({
          userName: user.name || 'User',
          verificationUrl,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours
        }),
      });
    },

    // Callback after successful email verification
    afterEmailVerification: async (user: { id: string; email: string; name: string | null }) => {
      logger.info('Email verification completed', {
        userId: user.id,
        email: user.email,
      });

      // Send welcome email AFTER verification completes
      await sendEmail({
        to: user.email,
        subject: 'Welcome to Sunrise',
        react: WelcomeEmail({
          userName: user.name || 'User',
          userEmail: user.email,
        }),
      }).catch((error) => {
        logger.warn('Failed to send welcome email after verification', {
          userId: user.id,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    },
  },

  // Social authentication providers
  socialProviders: {
    google: {
      clientId: env.GOOGLE_CLIENT_ID || '',
      clientSecret: env.GOOGLE_CLIENT_SECRET || '',
      enabled: !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
    },
  },

  // Session configuration
  session: {
    expiresIn: 60 * 60 * 24 * 30, // 30 days in seconds
    updateAge: 60 * 60 * 24, // Update session every 24 hours
    cookieCache: {
      enabled: true,
      maxAge: 60 * 5, // 5 minutes
    },
  },

  // User model customization
  user: {
    additionalFields: {
      role: {
        type: 'string',
        defaultValue: 'USER',
        required: false,
      },
    },
  },

  // Advanced database configuration
  advanced: {
    database: {
      /**
       * Delegate ID generation to Prisma's @default(cuid())
       *
       * By default, better-auth generates its own IDs. Returning `false` here
       * tells better-auth to let Prisma handle ID generation using the schema's
       * @default(cuid()) specification. This ensures all users get consistent
       * CUID-format IDs (25 characters starting with 'c') regardless of how
       * they're created (UI, API, OAuth, or seed script).
       */
      generateId: () => false,
    },
  },

  // Database hooks for lifecycle events
  databaseHooks: {
    user: {
      create: {
        /**
         * Validate OAuth invitation email match BEFORE user creation
         *
         * For OAuth invitation flow, the user's OAuth email MUST match the
         * invitation email. This prevents users from accepting an invitation
         * sent to one email address using a different OAuth account.
         *
         * Security: If invitation data is present but emails don't match,
         * user creation is rejected with a clear error message.
         */
        before: async (user, ctx) => {
          const isOAuthSignup = ctx?.path?.includes('/callback/') ?? false;

          if (isOAuthSignup) {
            try {
              const oauthState = await getOAuthState();
              const invitationEmail =
                oauthState && typeof oauthState === 'object'
                  ? (oauthState.invitationEmail as string | undefined)
                  : null;

              // If invitation data is present, email MUST match
              if (invitationEmail && user.email !== invitationEmail) {
                logger.warn('OAuth invitation email mismatch - rejecting signup', {
                  invitationEmail,
                  oauthEmail: user.email,
                });

                throw new APIError('BAD_REQUEST', {
                  message: `This invitation was sent to ${invitationEmail}. Please use an account with that email address, or set a password instead.`,
                });
              }
            } catch (error) {
              // Re-throw APIError (our validation error)
              if (error instanceof APIError) {
                throw error;
              }
              // Log but don't block for other errors (e.g., getOAuthState fails)
              logger.error('Error checking OAuth invitation in before hook', error);
            }
          }

          return { data: user };
        },

        /**
         * Handle OAuth invitation acceptance and send welcome email
         *
         * Triggered after a new user is created via:
         * - Email/password signup (email + password)
         * - OAuth/social login (Google, etc.) - ONLY for NEW users, not existing logins
         *
         * The hook fires whenever a user record is inserted into the database,
         * regardless of authentication method. For OAuth, it only triggers on
         * first signup, not on subsequent logins by existing users.
         *
         * For OAuth invitation flow:
         * 1. Check if OAuth state contains invitation data (invitationToken, invitationEmail)
         * 2. Validate invitation token and email match
         * 3. Get invitation metadata (name, role, invitedBy, invitedAt)
         * 4. Apply role from invitation to the newly created user
         * 5. Delete invitation token (single-use)
         * 6. Send welcome email (email already verified by OAuth provider)
         *
         * For normal signup:
         * - Send welcome email (non-blocking)
         * - Email/password users also receive verification email if enabled
         *
         * Error handling: Non-blocking - logs failures but doesn't prevent signup.
         */
        after: async (user, ctx) => {
          // Detect signup method for logging purposes
          const isOAuthSignup = ctx?.path?.includes('/callback/') ?? false;
          const signupMethod = isOAuthSignup ? 'OAuth' : 'email/password';

          // Set default preferences for all new users
          try {
            await prisma.user.update({
              where: { id: user.id },
              data: { preferences: DEFAULT_USER_PREFERENCES as object },
            });
            logger.info('Default preferences set for new user', {
              userId: user.id,
              signupMethod,
            });
          } catch (prefsError) {
            // Log but don't fail user creation
            logger.error('Failed to set default preferences', prefsError, {
              userId: user.id,
            });
          }

          // Check if this is an invitation acceptance (for password flow)
          let isPasswordInvitation = false;

          try {
            // Handle OAuth invitation flow
            if (isOAuthSignup) {
              // Get OAuth state (contains additionalData from client)
              const oauthState = await getOAuthState();

              // Check if invitation data is present in OAuth state additionalData
              const invitationToken =
                oauthState && typeof oauthState === 'object'
                  ? (oauthState.invitationToken as string | undefined)
                  : null;
              const invitationEmail =
                oauthState && typeof oauthState === 'object'
                  ? (oauthState.invitationEmail as string | undefined)
                  : null;

              if (invitationToken && invitationEmail && user.email === invitationEmail) {
                logger.info('Processing OAuth invitation', {
                  userId: user.id,
                  email: user.email,
                });

                // Validate invitation token
                const isValidToken = await validateInvitationToken(
                  invitationEmail,
                  invitationToken
                );

                if (isValidToken) {
                  // Get invitation metadata FIRST (before deletion)
                  const invitation = await getValidInvitation(invitationEmail);

                  // Apply role if non-default and metadata exists
                  if (invitation?.metadata) {
                    const { metadata } = invitation;

                    if (metadata.role && metadata.role !== 'USER') {
                      await prisma.user.update({
                        where: { id: user.id },
                        data: { role: metadata.role },
                      });

                      logger.info('Applied invitation role to OAuth user', {
                        userId: user.id,
                        role: metadata.role,
                      });
                    }
                  }

                  // Delete invitation token LAST (after using metadata)
                  // Single-use token - must be deleted regardless of role application
                  try {
                    await deleteInvitationToken(invitationEmail);
                    logger.info('OAuth invitation token deleted successfully', {
                      userId: user.id,
                      email: invitationEmail,
                    });
                  } catch (deleteError) {
                    // Log deletion failure explicitly but don't fail user creation
                    logger.error('Failed to delete OAuth invitation token', deleteError, {
                      userId: user.id,
                      email: invitationEmail,
                    });
                  }

                  logger.info('OAuth invitation accepted successfully', {
                    userId: user.id,
                    email: user.email,
                  });
                }
              }
            } else {
              // Check for password invitation acceptance (non-expired invitation)
              const invitation = await getValidInvitation(user.email);

              if (invitation) {
                isPasswordInvitation = true;
                logger.info('Detected password invitation acceptance', {
                  userId: user.id,
                  email: user.email,
                });
              }
            }
          } catch (error) {
            // Log but don't fail user creation
            logger.error('Error processing invitation in database hook', error, {
              userId: user.id,
              email: user.email,
            });
          }

          // Determine if welcome email should be sent immediately
          const requiresVerification =
            env.REQUIRE_EMAIL_VERIFICATION ?? env.NODE_ENV === 'production';

          // Send welcome email if:
          // 1. OAuth signup (email auto-verified by provider), OR
          // 2. Email/password signup with verification DISABLED, OR
          // 3. Password invitation acceptance (email will be verified by accept-invite route)
          // Note: Normal email/password with verification ENABLED will receive welcome email
          // after verification completes (via emailVerification.afterEmailVerification)
          const shouldSendWelcomeNow =
            isOAuthSignup || !requiresVerification || isPasswordInvitation;

          if (shouldSendWelcomeNow) {
            logger.info('Sending welcome email to new user', {
              userId: user.id,
              userEmail: user.email,
              signupMethod,
              isInvitation: isPasswordInvitation,
            });

            await sendEmail({
              to: user.email,
              subject: 'Welcome to Sunrise',
              react: WelcomeEmail({
                userName: user.name || 'User',
                userEmail: user.email,
              }),
            }).catch((error) => {
              logger.warn('Failed to send welcome email', {
                userId: user.id,
                userEmail: user.email,
                signupMethod,
                error: error instanceof Error ? error.message : String(error),
              });
            });
          } else {
            logger.info('Skipping welcome email (will send after email verification)', {
              userId: user.id,
              userEmail: user.email,
              signupMethod,
            });
          }
        },
      },
    },
  },
});

// Validate email configuration at startup
validateEmailConfig();

// Export the auth handler type for use in API routes
export type Auth = typeof auth;
