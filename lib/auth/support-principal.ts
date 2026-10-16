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
import { DEFAULT_USER_ROLE } from '@/lib/auth/roles';

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
