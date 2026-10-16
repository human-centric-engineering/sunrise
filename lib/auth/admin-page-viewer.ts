/**
 * Who is viewing this admin page: the platform, or an org admin? (§111 t-812)
 *
 * The admin layout admits two kinds of viewer: a platform admin to any page,
 * and an org OWNER/ADMIN of the entered org to an org-tier page. Most org-tier
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
 * {@link requestAdministersPlatform} too, so a page and the layout cannot
 * disagree about who is the platform. Both are `cache()`d per request: the
 * session lookup, membership read and policy call run once per render, not
 * once in the layout and again in the page.
 *
 * @see lib/auth/admin-viewer.ts — the same question, asked inside an org-tier API route
 */
import { cache } from 'react';
import { headers } from 'next/headers';

import { canAdminister } from '@/lib/auth/authorization';
import { sessionPrincipal } from '@/lib/auth/session-principal';
import { getServerSession } from '@/lib/auth/utils';
import type { AdminViewerTier } from '@/lib/auth/admin-tier';
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
  return canAdminister(entry.principal, null, entry.scope);
});

/**
 * The viewer tier of the admin page being rendered. Anyone the layout admitted
 * who does not administer the platform is an org viewer, and so is a request
 * with no session — the narrower view is the safe answer to a question that
 * could not be asked.
 */
export async function adminPageViewerTier(): Promise<AdminViewerTier> {
  return (await requestAdministersPlatform()) ? 'platform' : 'org';
}

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
