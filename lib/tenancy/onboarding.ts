/**
 * Org onboarding — whether an org's first-run welcome is finished
 * (§134 t-1063).
 *
 * One fact per org, kept in `Org.settings.awaitingOnboarding`
 * (`lib/tenancy/org-settings.ts`): written `true` in the INSERT of every org
 * `lib/tenancy/lifecycle.ts` creates, removed when the app calls
 * {@link markOrgOnboarded}. A missing key reads as finished, so the install
 * org and every org that existed before this shipped are finished.
 *
 * **Per org only.** An org has one founding moment a platform can record. A
 * person's own first-run tour differs per app, and recording it would be a
 * new piece of personal data with its own erasure and export rules for no
 * platform benefit, so per-user onboarding is the app's to keep.
 *
 * The platform's one use of the read: with a welcome route set
 * (`lib/app/welcome.ts`), the proxy sends a member of an unfinished org who
 * reaches the landing route to the welcome route instead
 * ({@link welcomeRedirectFor}). With none set nothing is read or redirected,
 * and an app can still call {@link isOrgOnboarded} its own way.
 *
 * **Tenancy posture:** stateless. `Org` and `OrgMembership` are system models,
 * and every read here is keyed on the org id (and user id), so it answers the
 * same under any scope.
 *
 * @see .context/tenancy/identity.md — "Onboarding: a new org's welcome step"
 */
import type { NextRequest } from 'next/server';
import type { PrismaClient } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { auth } from '@/lib/auth/config';
import { AUTH_LANDING_ROUTE, AUTH_WELCOME_ROUTE, routePathname } from '@/lib/auth-landing/route';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { sessionActingOrgId } from '@/lib/tenancy/entry';
import {
  clearOrgAwaitingOnboarding,
  isSettingsWriteConflict,
  readOrgOnboarded,
} from '@/lib/tenancy/org-settings';

/**
 * Whether an org's onboarding is finished, or `null` when there is no such
 * org. The install org is always finished.
 */
export async function isOrgOnboarded(
  orgId: string,
  db: Pick<PrismaClient, 'org'> = prisma
): Promise<boolean | null> {
  if (orgId === INSTALL_ORG_ID) return true;
  const org = await db.org.findUnique({ where: { id: orgId }, select: { settings: true } });
  return org ? readOrgOnboarded(org.settings) : null;
}

/** What {@link markOrgOnboarded} did. */
export type MarkOrgOnboardedResult = 'marked' | 'already-finished' | 'no-such-org';

/** How many times a write that clashed with another settings write is tried. */
const MARK_ATTEMPTS = 3;

/**
 * Record that an org's onboarding is finished. Idempotent: an org that is
 * already finished is left as it was.
 *
 * This decides nothing about who may finish it. Call it from your own server
 * code (a route handler or server action) after checking the caller may act
 * for the org, typically an OWNER or ADMIN who has completed your welcome
 * step. The install org is always finished, so it answers `already-finished`.
 *
 * Another write to the same org's settings at the same moment (an org-created
 * hook finishing, staff saving the org) can clash with this one; it is tried
 * again, up to three times, before the clash is thrown.
 */
export async function markOrgOnboarded(
  orgId: string,
  db: Pick<PrismaClient, '$transaction'> = prisma
): Promise<MarkOrgOnboardedResult> {
  if (orgId === INSTALL_ORG_ID) return 'already-finished';
  for (let attempt = 1; ; attempt++) {
    try {
      const result = await clearOrgAwaitingOnboarding(orgId, db);
      if (result === null) return 'no-such-org';
      if (result.written) logger.info('Org onboarding marked finished', { orgId });
      return result.written ? 'marked' : 'already-finished';
    } catch (error) {
      if (attempt >= MARK_ATTEMPTS || !isSettingsWriteConflict(error)) throw error;
    }
  }
}

/**
 * Where the proxy should send this request instead, when it is a signed-in
 * member of an unfinished org reaching the landing route; `null` to let it
 * through.
 *
 * Reads nothing when the app sets no welcome route, or the path is not the
 * landing route. The org is the one the request acts for, in the guard's
 * precedence (the app's tenant resolver, else the session's active org, else
 * the install org at `single`), and only a membership of it counts: platform
 * staff looking at a customer's org are not sent to its welcome step. A read
 * that fails lets the request through to the landing route, logged at
 * `warn`: a welcome step is not worth an outage.
 *
 * @param headerOrgId the org the app's tenant resolver names for this
 *   request, as the proxy computed it (not a client's header).
 */
export async function welcomeRedirectFor(
  request: NextRequest,
  headerOrgId: string | null
): Promise<string | null> {
  if (AUTH_WELCOME_ROUTE === null) return null;
  if (routePathname(request.nextUrl.pathname) !== landingPathname) return null;

  try {
    const session = await auth.api.getSession({ headers: request.headers });
    const userId = session?.user?.id;
    if (!userId) return null;
    const orgId = sessionActingOrgId(headerOrgId, session.session?.activeOrgId);
    if (!orgId || orgId === INSTALL_ORG_ID) return null;

    const membership = await prisma.orgMembership.findUnique({
      where: { orgId_userId: { orgId, userId } },
      select: { org: { select: { settings: true } } },
    });
    if (!membership || readOrgOnboarded(membership.org.settings)) return null;
    return AUTH_WELCOME_ROUTE;
  } catch (error) {
    logger.warn(
      'Could not read org onboarding for the landing route; letting the request through',
      {
        error: error instanceof Error ? error.message : String(error),
      }
    );
    return null;
  }
}

const landingPathname = routePathname(AUTH_LANDING_ROUTE);
