/**
 * The principal a cookie session is to the authorization policy, outside a
 * route guard (§111 t-810).
 *
 * The guards build their principal from the org they enter (`enterSessionOrg`,
 * resolver header first) and the caller's verified role in it. The two
 * chokepoints that are not guards — the admin layout and the maintenance
 * bypass — must hand the policy the same facts, or a fork's `canAdminister`
 * that reads `viewer.orgRole` answers one way at the API and another at the
 * page. This is the one place those two build it.
 *
 * **Where it differs from the guards, on purpose.** A guard refuses a request
 * whose org entry is refused (not a member, a suspended org, no org at
 * `multi`). Here a refused entry, or a membership read that throws, yields a
 * principal with **no org facts** and the caller decides: the platform
 * question is still answerable from the role, and every org-facts arm of the
 * default policy (the org arm, the tier arm) has nothing to admit. That keeps
 * a platform admin able to reach the console (and the org switcher) from a
 * session whose active org went away, which is what the layout has always
 * done, while the routes the console calls still refuse until they switch.
 */
import { enterSessionOrg, isOrgRefusal } from '@/lib/tenancy/entry';
import { logger } from '@/lib/logging';
import type { AuthorizationPrincipal, AuthorizationScope } from '@/lib/auth/authorization';

export interface SessionLike {
  user: { id: string; role?: string | null };
  session: { activeOrgId?: string | null };
}

export interface SessionPrincipal {
  principal: AuthorizationPrincipal;
  /** `{ org }` for the entered org, or `{}` when none was entered. */
  scope: AuthorizationScope;
}

/**
 * Describe `session` to the policy, entering its org as the guards would.
 *
 * @param headerOrgId the proxy-written resolver header, or `null`.
 */
export async function sessionPrincipal(
  session: SessionLike,
  headerOrgId: string | null
): Promise<SessionPrincipal> {
  const base: AuthorizationPrincipal = {
    userId: session.user.id,
    role: session.user.role,
    credential: 'session',
  };
  try {
    const entry = await enterSessionOrg(
      { id: session.user.id, role: session.user.role },
      session.session.activeOrgId ?? null,
      headerOrgId
    );
    if (isOrgRefusal(entry)) return { principal: base, scope: {} };
    return {
      principal: { ...base, orgId: entry.orgId, orgRole: entry.role },
      scope: { org: entry.orgId },
    };
  } catch (error) {
    // No org facts is the closed answer: nothing org-scoped is admitted, and
    // the platform question does not need them.
    logger.error(
      'authorization: could not enter the session’s org — asking without org facts',
      error,
      { userId: session.user.id }
    );
    return { principal: base, scope: {} };
  }
}
