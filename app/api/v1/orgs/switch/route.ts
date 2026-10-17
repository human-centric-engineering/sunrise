/**
 * Switch the org the current session acts in (§106)
 *
 * POST /api/v1/orgs/switch — `{ orgId }` → the session's `activeOrgId`
 *
 * A user may belong to several orgs; the session records which one they are
 * acting in, and this is the one writer of that field after sign-in.
 *
 * Two things a reader should not have to rediscover:
 *
 * - **It does not go through `auth.api.updateSession`.** `activeOrgId` is
 *   declared `input: false` (`lib/auth/config.ts`), which is what stops the
 *   public `POST /api/auth/update-session` from letting any signed-in user set
 *   it to any org with no membership check — and the same parser refuses the
 *   field on the server-side call. So the row is written with Prisma here,
 *   after the membership check that endpoint could never make.
 * - **The cookie is re-issued, not just the row.** The session cookie cache
 *   (`cookieCache`, 5 minutes) is what the guards read; updating the row alone
 *   would leave the old org live on every request until it expired. A
 *   `getSession` with `disableCookieCache` reads the row and re-sets the cache
 *   cookie; its `Set-Cookie` headers are forwarded, the accept-invite precedent.
 *   (better-auth skips that re-set for a `rememberMe: false` session; Sunrise
 *   never sends one.)
 *
 * Refusals do not enumerate: a non-member gets the same 403 whether the org
 * exists or not. A suspended org is named as such only to its own members.
 *
 * **Support (§121 t-824).** A platform admin who is not a member may switch
 * into an org with an open support grant, by `verifiedSupportGrant` — the
 * rule entry applies on every request after — and the switch writes a
 * `support.enter` audit row. Switching back to the install org is how a
 * support session ends, including one whose grant has already ended: this
 * route does not enter the current org, so it works from a refused one.
 *
 * And it is the one guarded route that does NOT enter the session's current
 * org (`tenancy: { entersOrg: false }`): the guard refuses a session whose
 * active org is suspended or no longer theirs, which is what suspension
 * means — but a switch behind that refusal would leave such a member with no
 * way to reach the other orgs they belong to.
 */

import { withAuth } from '@/lib/auth/guards';
import { auth } from '@/lib/auth/config';
import { isApiKeySession } from '@/lib/auth/api-keys';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { ForbiddenError } from '@/lib/api/errors';
import { validateRequestBody } from '@/lib/api/validation';
import { switchOrgSchema } from '@/lib/validations/tenancy';
import { getRouteLogger } from '@/lib/api/context';
import { isPlatformAdmin } from '@/lib/auth/roles';
import { isMultiTenant } from '@/lib/tenancy/context';
import { verifiedSupportGrant } from '@/lib/tenancy/entry';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { getClientIP } from '@/lib/security/ip';

export const POST = withAuth(
  async (request, session) => {
    const log = await getRouteLogger(request);

    // A credential's org is fixed at mint; a key cannot re-home
    // itself. Same refusal shape as minting a key over a key.
    if (isApiKeySession(session)) {
      log.warn('Rejected API-key attempt to switch org', { userId: session.user.id });
      throw new ForbiddenError('Switching org requires a browser session');
    }

    const { orgId } = await validateRequestBody(request, switchOrgSchema);

    const membership = await prisma.orgMembership.findUnique({
      where: { orgId_userId: { orgId, userId: session.user.id } },
      select: { org: { select: { id: true, slug: true, name: true, status: true } } },
    });

    // A platform admin who is not a member may switch into an org that has an
    // open support grant (§121 t-824) — the same rule the guards enter it by,
    // so a switch that succeeds is a session the next request admits. The
    // guard does not enter an org on this route, so `session.user.role` here
    // is the caller's own, not a support session's presented one.
    const support =
      !membership && isMultiTenant() && isPlatformAdmin(session.user)
        ? await verifiedSupportGrant(orgId)
        : null;

    if (!membership && !support) {
      // Deliberately the same message for "no such org" and "not a member".
      // A platform admin at `multi` is told what they were missing instead:
      // they list every org already, so the answer enumerates nothing.
      log.warn('Org switch refused: not a member', { userId: session.user.id, orgId });
      throw new ForbiddenError(
        isMultiTenant() && isPlatformAdmin(session.user)
          ? 'That organisation has no open support grant'
          : 'You are not a member of that organisation'
      );
    }

    if (membership && membership.org.status !== 'ACTIVE') {
      log.warn('Org switch refused: org suspended', { userId: session.user.id, orgId });
      throw new ForbiddenError('That organisation is suspended');
    }

    // A grant only admits into an active org, so this read finds it.
    const org =
      membership?.org ??
      (await prisma.org.findUnique({
        where: { id: orgId },
        select: { id: true, slug: true, name: true },
      }));
    if (!org) {
      log.warn('Org switch refused: org gone under its grant', { userId: session.user.id, orgId });
      throw new ForbiddenError('You are not a member of that organisation');
    }

    await prisma.session.update({
      where: { id: session.session.id },
      data: { activeOrgId: orgId },
    });

    // Re-read the row through better-auth so the cookie cache is re-issued
    // with the new org; the cookies come back on the response, not the store.
    // Deliberately NOT caught: if this throws after the row write (a session
    // revoked concurrently, say) the caller sees an error for a switch that
    // did take effect — but the write is idempotent and a retry converges,
    // whereas answering 200 without a re-issued cookie would leave the old
    // org live on every request until the cache expired.
    const refreshed = await auth.api.getSession({
      headers: request.headers,
      query: { disableCookieCache: true },
      asResponse: true,
    });

    if (support) {
      // Entering under a grant is the support act the org's consent covers;
      // the audit row names the individual and the grant.
      logAdminAction({
        userId: session.user.id,
        action: 'support.enter',
        entityType: 'support_grant',
        entityId: support.grantId,
        entityName: org.name,
        metadata: {
          orgId,
          level: support.level,
          expiresAt: support.expiresAt.toISOString(),
        },
        clientIp: getClientIP(request),
        // This route does not enter the org it switches to, so there is no
        // support context for the logger to read the stamp from (t-825).
        support: { grantId: support.grantId, orgId },
      });
      log.info('Org switched under a support grant', {
        userId: session.user.id,
        orgId,
        grantId: support.grantId,
      });
    } else {
      log.info('Org switched', { userId: session.user.id, orgId });
    }

    const response = successResponse({
      activeOrgId: orgId,
      org: { id: org.id, slug: org.slug, name: org.name },
      support: support
        ? { grantId: support.grantId, level: support.level, expiresAt: support.expiresAt }
        : null,
    });
    for (const cookie of refreshed.headers.getSetCookie()) {
      response.headers.append('Set-Cookie', cookie);
    }
    return response;
  },
  {
    // Ownership: this route is self-scoped by construction — see RouteOwnership in lib/auth/guards.ts.
    ownership: {
      decidedBy: 'self',
      because:
        'Reads the membership by `(orgId, session.user.id)` and writes the caller’s own session row; no other subject can be named.',
    },
    // The one route that must not enter the session's current org: a member
    // whose active org was suspended, or who was removed from it, is refused
    // everywhere else — and this is how they leave it. The membership check
    // above is for the org they are switching TO. The reads and the session
    // write above are cross-org by design; §107 owes them an audited entry
    // (see the marker's docblock in lib/auth/guards.ts).
    tenancy: {
      entersOrg: false,
      because:
        'This is the way out of a refused org; entering it first would lock a member of a suspended org out of every other org they belong to.',
    },
  }
);
