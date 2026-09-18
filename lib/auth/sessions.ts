/**
 * Session revocation (#489).
 *
 * better-auth revokes sessions for a password change (`revokeOtherSessions` on
 * `changePassword`) but has no equivalent for an email change, and nothing in
 * this codebase deleted session rows at all. That gap is what turns a single
 * stolen session into a durable one: the address that owns the account can be
 * moved while every other logged-in device keeps its cookie.
 *
 * Deliberately a thin Prisma delete rather than a better-auth call: the
 * library's own revocation helpers are endpoint-scoped (they want a request
 * context we do not have inside a verification callback), whereas the `session`
 * table is a stable, documented part of the auth schema.
 *
 * @see lib/auth/config.ts · prisma/schema/auth.prisma · .context/auth/sessions.md
 */
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';

/**
 * Delete a user's sessions, optionally sparing the one making the current
 * request — the same shape as better-auth's `revokeOtherSessions` on
 * `changePassword`.
 *
 * Pass `exceptSessionToken` to keep the caller signed in. Omit it (or pass
 * `null`) to revoke everything, which is the correct degradation when the
 * current session cannot be identified: signing the user out costs them one
 * login, whereas guessing wrong would leave an attacker's session alive.
 *
 * Pass `activeOrgId` to revoke only the sessions acting in that org (§106
 * t-672: a member removed from an org loses the sessions that were inside
 * it and keeps the ones in their other orgs). Omitted, every session goes.
 *
 * Returns the number of sessions removed so callers can log it.
 */
export async function revokeUserSessions({
  userId,
  exceptSessionToken,
  activeOrgId,
  reason,
}: {
  userId: string;
  exceptSessionToken?: string | null;
  activeOrgId?: string;
  reason: string;
}): Promise<number> {
  const { count } = await prisma.session.deleteMany({
    where: {
      userId,
      ...(exceptSessionToken ? { token: { not: exceptSessionToken } } : {}),
      ...(activeOrgId ? { activeOrgId } : {}),
    },
  });

  logger.info('Revoked user sessions', {
    userId,
    reason,
    revokedCount: count,
    keptCurrentSession: Boolean(exceptSessionToken),
    ...(activeOrgId ? { activeOrgId } : {}),
  });

  return count;
}

/**
 * The token of a user's most recently created session, or `null` if they have
 * none.
 *
 * Exists for exactly one caller: `afterEmailVerificationHook`'s revocation
 * after an email change. better-auth identifies "the current session" by
 * reading the incoming request's session cookie — but when a user completes
 * the new-address verification click from a browser or device that does not
 * carry the app's cookie (ordinary: mail links routinely open in a different
 * browser or device than the one signed in), better-auth mints a brand-new
 * session server-side and calls our hook BEFORE it writes that session's
 * cookie onto the response. `getSession` on that same request therefore sees
 * nothing, and naively revoking "everything, since no current session was
 * found" would delete the session that request is about to hand back —
 * locking the user out of the very verification click that was supposed to
 * complete their change.
 *
 * The newest session row for the user is, in that situation, exactly the one
 * better-auth just created — there is no concurrent session creation to
 * confuse it with in the same request. Falling back to it sidesteps the
 * lockout without weakening the revocation: a stolen session predates the
 * change flow and is never the newest row, so it is still revoked either way.
 */
export async function findMostRecentSessionToken(userId: string): Promise<string | null> {
  const session = await prisma.session.findFirst({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    select: { token: true },
  });

  return session?.token ?? null;
}
