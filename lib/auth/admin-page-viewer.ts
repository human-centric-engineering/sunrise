/**
 * Who is viewing this admin page: the platform, or an org admin? (§111 t-812)
 *
 * The admin layout admits two kinds of viewer: a platform admin to any page,
 * and an org OWNER/ADMIN of the entered org to an org-tier page. Most org-tier
 * pages serve both the same, because row isolation already bounds what their
 * API calls read to the entered org. The mixed pages do not — the
 * orchestration dashboard, costs, analytics, executions and the MCP landing
 * each pair the org's figures with a platform-ops panel — so they ask this,
 * and render the platform-ops half for a platform viewer only. The API routes
 * behind that half refuse an org admin regardless; this decides what the
 * page shows, not what it may read.
 *
 * {@link viewerAdministersPlatform} asks the layout's platform question
 * (`adminViewerTier` in `app/admin/layout.tsx`) the way the layout asks it —
 * the same principal, scope and policy call — so a page and the layout agree
 * about who is the platform.
 *
 * @see lib/auth/admin-viewer.ts — the same question, asked inside an org-tier API route
 */
import { headers } from 'next/headers';

import { canAdminister } from '@/lib/auth/authorization';
import { sessionPrincipal, type SessionLike } from '@/lib/auth/session-principal';
import { getServerSession } from '@/lib/auth/utils';
import type { AdminViewerTier } from '@/lib/auth/admin-tier';
import { TENANT_HEADER_NAME } from '@/lib/tenancy/resolver';

/**
 * Does this session administer the platform, in the org it entered? The
 * policy asked with no resource and no tier — the question every
 * platform-only surface asks.
 */
export async function viewerAdministersPlatform(
  session: SessionLike,
  headerOrgId: string | null
): Promise<boolean> {
  const { principal, scope } = await sessionPrincipal(session, headerOrgId);
  return canAdminister(principal, null, scope);
}

/**
 * The viewer tier of the admin page being rendered. Anyone the layout admitted
 * who does not administer the platform is an org viewer, and so is a request
 * with no session — the narrower view is the safe answer to a question that
 * could not be asked.
 */
export async function adminPageViewerTier(): Promise<AdminViewerTier> {
  const session = await getServerSession();
  if (!session) return 'org';
  const requestHeaders = await headers();
  const platform = await viewerAdministersPlatform(
    session,
    requestHeaders.get(TENANT_HEADER_NAME) || null
  );
  return platform ? 'platform' : 'org';
}
