/**
 * What a support session is to everything downstream of entry (§121 t-824).
 *
 * A platform admin admitted to a customer org under its support grant
 * (`enterSessionOrg`, source `'support'`) acts there as an org ADMIN who is
 * **not** a platform admin — the owner's ruling 3. That is done by changing
 * what the caller *presents*, not by a flag a policy has to remember to read:
 * the platform role is replaced with the default user role on the principal
 * the policy is asked about and on the session the handler is handed. So a
 * policy written as `isPlatformAdmin(viewer)`, a handler that checks
 * `isPlatformAdmin(session.user)`, and core's own default policy all answer
 * as they would for the org's own ADMIN — fail-closed for every policy, a
 * fork's included. The user's id is untouched: every row and audit entry
 * still names the individual who acted.
 *
 * The stored `User.role` is not changed; only this request's view of it.
 *
 * @see lib/tenancy/entry.ts — where a support entry is admitted
 * @see .context/tenancy/support-access.md
 */
import { ForbiddenError } from '@/lib/api/errors';
import { DEFAULT_USER_ROLE } from '@/lib/auth/roles';
import { logger } from '@/lib/logging';

/** Did this entry admit a support session? */
export function isSupportEntry(entry: { source: string } | null | undefined): boolean {
  return entry?.source === 'support';
}

/**
 * The platform role a caller presents for this request: their own, or the
 * default user role inside a support session.
 */
export function presentedRole(
  role: string | null | undefined,
  entry: { source: string } | null | undefined
): string | null | undefined {
  return isSupportEntry(entry) ? DEFAULT_USER_ROLE : role;
}

/**
 * `session` as the handler sees it: unchanged, or inside a support session
 * with the platform role replaced. A copy — the cached session object is
 * never mutated.
 */
export function presentedSession<S extends { user: { role?: string | null } }>(
  session: S,
  entry: { source: string } | null | undefined
): S {
  if (!isSupportEntry(entry)) return session;
  return { ...session, user: { ...session.user, role: DEFAULT_USER_ROLE } };
}

/** HTTP methods a READ_ONLY support grant admits. Everything else is a write. */
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Is this request a write a READ_ONLY support session must refuse? */
export function isRefusedReadOnlyWrite(
  entry: { source: string; support?: { level: string } } | null | undefined,
  method: string | undefined
): boolean {
  if (!isSupportEntry(entry) || entry?.support?.level !== 'READ_ONLY') return false;
  // No method is not a read: refuse what cannot be classified.
  return !READ_METHODS.has((method ?? '').toUpperCase());
}

/** The refusal a READ_ONLY support session's write gets, in the guards and outside them. */
export const READ_ONLY_SUPPORT_MESSAGE = 'Support access to this organisation is read-only';

/**
 * Refuse a write under a READ_ONLY support grant: log it and throw
 * `ForbiddenError` (403). Does nothing for any other request. The one
 * statement of the refusal, used by the guards and by
 * {@link presentSessionEntry}, so the log line and the 403 are the same on both
 * paths. `context` is added to the log line (the guard, the path, the user).
 */
export function refuseReadOnlySupportWrite(
  entry: { source: string; orgId?: string; support?: { level: string; grantId?: string } },
  method: string | undefined,
  context: Record<string, unknown> = {}
): void {
  if (!isRefusedReadOnlyWrite(entry, method)) return;
  logger.warn('tenancy: refused a write under a read-only support grant', {
    ...context,
    method,
    orgId: entry.orgId,
    grantId: entry.support?.grantId,
  });
  throw new ForbiddenError(READ_ONLY_SUPPORT_MESSAGE);
}

/**
 * Both support-session rules, for a route that enters an org itself
 * (`enterSessionOrg`) instead of through `withAuth` / `withAdminAuth` — a
 * route that also serves a cookie-less caller, say. The guards apply these
 * rules for every route they wrap; outside them the caller must, or a support
 * actor keeps their platform `ADMIN` role and a READ_ONLY grant stops no write.
 *
 * Throws `ForbiddenError` (403) for a write under a READ_ONLY grant, before
 * the caller does anything. Otherwise returns `session` as a handler inside
 * the guards would see it: the default user role in place of the platform
 * role inside a support session, unchanged everywhere else.
 *
 * `entry` is the entry `enterSessionOrg()` returned, after the caller refused
 * an `OrgRefusal`. It is not nullable on purpose: a caller that turned a
 * refusal into `null` would otherwise get the raw session back.
 *
 * ```typescript
 * const entry = await enterSessionOrg(user, activeOrgId, headerOrgId);
 * if (isOrgRefusal(entry)) throw new ForbiddenError('Access denied');
 * const session = presentSessionEntry(rawSession, entry, request.method, { path });
 * // false for a support actor
 * const admin = isPlatformAdmin(session.user);
 * // Run the work in the org's tenant context, as the guards do: row
 * // isolation reads it, and so does the support stamp on audit rows.
 * return runAsOrg(entry.orgId, () => handle(session, admin), {
 *   source: entry.source,
 *   role: entry.role,
 *   ...(entry.support ? { support: entry.support } : {}),
 * });
 * ```
 *
 * `context` is added to the refusal's log line beside the user, as the guards
 * add their name and the path.
 *
 * @see .context/tenancy/support-access.md — entering an org outside the guards
 */
export function presentSessionEntry<S extends { user: { id?: string; role?: string | null } }>(
  session: S,
  entry: { source: string; orgId?: string; support?: { level: string; grantId?: string } },
  method: string | undefined,
  context: Record<string, unknown> = {}
): S {
  refuseReadOnlySupportWrite(entry, method, { ...context, userId: session.user.id });
  return presentedSession(session, entry);
}
