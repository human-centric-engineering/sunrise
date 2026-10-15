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
