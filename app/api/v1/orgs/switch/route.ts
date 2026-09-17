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

export const POST = withAuth(
  async (request, session) => {
    const log = await getRouteLogger(request);

    // A credential's org is fixed at mint (t-673); a key cannot re-home
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

    if (!membership) {
      // Deliberately the same message for "no such org" and "not a member".
      log.warn('Org switch refused: not a member', { userId: session.user.id, orgId });
      throw new ForbiddenError('You are not a member of that organisation');
    }

    if (membership.org.status !== 'ACTIVE') {
      log.warn('Org switch refused: org suspended', { userId: session.user.id, orgId });
      throw new ForbiddenError('That organisation is suspended');
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

    log.info('Org switched', { userId: session.user.id, orgId });

    const response = successResponse({
      activeOrgId: orgId,
      org: { id: membership.org.id, slug: membership.org.slug, name: membership.org.name },
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
  }
);
