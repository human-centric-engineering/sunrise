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
 * ({@link landingRedirectFor}, which also sends an OWNER to take up the plan
 * their signup chose; {@link welcomeRedirectFor} is its location alone, kept
 * for callers of the earlier API). With no welcome route and billing off
 * nothing is read or redirected, and an app can still call
 * {@link isOrgOnboarded} its own way.
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
import { billingPlansFailed, planOf } from '@/lib/billing/plans';
import { SIGNUP_PLAN_PAGE } from '@/lib/billing/routes';
import { sessionActingOrgId } from '@/lib/tenancy/entry';
import {
  clearOrgAwaitingOnboarding,
  isSettingsWriteConflict,
  ORG_AWAITING_FOUNDER_KEY,
  readOrgCreatedOwed,
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

/** Where {@link landingRedirectFor} sends a request, and why. */
export interface LandingRedirect {
  location: string;
  /**
   * The org whose signup plan the owner is sent to take up, or `null` for
   * the welcome step. The proxy marks the browser with it
   * ({@link SIGNUP_PLAN_SENT_COOKIE}) so the owner is not sent again soon.
   */
  signupPlanOrgId: string | null;
}

/**
 * {@link landingRedirectFor}'s location alone: where the proxy should send
 * this request instead, or `null` to let it through.
 */
export async function welcomeRedirectFor(
  request: NextRequest,
  headerOrgId: string | null
): Promise<string | null> {
  return (await landingRedirectFor(request, headerOrgId))?.location ?? null;
}

/**
 * Where the proxy should send this request instead, when it is a signed-in
 * OWNER or ADMIN of an unfinished, active org reaching the landing route;
 * `null` to let it through. For the welcome step the landing request's query
 * string is carried across.
 *
 * **A plan chosen at signup** (§139 t-1096): while billing is on, the org's
 * OWNER is sent to the billing page (`SIGNUP_PLAN_PAGE`) when the org's
 * signup chose a plan not yet taken up, and the page takes it up. An ADMIN is
 * not, since only the owner can pay. A paid plan (or one the app no longer
 * registers) comes before the welcome step, which follows on the next visit.
 * A free one comes after it, and only once the org owes no org-created hooks:
 * the org's setup applies it in the background after them, so the owner is
 * sent for it only when that failed, which is what retries it. The landing
 * query is not carried there: the page replaces its own URL once it is done.
 *
 * **Once an hour per org, per browser.** A redirect there makes the proxy set
 * a short-lived cookie holding the org's id (`SIGNUP_PLAN_SENT_COOKIE`), and
 * while it names this org the owner is not sent again. So a take-up that
 * cannot finish (the billing read failing, the provider down) costs one
 * detour, not the landing route. A prefetch is never sent there: the client
 * router would cache that redirect and follow it without asking the proxy,
 * so neither the cookie nor a finished take-up would stop it.
 * A failing plan lookup skips the signup plan, never the welcome step.
 *
 * Reads nothing when the app sets no welcome route and billing is off, or
 * the path is not the landing route. With billing on that is a session read
 * and one membership read on every landing page load, as a welcome route
 * costs. The org is the one the request acts for, in the guard's
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
export async function landingRedirectFor(
  request: NextRequest,
  headerOrgId: string | null
): Promise<LandingRedirect | null> {
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
    const settings = asObject(membership.org.settings);
    // The plan the signup chose (§139 t-1096): its owner goes to the billing
    // page, which takes it up. Only the OWNER, who alone can pay.
    const signupPlan =
      billing &&
      membership.role === ORG_OWNER_ROLE &&
      !isPrefetch(request) &&
      request.cookies.get(SIGNUP_PLAN_SENT_COOKIE)?.value !== orgId &&
      !(ORG_AWAITING_FOUNDER_KEY in settings)
        ? readOrgSignupPlan(settings)
        : null;
    const kind = signupPlan === null ? null : signupPlanKind(signupPlan);
    const toPlan = { location: SIGNUP_PLAN_PAGE, signupPlanOrgId: orgId };
    if (kind === 'paid') return toPlan;
    if (AUTH_WELCOME_ROUTE !== null && !readOrgOnboarded(settings)) {
      return {
        location: withQuery(AUTH_WELCOME_ROUTE, request.nextUrl.search),
        signupPlanOrgId: null,
      };
    }
    // A free plan the org's setup failed to apply, once its hooks have run.
    return kind === 'free' && readOrgCreatedOwed(settings) === null ? toPlan : null;
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

/**
 * The cookie the proxy sets when it sends an owner to take up their signup
 * plan, holding the org's id, so it does not send them again for that org
 * while it lasts (see {@link landingRedirectFor}).
 */
export const SIGNUP_PLAN_SENT_COOKIE = 'sunrise-signup-plan-sent';

/** How long {@link SIGNUP_PLAN_SENT_COOKIE} lasts: an hour. */
export const SIGNUP_PLAN_SENT_MAX_AGE_SECONDS = 60 * 60;

/**
 * Whether a waiting signup plan is free or `paid` (a plan the app no longer
 * registers counts as paid: the take-up page says it was dropped), or `null`
 * when the plans cannot be read, so the plan is skipped and the welcome step
 * still answered.
 */
function signupPlanKind(planKey: string): 'free' | 'paid' | null {
  try {
    if (billingPlansFailed()) return null;
    return planOf(planKey)?.priceLookupKey === null ? 'free' : 'paid';
  } catch (error) {
    logger.warn('Could not read the plan chosen at signup; not sending the owner for it', {
      planKey,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Whether the request is a link prefetch, not a visit: Next's router marks
 * its own (`next-router-prefetch`), and browsers mark theirs
 * (`sec-purpose` / `purpose: prefetch`).
 */
function isPrefetch(request: NextRequest): boolean {
  const purpose = request.headers.get('sec-purpose') ?? request.headers.get('purpose') ?? '';
  return request.headers.has('next-router-prefetch') || purpose.includes('prefetch');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asObject(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
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
