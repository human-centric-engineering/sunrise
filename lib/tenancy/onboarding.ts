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
 * (`lib/app/welcome.ts`), the proxy sends an OWNER or ADMIN of an unfinished,
 * active org who reaches the landing route to the welcome route instead
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
import { ORG_OWNER_ROLE, orgAdministers } from '@/lib/tenancy/roles';
import { billingEnabled } from '@/lib/billing/config';
import { SIGNUP_PLAN_PAGE } from '@/lib/billing/upgrade-url';
import { sessionActingOrgId } from '@/lib/tenancy/entry';
import {
  clearOrgAwaitingOnboarding,
  isSettingsWriteConflict,
  ORG_AWAITING_FOUNDER_KEY,
  readOrgOnboarded,
  readOrgSignupPlan,
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
 * The longest pause before trying a clashed write again, in ms. The pause is
 * random up to this, so two writers that clashed do not clash again in step.
 */
const MARK_RETRY_JITTER_MS = 50;

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
 * again after a short random pause, up to three attempts in all, before the
 * clash is thrown.
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
      if (!isSettingsWriteConflict(error)) throw error;
      if (attempt >= MARK_ATTEMPTS) {
        logger.warn('Org onboarding mark clashed with another settings write on every attempt', {
          orgId,
          attempts: attempt,
        });
        throw error;
      }
      logger.debug('Org onboarding mark clashed with another settings write; trying again', {
        orgId,
        attempt,
      });
    }
    await new Promise((resolve) => setTimeout(resolve, Math.random() * MARK_RETRY_JITTER_MS));
  }
}

/**
 * Where the proxy should send this request instead, when it is a signed-in
 * OWNER or ADMIN of an unfinished, active org reaching the landing route;
 * `null` to let it through. The landing request's query string is carried
 * across.
 *
 * **A plan chosen at signup comes first** (§139 t-1096): while billing is
 * on, the org's OWNER is sent to the billing page (`SIGNUP_PLAN_PAGE`) when
 * the org's signup chose a plan not yet taken up, and the page takes it up.
 * An ADMIN is not, since only the owner can pay. That holds whether or not
 * a welcome route is set; the welcome step follows on the next visit.
 *
 * Reads nothing when the app sets no welcome route and billing is off, or
 * the path is not the landing route. The org is the one the request acts for, in the guard's
 * precedence (the app's tenant resolver, else the session's active org, else
 * the install org at `single`), and only a membership of it counts: platform
 * staff looking at a customer's org are not sent to its welcome step.
 *
 * Only a role that may finish onboarding is sent (`orgAdministers`): a plain
 * MEMBER invited before the owner finished could not complete the step, and
 * would be bounced off the landing route on every visit until the owner did.
 * A suspended org is not redirected either; the landing route's own guard
 * refuses it there, as it would without a welcome route. Only a GET or HEAD
 * page load is redirected, never a server action. Next's prefetch of the
 * landing route (the header brand link) is answered too, so it costs a
 * session and membership read per prefetch while a welcome route is set. A read
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
  const billing = billingEnabled();
  if (AUTH_WELCOME_ROUTE === null && !billing) return null;
  // A page load only. A server action posted from the landing page (or any
  // other non-GET) answered with a redirect would fail in the client.
  if (request.method !== 'GET' && request.method !== 'HEAD') return null;
  if (request.headers.has('next-action')) return null;
  if (routePathname(request.nextUrl.pathname) !== landingPathname) return null;

  try {
    const session = await auth.api.getSession({ headers: request.headers });
    const userId = session?.user?.id;
    if (!userId) return null;
    const orgId = sessionActingOrgId(headerOrgId, session.session?.activeOrgId);
    if (!orgId || orgId === INSTALL_ORG_ID) return null;

    const membership = await prisma.orgMembership.findUnique({
      where: { orgId_userId: { orgId, userId } },
      select: { role: true, org: { select: { status: true, settings: true } } },
    });
    if (!membership || !orgAdministers(membership.role)) return null;
    if (membership.org.status !== 'ACTIVE') return null;
    // The plan the signup chose comes first (§139 t-1096): its owner goes to
    // the billing page, which takes it up. Only the OWNER, who alone can pay.
    if (
      billing &&
      membership.role === ORG_OWNER_ROLE &&
      readOrgSignupPlan(membership.org.settings) !== null &&
      !(ORG_AWAITING_FOUNDER_KEY in asObject(membership.org.settings))
    ) {
      return SIGNUP_PLAN_PAGE;
    }
    if (AUTH_WELCOME_ROUTE === null) return null;
    if (readOrgOnboarded(membership.org.settings)) return null;
    return withQuery(AUTH_WELCOME_ROUTE, request.nextUrl.search);
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

function asObject(value: unknown): object {
  return typeof value === 'object' && value !== null ? value : {};
}

/** The query key Next adds to RSC and prefetch requests to bust caches. */
const NEXT_RSC_QUERY_KEY = '_rsc';

/**
 * The welcome route with the landing request's query string added, so a
 * parameter a door into the app passed (`?joined=acme`) survives the hop. A
 * key the welcome route already sets keeps its own value. Next's own `_rsc`
 * cache-busting key belongs to the landing request and is not copied.
 */
function withQuery(route: string, search: string): string {
  if (search === '' || search === '?') return route;
  const url = new URL(route, 'http://localhost');
  for (const [key, value] of new URLSearchParams(search)) {
    if (key === NEXT_RSC_QUERY_KEY || url.searchParams.has(key)) continue;
    url.searchParams.append(key, value);
  }
  return `${url.pathname}${url.search}${url.hash}`;
}
