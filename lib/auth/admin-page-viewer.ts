/**
 * Who is viewing this admin page: the platform, or an org admin? (§111 t-812)
 *
 * The admin layout admits a platform admin to any page, an org OWNER/ADMIN
 * of the entered org to an org-tier page, and a holder of a fork's named tier
 * (t-999) to a page declared for it ({@link requestAdminReach} works out
 * which). Most org-tier
 * pages serve both the same, because row isolation already bounds what their
 * API calls read to the entered org. The mixed pages do not — the
 * orchestration dashboard, costs, executions and the MCP landing each pair
 * the org's figures with a platform-ops panel — so they ask this, and render
 * the platform-ops half for a platform viewer only. (Analytics is org-tier too,
 * but has no platform-ops half, so it does not ask.) The API routes behind
 * that half refuse an org admin regardless; this decides what the page shows,
 * not what it may read.
 *
 * The admin layout asks its platform question through
 * {@link requestAdministersPlatform} too (inside {@link requestAdminReach}), so a page and the layout cannot
 * disagree about who is the platform. Both are `cache()`d per request: the
 * session lookup, membership read and policy call run once per render, not
 * once in the layout and again in the page.
 *
 * @see lib/auth/admin-viewer.ts — the same question, asked inside an org-tier API route
 */
import { cache } from 'react';
import { headers } from 'next/headers';

import { sessionPrincipal } from '@/lib/auth/session-principal';
import { getServerSession } from '@/lib/auth/utils';
import type { AdminReach, AdminViewerTier, LockedAdminSwitch } from '@/lib/auth/admin-tier';
import { administersPlatformIn, lockedSwitchesOf, orgAdminReachOf } from '@/lib/auth/admin-reach';
import { TENANT_HEADER_NAME } from '@/lib/tenancy/resolver';
import { prisma } from '@/lib/db/client';
import { isPlatformAdmin } from '@/lib/auth/roles';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { isMultiTenant } from '@/lib/tenancy/context';
import { sessionActingOrgId } from '@/lib/tenancy/entry';
import type { SupportGrantLevel } from '@/lib/tenancy/roles';
import { SUPPORT_GRANT_LIST_LIMIT } from '@/lib/tenancy/support-grants';

/**
 * This request's principal and scope, built from its session and the org it
 * entered, as the guards build them; `null` with no session.
 */
export const requestPrincipal = cache(async () => {
  const session = await getServerSession();
  if (!session) return null;
  const requestHeaders = await headers();
  return sessionPrincipal(session, requestHeaders.get(TENANT_HEADER_NAME) || null);
});

/**
 * Does this request's session administer the platform, in the org it entered?
 * The policy asked with no resource and no tier — the question every
 * platform-only surface asks. No session is no.
 */
export const requestAdministersPlatform = cache(async (): Promise<boolean> => {
  const entry = await requestPrincipal();
  if (!entry) return false;
  return administersPlatformIn(entry.principal, entry.scope);
});

/**
 * The viewer tier of the admin page being rendered: `'platform'`, or `'org'`
 * for everyone else the layout admitted — and for a request with no session,
 * since the narrower view is the safe answer to a question that could not be
 * asked. `'org'` means "not a platform viewer", not "an org OWNER/ADMIN": a
 * holder of a fork's named tier (t-999) is `'org'` here too. The mixed pages
 * ask only whether to render their platform-ops half; a page that needs to
 * know which tiers the viewer holds asks {@link requestAdminReach}.
 */
export async function adminPageViewerTier(): Promise<AdminViewerTier> {
  return (await requestAdministersPlatform()) ? 'platform' : 'org';
}

/**
 * What this request's viewer may open in the admin console (t-999): every
 * surface for a platform admin, otherwise the tiers the policy admits them to
 * in the org they entered — `'org'`, and each named tier the fork registered —
 * and, for a holder of named tiers who is not an org admin, where `/admin`
 * sends them.
 *
 * The policy is asked once per tier, with the same principal and scope the
 * guards build, so the layout's answer for a page is the policy's answer for
 * that page's own tier. Then, for each tier it admitted, once per switch a
 * page requires, with that switch as `scope.requires` (§135 t-1034), so the
 * gate and the sidebar can refuse a page or hide an item whose switch the org
 * lacks, by the policy's answer rather than one worked out in the browser.
 * Only the switches pages require, not every registered one: an app may
 * register a hundred, and each question is a policy call and a read. A nav
 * item's `requires` is its page's (the roster test holds them equal), so
 * that covers the sidebar too. With no page requiring a switch there is no
 * further question, so vanilla Sunrise asks exactly what it asked before.
 * Asked once per request, however many readers ask. No session reaches
 * nothing.
 */
export const requestAdminReach = cache(async (): Promise<AdminReach> => {
  if (await requestAdministersPlatform()) return 'platform';
  const entry = await requestPrincipal();
  if (!entry) return { tiers: [], landing: null };
  return orgAdminReachOf(entry.principal, entry.scope);
});

/**
 * The switches this request's viewer's org lacks that the app shows locked
 * rather than hidden (§135 t-1053), for the sidebar to show their items
 * locked and the layout and gate to show their pages locked. Empty for a
 * platform viewer, whom switches do not limit, and on an install where no
 * page requires a switch registered `whenLacking: 'lock'`, so nothing more is
 * read there.
 *
 * Only a switch the org's switches were read for and found off is here. One
 * the org has (the policy refused for another reason), or whose read failed,
 * is left out, so its surfaces stay hidden as before rather than tell an
 * admin to buy something their org may have. A policy that would also refuse
 * once the org has it cannot be told apart from here; its refusal applies
 * then. One read of the org's switches,
 * once per request, whatever number are locked.
 */
export const requestLockedSwitches = cache(async (): Promise<readonly LockedAdminSwitch[]> => {
  const reach = await requestAdminReach();
  if (reach === 'platform' || reach.tiers.length === 0) return [];
  return lockedSwitchesOf(reach, (await requestPrincipal())?.principal.orgId);
});

/**
 * The org this request acts in, as the guards entered it: its id and name,
 * or `null` when no org was entered (§111 t-813). Everything on an org-tier
 * page is this org's, so the console header names it, and the Members page
 * manages its roster. `Org` is a control-plane model, so reading its name
 * needs no tenant scope.
 */
export const requestActingOrg = cache(async (): Promise<{ id: string; name: string } | null> => {
  const orgId = (await requestPrincipal())?.principal.orgId;
  if (!orgId) return null;
  return prisma.org.findUnique({ where: { id: orgId }, select: { id: true, name: true } });
});

/**
 * The support session this request is in, for the admin layout's banner
 * (§121 t-824): `active` while a platform admin acts in an org under its
 * grant, `ended` once the grant that let them in has expired or been revoked
 * (or no longer admits them), and `null` for everyone else.
 *
 * `ended` is the remedy `HB10` asks for. Entry refuses the next request once
 * a grant ends, so every API call the page makes answers 403; the layout
 * says why, and offers the same way back as the banner, rather than leaving
 * a bare refusal. It is recognised as a platform admin refused entry to an
 * org they are not a member of, which they entered as support under one of
 * its grants (the switch route's `support.enter` audit row). Anyone else was
 * never in a support session there, and nothing is shown.
 */
export type SupportSessionView =
  | {
      state: 'active';
      orgId: string;
      orgName: string;
      level: SupportGrantLevel;
      /** ISO 8601; the banner counts down to it. */
      expiresAt: string;
      /**
       * Entered through a fork's resolver header (the org of this address),
       * not the session's own choice. A switch cannot end such a session,
       * because the header wins over `activeOrgId`; leaving the address does.
       */
      viaResolver: boolean;
    }
  | { state: 'ended'; orgId: string; orgName: string };

export const requestSupportSession = cache(async (): Promise<SupportSessionView | null> => {
  if (!isMultiTenant()) return null;
  const entry = await requestPrincipal();
  if (!entry) return null;

  if (entry.support && entry.principal.orgId) {
    const viaResolver = Boolean((await headers()).get(TENANT_HEADER_NAME));
    const org = await prisma.org.findUnique({
      where: { id: entry.principal.orgId },
      select: { name: true },
    });
    return {
      state: 'active',
      orgId: entry.principal.orgId,
      orgName: org?.name ?? 'this organisation',
      level: entry.support.level,
      expiresAt: entry.support.expiresAt.toISOString(),
      viaResolver,
    };
  }

  if (entry.refused !== 'not-a-member' || !isPlatformAdmin(entry.principal)) return null;
  const session = await getServerSession();
  const requestHeaders = await headers();
  const orgId = sessionActingOrgId(
    requestHeaders.get(TENANT_HEADER_NAME) || null,
    session?.session.activeOrgId
  );
  if (!orgId || orgId === INSTALL_ORG_ID) return null;

  // Ended means THIS admin entered this org under one of its grants: the
  // switch route's `support.enter` row says so. An org that merely granted
  // support once is not enough — a platform admin removed as a member, or
  // sent there by a fork's resolver, was never in a support session.
  const org = await prisma.org.findUnique({
    where: { id: orgId },
    select: {
      name: true,
      supportGrants: {
        select: { id: true },
        orderBy: { createdAt: 'desc' },
        take: SUPPORT_GRANT_LIST_LIMIT,
      },
    },
  });
  if (!org || org.supportGrants.length === 0) return null;
  const entered = await prisma.aiAdminAuditLog.findFirst({
    where: {
      userId: entry.principal.userId,
      action: 'support.enter',
      entityType: 'support_grant',
      entityId: { in: org.supportGrants.map((grant) => grant.id) },
    },
    select: { id: true },
  });
  if (!entered) return null;
  return { state: 'ended', orgId, orgName: org.name };
});

/**
 * A platform admin acting in a customer org as a member there (t-1032), for
 * the banner that offers the way back: `null` for everyone else, a support
 * session included (it has its own banner).
 *
 * Outside the install org the guards present a member platform admin as
 * their org role alone (`lib/auth/support-principal.ts`), so every
 * platform-only page and route refuses them there, and an org MEMBER is not
 * admitted to the console at all. That refusal is correct; this is its
 * remedy (`HB10`): say where they are, as what, and switch them back to the
 * install org, where the platform role is theirs again. Read for both
 * shells, the console's and the account area's.
 */
export interface MemberPlatformAdminView {
  /** `null` only if the row went between entry and this read; the banner words it. */
  orgName: string | null;
  /** Their role in the org they are acting in. */
  orgRole: string;
  /** The install org's name: where platform administration is done. */
  installOrgName: string | null;
  /**
   * Entered through a fork's resolver header (the org of this address). A
   * switch cannot leave it, because the header wins over `activeOrgId`.
   */
  viaResolver: boolean;
}

export const requestMemberPlatformAdmin = cache(
  async (): Promise<MemberPlatformAdminView | null> => {
    if (!isMultiTenant()) return null;
    const entry = await requestPrincipal();
    if (!entry?.platformRoleWithheld || entry.support) return null;
    const { orgId, orgRole } = entry.principal;
    if (!orgId || !orgRole) return null;
    // The principal's role is the presented one; whether they are staff is
    // the session's own.
    const session = await getServerSession();
    if (!isPlatformAdmin(session?.user)) return null;

    const [org, installOrg, requestHeaders] = await Promise.all([
      prisma.org.findUnique({ where: { id: orgId }, select: { name: true } }),
      prisma.org.findUnique({ where: { id: INSTALL_ORG_ID }, select: { name: true } }),
      headers(),
    ]);
    return {
      orgName: org?.name ?? null,
      orgRole,
      installOrgName: installOrg?.name ?? null,
      viaResolver: Boolean(requestHeaders.get(TENANT_HEADER_NAME)),
    };
  }
);
