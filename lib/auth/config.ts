import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { getOAuthState } from 'better-auth/api';
import { prisma } from '@/lib/db/client';
import { env } from '@/lib/env';
import { sendEmail } from '@/lib/email/send';
import VerifyEmailEmail from '@/emails/verify-email';
import ResetPasswordEmail from '@/emails/reset-password';
import WelcomeEmail from '@/emails/welcome';
import { logger } from '@/lib/logging';
import { validateInvitationToken, deleteInvitationToken } from '@/lib/utils/invitation-token';

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
    requireEmailVerification: env.REQUIRE_EMAIL_VERIFICATION ?? env.NODE_ENV === 'production',
    sendVerificationEmail: async ({
      user,
      verificationLink,
    }: {
      user: { id: string; email: string; name: string | null };
      verificationLink: string;
    }) => {
      await sendEmail({
        to: user.email,
        subject: 'Verify your email address',
        react: VerifyEmailEmail({
          userName: user.name || 'User',
          verificationUrl: verificationLink,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours
        }),
      });
    },
    sendResetPasswordEmail: async ({
      user,
      resetLink,
    }: {
      user: { id: string; email: string; name: string | null };
      resetLink: string;
    }) => {
      await sendEmail({
        to: user.email,
        subject: 'Reset your password',
        react: ResetPasswordEmail({
          userName: user.name || 'User',
          resetUrl: resetLink,
          expiresAt: new Date(Date.now() + 1 * 60 * 60 * 1000), // 1 hour
        }),
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

          try {
            // Handle OAuth invitation flow
            if (isOAuthSignup) {
              const oauthState = await getOAuthState();

              // Check if invitation data is present in OAuth state
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
                  // Get invitation metadata
                  const invitation = await prisma.verification.findFirst({
                    where: { identifier: `invitation:${invitationEmail}` },
                  });

                  if (invitation?.metadata) {
                    const metadata = invitation.metadata as {
                      name: string;
                      role: string;
                      invitedBy: string;
                      invitedAt: string;
                    };

                    // Apply role if non-default
                    if (metadata.role && metadata.role !== 'USER') {
                      // Return modified user data to set role
                      await prisma.user.update({
                        where: { id: user.id },
                        data: { role: metadata.role },
                      });

                      logger.info('Applied invitation role to OAuth user', {
                        userId: user.id,
                        role: metadata.role,
                      });
                    }

                    // Delete invitation token (single-use)
                    await deleteInvitationToken(invitationEmail);

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
            logger.error('Error processing OAuth invitation in database hook', error, {
              userId: user.id,
              email: user.email,
            });
          }

          // Send welcome email for all new users (OAuth and email/password)
          logger.info('Sending welcome email to new user', {
            userId: user.id,
            userEmail: user.email,
            signupMethod,
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
        },
      },
    },
  },
});

// Export the auth handler type for use in API routes
export type Auth = typeof auth;
