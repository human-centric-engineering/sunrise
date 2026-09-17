import { z } from 'zod';
import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { getOAuthState, APIError, createAuthMiddleware } from 'better-auth/api';
import { prisma } from '@/lib/db/client';
import { BRAND } from '@/lib/brand';
import { SYSTEM_USER_EMAIL, AUTH_BOOTSTRAP_ID } from '@/lib/auth/constants';
import { humanWhere } from '@/lib/auth/account';
import { env } from '@/lib/env';
import { sendEmail } from '@/lib/email/send';
import { validateEmailConfig } from '@/lib/email/client';
import { resolveEmailTemplate } from '@/lib/email/registry';
import { logger } from '@/lib/logging';
import { dispatchUserCreated } from '@/lib/auth/user-created-hooks';
import {
  activeOrgForSession,
  ensureMembership,
  initialMembershipFor,
  membershipForNewUser,
  type AcceptedInvitation,
} from '@/lib/tenancy/membership';
import { getPendingSignup, setPendingSignup } from '@/lib/auth/pending-signup';
import {
  validateInvitationToken,
  deleteInvitationToken,
  getValidInvitation,
} from '@/lib/utils/invitation-token';
import { DEFAULT_USER_PREFERENCES } from '@/lib/validations/user';
import {
  isInviteOnly,
  isInvitedSignup,
  invitedSignupInvitation,
  isFirstHumanBootstrap,
} from '@/lib/auth/signup-mode';
import { parseEmailChangeToken, getVerificationTokenFromRequest } from '@/lib/auth/change-email';
import { revokeUserSessions, findMostRecentSessionToken } from '@/lib/auth/sessions';
import { isPlatformAdmin, PLATFORM_ADMIN_ROLE, DEFAULT_USER_ROLE } from '@/lib/auth/roles';

/**
 * How long an email-verification token (signup, or either leg of an email
 * change) is valid. Drives `emailVerification.expiresIn` below AND the
 * "expires at" copy in the verification/approval emails — one constant so the
 * two can't drift into telling the user a different expiry than better-auth
 * actually enforces.
 */
const EMAIL_VERIFICATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Zod schema for OAuth invitation state passed via `additionalData`.
 * Validates that `invitationEmail` and `invitationToken` are strings when present.
 */
const oauthInvitationStateSchema = z
  .object({
    invitationEmail: z.string().optional(),
    invitationToken: z.string().optional(),
  })
  .passthrough();

/**
 * User shape passed to `databaseHooks.user.create.{before,after}` by better-auth.
 * Matches better-auth's inferred type (including the `role` additionalField).
 */
export type UserCreateData = {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  email: string;
  emailVerified: boolean;
  name: string;
  image?: string | null;
  /**
   * The `role` additionalField. Declared explicitly because the index
   * signature below types it `unknown`, which let `user.role === 'ADMIN'`
   * compile while comparing an untyped value — the docblock above already
   * claimed the field was part of this shape.
   */
  role?: string | null;
} & Record<string, unknown>;

/**
 * Context passed to database hooks. `null` when better-auth invokes the hook
 * outside a request context; optional `path` identifies OAuth callbacks.
 */
export type DatabaseHookContext = { path?: string } | null;

/**
 * Session shape passed to `databaseHooks.session.create.before` by better-auth
 * — the row it is about to insert, additional fields included.
 */
export type SessionCreateData = {
  id?: string;
  userId: string;
  token: string;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
  ipAddress?: string | null;
  userAgent?: string | null;
  activeOrgId?: string | null;
} & Record<string, unknown>;

/**
 * Record the membership this signup will write, so the session hook (which
 * may run first — see `lib/auth/pending-signup.ts`) and the after hook agree
 * on it. `user` is the row as it will be created, `invitation` what admitted
 * it. Non-blocking: a failure here is logged and the after hook falls back to
 * the install-org default, which is the pre-§106-t-670 behaviour.
 */
async function recordPendingMembership(
  user: UserCreateData,
  invitation: AcceptedInvitation | null
): Promise<void> {
  try {
    const membership = await membershipForNewUser(user, invitation);
    await setPendingSignup({ membership });
  } catch (error) {
    logger.error('Failed to decide the org membership for a new user', error, {
      email: user.email,
      invitedOrgId: invitation?.orgId ?? null,
    });
  }
}

/**
 * Validate OAuth invitation email match BEFORE user creation.
 *
 * For OAuth invitation flow, the user's OAuth email MUST match the invitation
 * email. This prevents users from accepting an invitation sent to one email
 * address using a different OAuth account.
 *
 * Security: If invitation data is present but emails don't match, user creation
 * is rejected with a clear error message.
 *
 * Exported so unit tests can call the real implementation directly.
 */
export async function userCreateBeforeHook(
  user: UserCreateData,
  ctx: DatabaseHookContext
): Promise<{ data: UserCreateData }> {
  // Reserve the system service-account email — it must only ever be created by
  // the seed (as a SERVICE principal), never via public signup.
  if (user.email === SYSTEM_USER_EMAIL) {
    throw new APIError('BAD_REQUEST', {
      message: 'This email address is reserved.',
    });
  }

  const isOAuthSignup = ctx?.path?.includes('/callback/') ?? false;

  // Set when a valid invitation token authorises this OAuth signup; read by the
  // invite_only gate below.
  let oauthInvitationAccepted = false;

  if (isOAuthSignup) {
    try {
      const oauthState = await getOAuthState();
      const parsed = oauthInvitationStateSchema.safeParse(oauthState);
      const invitationEmail = parsed.success ? parsed.data.invitationEmail : null;
      const invitationToken = parsed.success ? (parsed.data.invitationToken ?? null) : null;

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

      // Apply role BEFORE user is created so the session gets the correct role immediately.
      // If we applied it in the after hook (via prisma.user.update), the session would
      // already be cached with role="USER" and the user would need to re-login.
      if (invitationToken && invitationEmail && user.email === invitationEmail) {
        const isValidToken = await validateInvitationToken(invitationEmail, invitationToken);

        if (isValidToken) {
          // Record the authorisation itself, not just its side effects. A valid
          // token with no parseable invitation record falls through to the
          // bootstrap below, and the invite_only gate must still treat that
          // account as invited.
          oauthInvitationAccepted = true;

          const invitation = await getValidInvitation(invitationEmail);

          // Delete token NOW to prevent race: token must be consumed before user
          // creation, so a concurrent OAuth signup cannot reuse the same single-use token.
          await deleteInvitationToken(invitationEmail);
          logger.info('OAuth invitation token consumed', { email: invitationEmail });

          // When a valid invitation record exists, honour its explicit role
          // (defaulting to USER) and return immediately. This is an invited
          // account, so it must NOT fall through to the first-admin bootstrap
          // below — otherwise a USER invitation that happened to be the first
          // signup would be silently promoted to ADMIN, overriding the inviter's
          // intent. (No record → fall through, so the bootstrap can still apply.)
          if (invitation) {
            const invitedRole = invitation.metadata?.role ?? DEFAULT_USER_ROLE;
            logger.info('Applying invitation role to OAuth user before creation', {
              email: user.email,
              role: invitedRole,
            });

            // The row this hook consumed is the only copy of the org the
            // invitation named; hand it to the hooks that follow now.
            const invited = { ...user, role: invitedRole };
            await recordPendingMembership(invited, invitation.metadata);
            return { data: invited };
          }
        }
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

  // invite_only gate — the backstop for every account-creation path.
  //
  // `signupModeBeforeHook` closes `/sign-up/email`, but it cannot see the others:
  // a Google signup arrives here via `/callback/:id`, and better-auth also
  // creates accounts from `POST /sign-in/social` with an `idToken` (a distinct
  // endpoint path, so a `/callback/` test misses it). Plugins a fork enables
  // later — magic-link, email-OTP, passkey — would each add another.
  //
  // So this is deliberately **default-deny and path-independent**: every user
  // insert funnels through this hook, and under invite_only anything that is
  // not explicitly authorised is refused. Enumerating endpoint paths is what
  // let `/sign-in/social` through, and the next one would slip past the same
  // way — silently, which is the exact failure invite_only exists to prevent.
  //
  // The two authorised paths:
  // - `isInvitedSignup()` — accept-invite, already holding a validated token.
  // - `oauthInvitationAccepted` — an OAuth signup that presented a valid token.
  //
  // Only NEW account creation is refused. This hook does not run when an
  // existing user signs in, so established accounts are unaffected.
  if (isInviteOnly() && !isInvitedSignup() && !oauthInvitationAccepted) {
    if (await isFirstHumanBootstrap()) {
      logger.info('invite_only: admitting first-human signup on an empty database', {
        email: user.email,
      });
    } else {
      logger.warn('invite_only: refusing un-invited signup', {
        email: user.email,
        path: ctx?.path,
      });

      throw new APIError('FORBIDDEN', {
        message: 'Sign-up is by invitation only.',
      });
    }
  }

  // First-human-is-admin bootstrap.
  //
  // On a fresh database the first real person to sign up — by email/password OR
  // OAuth — is promoted to ADMIN. This gives self-hosters a working admin
  // bootstrap with zero default credentials (the Ghost/GitLab/Sentry pattern).
  //
  // Fires at most ONCE per instance: gated on the absence of the `AuthBootstrap`
  // singleton, which is written the first time an admin exists. Without that
  // marker, a pure "0 humans → admin" check would re-open after every human is
  // deleted, letting the next signup silently become admin (issue #278).
  //
  // Only real human users are counted (`humanWhere`) — the seeded SERVICE
  // config-owner is excluded (it has role ADMIN but cannot log in and is created
  // via a direct upsert, so this hook never fires for it).
  //
  // Fail-open: any error here (e.g. the auth_bootstrap table not yet migrated,
  // or a transient DB fault) must NEVER block signup — we log and fall through
  // to the default role. The bootstrap is a convenience, not a gate.
  //
  // Concurrency: two simultaneous first-signups could both read a count of 0
  // before the marker is written and both be promoted. This window only exists
  // on a brand-new, operator-controlled database and is benign.
  try {
    const alreadyBootstrapped = await prisma.authBootstrap.findUnique({
      where: { id: AUTH_BOOTSTRAP_ID },
      select: { id: true },
    });

    if (!alreadyBootstrapped) {
      const existingHumanCount = await prisma.user.count({ where: humanWhere });

      if (existingHumanCount === 0) {
        // First real human → promote. The marker is written by the after hook
        // once the user row exists (avoids marking a signup that then fails to
        // insert).
        logger.info('First user on a fresh database — assigning ADMIN role', {
          email: user.email,
        });
        const promoted = { ...user, role: PLATFORM_ADMIN_ROLE };
        await recordPendingMembership(promoted, null);
        return { data: promoted };
      }

      // Humans already exist but the marker is missing — an upgraded database,
      // or a prior after-hook marker write that failed. Backfill the marker so
      // the bootstrap can never re-open, and do NOT promote (an operator already
      // exists). Self-heals the marker on the next signup.
      await prisma.authBootstrap.upsert({
        where: { id: AUTH_BOOTSTRAP_ID },
        update: {},
        create: { id: AUTH_BOOTSTRAP_ID },
      });
    }
  } catch (bootstrapError) {
    // Never block signup on the bootstrap check.
    logger.error('First-admin bootstrap check failed; proceeding as USER', bootstrapError, {
      email: user.email,
    });
  }

  // Every other path lands here: a public signup (no invitation), or the
  // password accept-invite route, whose invitation arrives through
  // `runInvitedSignup`. That route applies the invitation's platform role to
  // the row only after `signUpEmail` returns, which is why the membership is
  // decided from the invitation rather than from `user.role` here.
  await recordPendingMembership(user, invitedSignupInvitation());
  return { data: user };
}

/**
 * Handle OAuth invitation acceptance, set default preferences, and send welcome email.
 *
 * Triggered after a new user is created via:
 * - Email/password signup (email + password)
 * - OAuth/social login (Google, etc.) - ONLY for NEW users, not existing logins
 *
 * The hook fires whenever a user record is inserted into the database, regardless
 * of authentication method. For OAuth, it only triggers on first signup, not on
 * subsequent logins by existing users.
 *
 * Welcome-email logic:
 * - OAuth signup (email auto-verified) → send welcome now
 * - Email/password with verification DISABLED → send welcome now
 * - Password invitation acceptance → send welcome now (email verified by accept-invite route)
 * - Email/password with verification ENABLED → skip now; welcome sent after verification
 *
 * Role assignment for OAuth invitation happens in the BEFORE hook so the user
 * is created with the correct role — the session is cached immediately without
 * requiring a logout/login cycle.
 *
 * Error handling: Non-blocking. Preferences-update and welcome-email failures
 * are logged but do not prevent signup.
 *
 * Exported so unit tests can call the real implementation directly.
 */
export async function userCreateAfterHook(
  user: UserCreateData,
  ctx: DatabaseHookContext
): Promise<void> {
  // Detect signup method for logging purposes
  const isOAuthSignup = ctx?.path?.includes('/callback/') ?? false;
  const signupMethod = isOAuthSignup ? 'OAuth' : 'email/password';

  // Every user belongs to an org (tenancy design, principle 1). First, and
  // non-blocking like everything else here — deliberately. better-auth queues
  // `create.after` hooks and runs them only after the sign-up's transaction
  // has resolved (`@better-auth/core` `runWithTransaction`), so by the time
  // this runs the user, the credential/OAuth account and — for email sign-up
  // — the session are all committed. A throw here would therefore not
  // protect anything: it would turn a fully usable signup into a 500 the
  // person cannot act on (retrying says the address is taken), and the user
  // would still be memberless. So a failure is logged at `error` — the
  // operator's signal — and the signup completes. The invariant is restored
  // on the session path: `sessionCreateBeforeHook` below writes the
  // install-org default for a user with no membership, and at `single` the
  // guard resolves a null membership to the install org (t-671); at `multi`
  // the guard refuses until a membership exists.
  //
  // WHICH membership was decided by the before hook (`recordPendingMembership`)
  // — it is the one place that knows the role and the org an invitation
  // grants for both the OAuth and the password path — and carried here on the
  // request state. The fallback is the install-org rule on the row as created,
  // which is what every path wrote before invitations could name an org.
  //
  // Inline rather than a `registerUserCreatedHook` contributor: that registry
  // is the fork's seam and runs last; this is a core invariant that goes first.
  try {
    const pending = await getPendingSignup();
    await ensureMembership(user.id, pending?.membership ?? initialMembershipFor(user));
  } catch (membershipError) {
    logger.error('Failed to create org membership for new user', membershipError, {
      userId: user.id,
      signupMethod,
    });
  }

  // Record that the first-user-is-admin bootstrap has completed, the first time
  // a real (non-system) admin exists. Once this singleton row is written, the
  // before hook never auto-promotes again — even if every human is later
  // deleted and the live user count returns to zero (see issue #278). Covers
  // both bootstrap-promoted and invitation-created admins; idempotent upsert.
  // Non-blocking, like the rest of this hook.
  if (isPlatformAdmin(user) && user.accountType !== 'SERVICE') {
    try {
      await prisma.authBootstrap.upsert({
        where: { id: AUTH_BOOTSTRAP_ID },
        update: {},
        create: { id: AUTH_BOOTSTRAP_ID },
      });
    } catch (bootstrapError) {
      // Non-blocking: the before hook self-heals a missed marker on the next
      // signup (it backfills when humans exist but no marker is present).
      logger.error('Failed to record auth bootstrap completion', bootstrapError, {
        userId: user.id,
      });
    }
  }

  // Set default preferences for all new users
  try {
    await prisma.user.update({
      where: { id: user.id },
      data: { preferences: DEFAULT_USER_PREFERENCES },
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
    if (!isOAuthSignup) {
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
  const requiresVerification = env.REQUIRE_EMAIL_VERIFICATION ?? env.NODE_ENV === 'production';

  const shouldSendWelcomeNow = isOAuthSignup || !requiresVerification || isPasswordInvitation;

  if (shouldSendWelcomeNow) {
    logger.info('Sending welcome email to new user', {
      userId: user.id,
      userEmail: user.email,
      signupMethod,
      isInvitation: isPasswordInvitation,
    });

    await sendEmail({
      to: user.email,
      subject: `Welcome to ${BRAND.name}`,
      react: resolveEmailTemplate('welcome', {
        userName: user.name || 'User',
        userEmail: user.email,
        baseUrl: env.BETTER_AUTH_URL,
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

  // Fork-owned seam (#464). Dispatched last, so an app hook sees the account in
  // its fully initialised state — preferences set, invitation redeemed, welcome
  // email decided. Never throws: `dispatchUserCreated` logs and swallows a
  // failing hook, because the user row already exists by this point and failing
  // here would report a successful signup to the caller as an error.
  await dispatchUserCreated({
    userId: user.id,
    email: user.email,
    name: user.name,
    signupMethod: isOAuthSignup ? 'oauth' : 'email',
    viaInvitation: isPasswordInvitation,
  });
}

/**
 * Send password reset email for users with a password account.
 *
 * OAuth-only users (no password row on `account`) are silently skipped with
 * an info log. The frontend always shows a generic "check your email" message,
 * so the response timing and shape do not reveal whether a user exists or how
 * they authenticate.
 *
 * Exported so unit tests can call the real implementation directly.
 */
export async function sendResetPasswordHook(params: {
  user: { id: string; email: string; name: string | null };
  url: string;
  token: string;
}): Promise<void> {
  const { user, url } = params;

  const passwordAccount = await prisma.account.findFirst({
    where: {
      userId: user.id,
      password: { not: null },
    },
  });

  if (!passwordAccount) {
    logger.info('Password reset requested for OAuth-only user', {
      userId: user.id,
      email: user.email,
    });
    return;
  }

  await sendEmail({
    to: user.email,
    subject: 'Reset your password',
    react: resolveEmailTemplate('resetPassword', {
      userName: user.name || 'User',
      resetUrl: url,
      expiresAt: new Date(Date.now() + 1 * 60 * 60 * 1000),
    }),
  });
}

/**
 * Called after a user verifies their email. Send the welcome email here if
 * it was deferred during signup (see databaseHooks.user.create.after).
 *
 * Exported so unit tests can call the real implementation directly.
 */
export async function afterEmailVerificationHook(
  user: {
    id: string;
    email: string;
    name: string | null;
  },
  request?: Request
): Promise<void> {
  logger.info('Email verification completed', {
    userId: user.id,
    email: user.email,
  });

  // better-auth fires this callback at the end of an email CHANGE too, not just
  // a signup verification, and the `user` it passes is already updated — so
  // nothing in it distinguishes the two. The token on the request does; see
  // lib/auth/change-email.ts.
  const emailChange = await parseEmailChangeToken(getVerificationTokenFromRequest(request));

  if (emailChange) {
    // The address has just changed. Two things follow, neither of which applies
    // to a signup.
    //
    // 1. Revoke other sessions. This is the point the change actually commits,
    //    and the whole reason #489 is a security issue: without this, a session
    //    stolen before the change survives it. Anything holding a cookie from
    //    before this moment loses it.
    //
    //    Best-effort by design. better-auth does NOT wrap this callback in its
    //    error handling (unlike the send-email callbacks), so a throw here
    //    surfaces as a failed verification click *after* the address has already
    //    been written — the user would see an error for a change that did in
    //    fact succeed. Log and continue instead.
    try {
      const current = await auth.api.getSession({ headers: request?.headers ?? new Headers() });
      // If this request carries no visible session, better-auth may have just
      // minted one (the new-address click from a cookie-less browser/device is
      // the ordinary case, not an edge one) — see
      // findMostRecentSessionToken's doc for why the newest row is safe to
      // spare here without weakening the revocation.
      const exceptSessionToken =
        current?.session?.token ?? (await findMostRecentSessionToken(user.id));
      await revokeUserSessions({
        userId: user.id,
        exceptSessionToken,
        reason: 'email_changed',
      });
    } catch (error) {
      logger.error('Failed to revoke sessions after email change', error, {
        userId: user.id,
      });
    }

    // 2. Do not send the welcome email. This is an established user who moved
    //    address, not a new signup; the guard below only asks whether
    //    verification was required at signup, which is true in production and
    //    would therefore greet them all over again.
    logger.info('Skipping welcome email after an email change', {
      userId: user.id,
    });
    return;
  }

  // Only send welcome email here if verification was required at signup.
  // When verification is not required, the welcome email is sent immediately
  // on account creation (databaseHooks.user.create.after). If the user later
  // verifies voluntarily from their profile/settings, we must not send it again.
  const requiresVerification = env.REQUIRE_EMAIL_VERIFICATION ?? env.NODE_ENV === 'production';

  if (!requiresVerification) {
    logger.info('Skipping welcome email after verification (already sent at signup)', {
      userId: user.id,
    });
    return;
  }

  // Send welcome email AFTER verification completes
  await sendEmail({
    to: user.email,
    subject: `Welcome to ${BRAND.name}`,
    react: resolveEmailTemplate('welcome', {
      userName: user.name || 'User',
      userEmail: user.email,
      baseUrl: env.BETTER_AUTH_URL,
    }),
  }).catch((error) => {
    logger.warn('Failed to send welcome email after verification', {
      userId: user.id,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

/**
 * Send verification email to new users (unless they're accepting an invitation).
 *
 * Invitation acceptances skip the verification email because the accept-invite
 * route marks the email as verified immediately. For regular signups, the default
 * callbackURL is rewritten to point at the verification callback page that handles
 * both success and error states.
 *
 * Exported so unit tests can call the real implementation directly.
 */
export async function sendVerificationEmailHook({
  user,
  url,
  token,
}: {
  user: { id: string; email: string; name: string | null };
  url: string;
  token: string;
}): Promise<void> {
  // Is this the new-address leg of an email CHANGE rather than a signup?
  //
  // better-auth drives both through this one callback, and during a change it
  // hands us `user.email` already set to the NEW address — so every check below
  // that assumes "this address is being verified for the first time by its
  // owner-to-be" is reading a different situation than it thinks.
  //
  // Concretely, the invitation skip immediately below would strand the change:
  // an existing user moving to an address that happens to hold a pending
  // invitation would get no verification email, no error, and an account stuck
  // mid-change. The invitation skip exists for signup (where the accept-invite
  // route marks the address verified itself), and a change is not that.
  const emailChange = await parseEmailChangeToken(token);

  if (!emailChange) {
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
  } else {
    logger.info('Sending verification email for an email change', {
      userId: user.id,
    });
  }

  // Replace the default callbackURL (/) with our verification callback page
  // This page handles both success (redirect to dashboard) and error states (show resend option)
  const verificationUrl = url.replace('callbackURL=%2F', 'callbackURL=%2Fverify-email%2Fcallback');

  await sendEmail({
    to: user.email,
    subject: 'Verify your email address',
    react: resolveEmailTemplate('verifyEmail', {
      userName: user.name || 'User',
      verificationUrl,
      expiresAt: new Date(Date.now() + EMAIL_VERIFICATION_TOKEN_TTL_MS),
    }),
  });
}

/**
 * Send the approval request to the address currently on the account when a
 * change to a new one is requested (#489).
 *
 * This is the control that makes a stolen session insufficient for account
 * takeover. Nothing is written to the database when `/change-email` is called —
 * better-auth only mints a token — so whoever holds the session can *ask* for
 * the change, but only someone who can read the original inbox can approve it.
 * Approving then triggers a second, separate verification at the new address.
 *
 * Note the asymmetry better-auth imposes: it only calls this hook when the
 * current address is already verified. An account whose address was never
 * verified has no inbox worth asking, so it goes straight to verifying the new
 * one — no approval gate, by design.
 *
 * Exported so unit tests can call the real implementation directly.
 */
export async function sendChangeEmailConfirmationHook(params: {
  user: { id: string; email: string; name: string | null };
  newEmail: string;
  url: string;
  token: string;
}): Promise<void> {
  const { user, newEmail, url } = params;

  logger.info('Sending email-change approval to the current address', {
    userId: user.id,
  });

  await sendEmail({
    to: user.email, // The CURRENT address — never `newEmail`.
    subject: 'Approve the email change on your account',
    react: resolveEmailTemplate('changeEmailApproval', {
      userName: user.name || 'User',
      currentEmail: user.email,
      newEmail,
      approvalUrl: url,
      expiresAt: new Date(Date.now() + EMAIL_VERIFICATION_TOKEN_TTL_MS),
    }),
  });
}

/**
 * Refuse public email/password signup when `SIGNUP_MODE=invite_only`.
 *
 * Runs as better-auth's `hooks.before`, which sees every endpoint — hence the
 * path check. Gating the route rather than the `/signup` page is the part that
 * matters: `POST /api/auth/sign-up/email` is reachable regardless of what the
 * UI renders, so hiding the page alone leaves the door open.
 *
 * Two exemptions, both narrow:
 * - `isInvitedSignup()` — `accept-invite` creating the invited user. better-auth
 *   routes `auth.api.*` through this same hook, so without the exemption
 *   invite_only would refuse its own invitation flow.
 * - `isFirstHumanBootstrap()` — the first account on an empty database, so a
 *   fresh deployment has an admin who can send invitations.
 *
 * Exported so unit tests can call the real implementation directly.
 */
export async function signupModeBeforeHook(ctx: { path?: string }): Promise<void> {
  if (!isInviteOnly()) return;
  if (ctx.path !== '/sign-up/email') return;
  if (isInvitedSignup()) return;

  if (await isFirstHumanBootstrap()) {
    logger.info('invite_only: admitting first-human signup on an empty database');
    return;
  }

  logger.warn('invite_only: refusing public email/password signup');

  throw new APIError('FORBIDDEN', {
    message: 'Sign-up is by invitation only.',
  });
}

/**
 * Choose the org a new session acts in — `Session.activeOrgId` (§106).
 *
 * Runs for every session better-auth mints: sign-in, OAuth callback, the
 * auto-sign-in after sign-up or email verification, password reset. In order:
 *
 * 1. A signup in flight on this request (`lib/auth/pending-signup.ts`) —
 *    the session is being created inside the sign-up transaction, before the
 *    after hook has written the membership. Start in the org that write is
 *    about to grant, and write nothing here.
 * 2. Otherwise `activeOrgForSession`, over the user's memberships in ACTIVE
 *    orgs (a user whose every org is suspended starts in the most recent of
 *    them and is refused at entry): their only org; else the install org if
 *    they belong to it; else the org they joined most recently; else
 *    — a user with no membership at all — the install-org default is written
 *    right here (the self-heal t-669's review ruled on), and logged at
 *    `error` because it means the signup path failed upstream.
 *
 * Non-blocking, for the same reason the after hook is: a fault reading
 * memberships must not refuse a sign-in. The session is minted with
 * `activeOrgId` null, which the guard resolves to the install org at `single`
 * and refuses at `multi` (t-671) — the same answer a memberless user gets.
 *
 * Exported so unit tests can call the real implementation directly.
 */
export async function sessionCreateBeforeHook(
  session: SessionCreateData,
  _ctx: DatabaseHookContext
): Promise<{ data: { activeOrgId: string | null } }> {
  try {
    const pending = await getPendingSignup();
    if (pending) {
      return { data: { activeOrgId: pending.membership.orgId } };
    }

    const { orgId, healed } = await activeOrgForSession(session.userId);
    if (healed) {
      logger.error('User had no org membership at sign-in; wrote the install-org default', {
        userId: session.userId,
        orgId,
      });
    }
    return { data: { activeOrgId: orgId } };
  } catch (error) {
    logger.error('Failed to choose an active org for a new session', error, {
      userId: session.userId,
    });
    return { data: { activeOrgId: null } };
  }
}

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
    sendResetPassword: sendResetPasswordHook,
  },

  // Email verification configuration
  emailVerification: {
    // Trigger verification email on signup when required
    sendOnSignUp: env.REQUIRE_EMAIL_VERIFICATION ?? env.NODE_ENV === 'production',

    // Automatically sign in user after successful email verification
    autoSignInAfterVerification: true,

    // Token expiration time in seconds, kept equal to EMAIL_VERIFICATION_TOKEN_TTL_MS
    // so the emails' "expires at" copy matches what better-auth actually enforces.
    expiresIn: EMAIL_VERIFICATION_TOKEN_TTL_MS / 1000,

    // Send verification email callback (better-auth calls this).
    // Hook body is defined above as `sendVerificationEmailHook` so unit tests
    // can import and call it directly.
    sendVerificationEmail: sendVerificationEmailHook,

    // Callback after successful email verification
    afterEmailVerification: afterEmailVerificationHook,
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
    additionalFields: {
      // The org this session acts in (§106). Chosen by `sessionCreateBeforeHook`
      // when the session is minted and changed only by `POST /api/v1/orgs/switch`,
      // which verifies membership first.
      //
      // `input: false` is load-bearing, the same way it is on `user.role`
      // above: better-auth's public `POST /api/auth/update-session` runs every
      // declared session field through the same input parser, so without this
      // line any signed-in user could set `activeOrgId` to any org — and no
      // membership check would run. With it, that endpoint answers 400 for the
      // field, and the switch route is the only writer. The switch therefore
      // does NOT go through `auth.api.updateSession` (the parser refuses the
      // field there too); it updates the row and re-issues the cookie itself.
      // `tests/unit/lib/auth/config-session-field.test.ts` proves both with
      // better-auth's own parser over these options.
      activeOrgId: {
        type: 'string',
        required: false,
        input: false,
      },
    },
  },

  // User model customization
  user: {
    additionalFields: {
      role: {
        type: 'string',
        defaultValue: DEFAULT_USER_ROLE,
        required: false,
        // NEVER client-settable. better-auth's sign-up handler passes every
        // declared additional field through from the request body unless the
        // field says `input: false` — so without this line, an unauthenticated
        // `POST /api/auth/sign-up/email` carrying `"role": "ADMIN"` created a
        // platform admin on any open-signup install (verified live, 2026-09-17).
        // The same parser runs on `POST /api/auth/update-user`, so any signed-in
        // user could also promote themselves — the second path this closes.
        // With `input: false` + a `defaultValue`, a body value is silently
        // replaced by the default on create; on update a truthy value is a
        // 400 FIELD_NOT_ALLOWED (the only client caller, avatar-upload, sends
        // `{ image }` alone).
        //
        // Fork note: better-auth merges a plugin's `schema.user.fields` OVER
        // these `additionalFields` (dist/db/schema.mjs `getFields`). A fork
        // enabling a plugin that declares its own `role` (the `admin` plugin
        // does) replaces this declaration, `input: false` included — re-add it
        // on the plugin's field or the hole reopens. Sunrise ships no plugins.
        //
        // The three legitimate writers are unaffected, because none of them go
        // through the input parser: `userCreateBeforeHook` returns the role as
        // hook DATA (first-human bootstrap, OAuth invitation) — database hooks
        // run after the parse and their return wins; `accept-invite` and the
        // admin `users/[id]` PATCH write with `prisma.user.update` directly.
        input: false,
      },
    },

    // Email changes go through approval at the OLD address (#489).
    //
    // Without this, changing the address that owns the account needed nothing
    // but a session — so one stolen cookie converted into permanent control,
    // because a session expires and an email address does not. With it, the
    // change is a two-step the attacker cannot finish: approve from the current
    // inbox, then verify at the new one. The database is untouched until the
    // second step, and `afterEmailVerificationHook` revokes other sessions when
    // it lands.
    //
    // `updateEmailWithoutVerification` is deliberately left off. It would let an
    // unverified account skip straight to a direct write, and the token it mints
    // is indistinguishable from a signup token — which would blind the
    // change-vs-signup discrimination the shared hooks depend on.
    changeEmail: {
      enabled: true,
      sendChangeEmailConfirmation: sendChangeEmailConfirmationHook,
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

  // Endpoint hooks. `hooks.before` runs for every better-auth endpoint —
  // including server-side `auth.api.*` calls — so the body checks the path
  // itself. Defined above as `signupModeBeforeHook` for direct unit testing.
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      await signupModeBeforeHook(ctx);
    }),
  },

  // Database hooks for lifecycle events.
  // Hook bodies are defined above as `userCreateBeforeHook` / `userCreateAfterHook`
  // so unit tests can import and call them directly.
  databaseHooks: {
    user: {
      create: {
        before: userCreateBeforeHook,
        after: userCreateAfterHook,
      },
    },
    session: {
      create: {
        before: sessionCreateBeforeHook,
      },
    },
  },
});

// Validate email configuration at startup
validateEmailConfig();

// Export the auth handler type for use in API routes
export type Auth = typeof auth;
