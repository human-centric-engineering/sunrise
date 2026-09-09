/**
 * Current User Endpoint
 *
 * GET /api/v1/users/me - Get current authenticated user's profile
 * PATCH /api/v1/users/me - Update current user's profile
 * DELETE /api/v1/users/me - Delete current user's account (Phase 3.2)
 *
 * Authentication: Required (session-based via better-auth)
 */

import { cookies } from 'next/headers';
import { verifyPassword } from 'better-auth/crypto';
import { prisma } from '@/lib/db/client';
import { successResponse, errorResponse } from '@/lib/api/responses';
import { UnauthorizedError, ErrorCodes } from '@/lib/api/errors';
import { validateRequestBody } from '@/lib/api/validation';
import { updateUserSchema, deleteAccountSchema } from '@/lib/validations/user';
import { auth } from '@/lib/auth/config';
import { withAuth } from '@/lib/auth/guards';
import { humanAdminWhere } from '@/lib/auth/account';
import { isApiKeySession } from '@/lib/auth/api-keys';
import { eraseUser } from '@/lib/privacy/erase-user';
import { getRouteLogger } from '@/lib/api/context';
import { serverTrack } from '@/lib/analytics/server';
import { EVENTS } from '@/lib/analytics/events';
import { isPlatformAdmin } from '@/lib/auth/roles';

/**
 * GET /api/v1/users/me
 *
 * Returns the current authenticated user's profile.
 * Includes extended profile fields (bio, phone, timezone, location, preferences).
 * Password field is explicitly excluded from the response.
 *
 * @returns User profile with id, name, email, role, profile fields, etc.
 * @throws UnauthorizedError if not authenticated
 */
export const GET = withAuth(
  async (request, session) => {
    const log = await getRouteLogger(request);
    log.info('Fetching current user profile');

    // Fetch user from database with all profile fields
    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: {
        id: true,
        name: true,
        email: true,
        emailVerified: true,
        image: true,
        role: true,
        createdAt: true,
        updatedAt: true,
        // Extended profile fields (Phase 3.2)
        bio: true,
        phone: true,
        timezone: true,
        location: true,
        preferences: true,
        // Explicitly exclude password
      },
    });

    if (!user) {
      throw new UnauthorizedError('User not found');
    }

    return successResponse(user);
  },
  {
    // Ownership: this route is self-scoped by construction — see RouteOwnership in lib/auth/guards.ts.
    ownership: {
      decidedBy: 'self',
      because: 'Reads `session.user.id` and nothing else — `me` is the caller by definition.',
    },
  }
);

/**
 * PATCH /api/v1/users/me
 *
 * Updates the current user's profile.
 * Supports updating name, email, and extended profile fields (bio, phone, timezone, location).
 *
 * Validates:
 * - Request body matches updateUserSchema
 * - Email is unique (if being changed)
 *
 * Changing the email address does NOT take effect in this request (#489). It
 * starts better-auth's change flow: the address only moves once the CURRENT
 * address approves and the new one is then verified. So a successful response
 * still carries the old `email`, plus `emailChangeRequested: true` to say the
 * flow began. Changing it also requires `currentPassword` on accounts that have
 * one, and revokes the user's other sessions when it finally lands.
 *
 * @param request - Request with JSON body { name?, email?, currentPassword?, bio?, phone?, timezone?, location? }
 * @returns Updated user profile, plus `emailChangeRequested`
 * @throws UnauthorizedError if not authenticated
 * @throws ValidationError if invalid data
 */
export const PATCH = withAuth(
  async (request, session) => {
    const log = await getRouteLogger(request);
    log.info('Updating current user profile');

    // Validate request body
    const body = await validateRequestBody(request, updateUserSchema);

    // Changing the address that owns the account is an identity mutation, and must
    // come from a real browser session.
    //
    // `withAuth` also accepts an API key of ANY scope (see lib/auth/guards.ts), and
    // keys are self-service. Without this check a `chat`-scoped key — handed to a
    // third-party integration, or read out of a CI config — could move the account
    // to an attacker's address, and the verification mail sent below would deliver
    // them a live token. With `autoSignInAfterVerification` enabled that token
    // mints a real session, so a read-ish scope would escalate to full account
    // takeover. Non-identity profile fields stay available over a key.
    if (body.email !== undefined && isApiKeySession(session)) {
      log.warn('Rejected API-key attempt to change account email', {
        userId: session.user.id,
      });
      return errorResponse('Changing your email address requires a browser session', {
        code: ErrorCodes.FORBIDDEN,
        status: 403,
      });
    }

    // `currentPassword` is a credential, not a column — split it (and `email`,
    // which no longer goes through Prisma at all) away from the profile fields
    // before anything reaches `prisma.user.update`.
    const { email: requestedEmail, currentPassword, ...profileFields } = body;

    // Is this request actually changing the address?
    //
    // Emails are stored lower-cased by the auth layer, but compare
    // case-insensitively anyway so a no-op re-submit of the same address (a form
    // that PATCHes every field) doesn't start a pointless change flow.
    const emailChanged =
      requestedEmail !== undefined &&
      requestedEmail.toLowerCase() !== session.user.email.toLowerCase();

    // Re-authenticate BEFORE learning anything about the target address (#489).
    //
    // This has to run before the uniqueness check below, not after. A caller
    // holding only a stolen session — no password — can still submit an
    // arbitrary `email`; if uniqueness were checked first, EMAIL_TAKEN vs. "enter
    // your password" would tell them, for free, whether any address they name is
    // a registered account. Checking the password first means every caller
    // without one gets the identical re-auth response regardless of the target
    // address, so nothing about the account directory leaks to a bare session.
    //
    // Requiring the password here matches what better-auth already demands of
    // `changePassword` and costs an attacker holding a stolen cookie something
    // they usually do not have.
    //
    // OAuth-only accounts have no password to confirm — the same condition
    // `sendResetPasswordHook` tests — so they are exempt rather than locked out of
    // their own email change. They are not left unprotected: the approval step at
    // the old address below is the control that actually stops the takeover, and
    // it applies to every account. (The uniqueness check below is still reachable
    // for these accounts without a password gate in front of it — an accepted,
    // narrower trade-off of the same OAuth-only exemption, not a new gap.)
    if (emailChanged) {
      const passwordAccount = await prisma.account.findFirst({
        where: { userId: session.user.id, password: { not: null } },
        select: { password: true },
      });

      if (passwordAccount?.password) {
        if (!currentPassword) {
          return errorResponse('Your current password is required to change your email address', {
            code: ErrorCodes.VALIDATION_ERROR,
            status: 400,
          });
        }

        const passwordValid = await verifyPassword({
          hash: passwordAccount.password,
          password: currentPassword,
        });

        if (!passwordValid) {
          log.warn('Rejected email change with an incorrect password', {
            userId: session.user.id,
          });
          return errorResponse('Current password is incorrect', {
            code: ErrorCodes.FORBIDDEN,
            status: 403,
          });
        }
      } else {
        log.info('Skipping password confirmation for an account with no password', {
          userId: session.user.id,
        });
      }
    }

    // Check email uniqueness if changing email
    if (emailChanged) {
      const existingUser = await prisma.user.findUnique({
        where: { email: requestedEmail },
      });

      if (existingUser && existingUser.id !== session.user.id) {
        return errorResponse('Email already in use', {
          code: ErrorCodes.EMAIL_TAKEN,
          status: 400,
        });
      }
    }

    // Apply the profile fields. The address is deliberately NOT among them.
    const updatedUser = await prisma.user.update({
      where: { id: session.user.id },
      data: profileFields,
      select: {
        id: true,
        name: true,
        email: true,
        emailVerified: true,
        image: true,
        role: true,
        createdAt: true,
        updatedAt: true,
        // Extended profile fields (Phase 3.2)
        bio: true,
        phone: true,
        timezone: true,
        location: true,
        preferences: true,
      },
    });

    // Hand the address change to better-auth rather than writing it here (#489).
    //
    // This endpoint used to `prisma.user.update` the new address straight in and
    // mail a verification link after the fact. That made one compromised session
    // sufficient for permanent takeover: the address moved immediately, the link
    // went to the attacker, and `autoSignInAfterVerification` turned it into a
    // fresh session. The owner was never told.
    //
    // `auth.api.changeEmail` inverts that. Nothing is written until the CURRENT
    // address approves (`sendChangeEmailConfirmationHook`) and the new one then
    // verifies, so the reply below reports the change as *requested*, not done —
    // `updatedUser.email` is still the old address, by design.
    //
    // Best-effort: the profile fields above are already saved, and better-auth
    // swallows send failures internally, so a throw here must not fail the whole
    // PATCH. `emailChangeRequested` in the response is what tells the caller
    // whether the flow actually started.
    let emailChangeRequested = false;
    if (emailChanged && requestedEmail) {
      try {
        await auth.api.changeEmail({
          body: { newEmail: requestedEmail },
          headers: request.headers,
        });
        emailChangeRequested = true;
        log.info('Email change requested — approval sent to the current address');
      } catch (changeError) {
        log.error('Failed to start email change', changeError, {
          userId: session.user.id,
        });
      }
    }

    log.info('User profile updated');

    return successResponse({ ...updatedUser, emailChangeRequested });
  },
  {
    // Ownership: this route is self-scoped by construction — see RouteOwnership in lib/auth/guards.ts.
    ownership: {
      decidedBy: 'self',
      because: "Updates the caller's own row, keyed on `session.user.id`.",
    },
  }
);

/**
 * DELETE /api/v1/users/me
 *
 * Permanently deletes the current user's account.
 * Requires confirmation by sending { confirmation: "DELETE" } in request body.
 * Deletes avatar from storage, cascades deletion to sessions and accounts.
 * Clears the session cookie after deletion.
 *
 * @param request - Request with JSON body { confirmation: "DELETE" }
 * @returns Success message confirming deletion
 * @throws UnauthorizedError if not authenticated
 * @throws ValidationError if confirmation is missing or incorrect
 */
export const DELETE = withAuth(
  async (request, session) => {
    const log = await getRouteLogger(request);

    try {
      // Validate confirmation (ensures user typed "DELETE")
      await validateRequestBody(request, deleteAccountSchema);

      // Block deletion of the last remaining admin — the system must always
      // retain an operator. Non-last admins and regular users may self-delete.
      // (Admin-deletes-other-admin is separately blocked in users/[id], which
      // requires demoting to USER first; self-delete has no such demotion gate,
      // so the last-admin check lives here.)
      //
      // Count only real human admins (`humanAdminWhere`) — the seeded SERVICE
      // config-owner has role ADMIN but cannot log in and is NOT a real operator.
      // Counting it would let the last human admin self-delete, leaving zero
      // operators and re-opening the first-user-is-admin bootstrap. See
      // lib/auth/account.ts and lib/auth/config.ts.
      if (isPlatformAdmin(session.user)) {
        const adminCount = await prisma.user.count({ where: humanAdminWhere });
        if (adminCount <= 1) {
          return errorResponse(
            'Cannot delete the last admin account. Transfer admin access to another user first.',
            { status: 400, code: 'LAST_ADMIN' }
          );
        }
      }

      // Log the deletion for audit purposes
      log.info('User account deletion initiated', {
        email: session.user.email,
      });

      // Erase the user. Schema cascades remove personal data (sessions, accounts,
      // conversations, executions, user memory, evaluations, API keys, webhook
      // subscriptions); org config + audit rows are retained with their
      // creator/userId set null; residual PII is scrubbed; an erasure receipt is
      // written; and avatar blobs are removed. See lib/privacy/erase-user.ts.
      await eraseUser({
        userId: session.user.id,
        userEmail: session.user.email,
        actorUserId: session.user.id,
        reason: 'self_service',
      });

      // Clear all better-auth cookies (session, cached session data, CSRF, OAuth state)
      const cookieStore = await cookies();
      cookieStore.delete('better-auth.session_token');
      cookieStore.delete('better-auth.session_data');
      cookieStore.delete('better-auth.csrf_token');
      cookieStore.delete('better-auth.state');
      // __Secure- cookies require the Secure attribute in the Set-Cookie header,
      // otherwise browsers silently reject the deletion. Use set() with maxAge: 0
      // instead of delete() to include the required attributes.
      const secureCookieOptions = { path: '/', secure: true, maxAge: 0 } as const;
      cookieStore.set('__Secure-better-auth.session_token', '', secureCookieOptions);
      cookieStore.set('__Secure-better-auth.session_data', '', secureCookieOptions);
      cookieStore.set('__Secure-better-auth.csrf_token', '', secureCookieOptions);
      cookieStore.set('__Secure-better-auth.state', '', secureCookieOptions);

      // Track account deletion server-side (bypasses ad blockers for critical events)
      await serverTrack({
        event: EVENTS.ACCOUNT_DELETED,
        userId: session.user.id,
      });

      log.info('User account deleted successfully');

      return successResponse({
        deleted: true,
        message: 'Account deleted successfully',
      });
    } catch (error) {
      log.error('Failed to delete user account', error);
      throw error;
    }
  },
  {
    // Ownership: this route is self-scoped by construction — see RouteOwnership in lib/auth/guards.ts.
    ownership: {
      decidedBy: 'self',
      because: "Erases the caller's own account through `eraseUser(session.user.id)`.",
    },
  }
);
