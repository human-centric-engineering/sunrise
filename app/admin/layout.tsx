import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { getServerSession } from '@/lib/auth/utils';
import { AdminSidebar } from '@/components/admin/admin-sidebar';
import { AdminHeader } from '@/components/admin/admin-header';
import { InFlightExecutionBanner } from '@/components/admin/orchestration/in-flight-execution-banner';
import { BRAND } from '@/lib/brand';
import { AUTH_LANDING_ROUTE } from '@/lib/auth-landing/route';
import { canAdminister } from '@/lib/auth/authorization';
import {
  requestActingOrg,
  requestAdministersPlatform,
  requestPrincipal,
  requestSupportSession,
} from '@/lib/auth/admin-page-viewer';
import { SupportBanner } from '@/components/admin/support-banner';
import { isMultiTenant } from '@/lib/tenancy/context';
import { logger } from '@/lib/logging';
import {
  ADMIN_PATHNAME_HEADER,
  adminPageTier,
  type AdminTier,
  type AdminViewerTier,
} from '@/lib/auth/admin-tier';
import { orgScopedAdminPages, orgTierAdminPages } from '@/lib/auth/org-tier-admin-pages';
import { AdminTierGate } from '@/components/admin/admin-tier-gate';
import { getSharedSettingsAccess } from '@/lib/tenancy/shared-settings-access';
import { SharedSettingsAccessProvider } from '@/components/admin/shared-settings-access';

export const metadata: Metadata = {
  title: {
    template: `%s - Admin - ${BRAND.name}`,
    default: `Admin - ${BRAND.name}`,
  },
  description: `Admin dashboard for ${BRAND.name}`,
};

/**
 * Who this session is to the admin console on this page: `'platform'` (every
 * surface), `'org'` (the org-tier ones), or `null` (none of this one).
 *
 * The principal is the one the guards build, from the same org entry
 * (`sessionPrincipal`, via `requestPrincipal`), and the platform question is
 * the one the mixed pages ask (`lib/auth/admin-page-viewer.ts`), so a policy
 * that reads `viewer.orgRole` answers the layout as it answers the routes for
 * every admitted caller. One difference
 * is deliberate: where a guard refuses a session whose org entry is refused,
 * this asks with no org facts, so a platform admin still reaches the console
 * to switch org — see `lib/auth/session-principal.ts`.
 */
async function adminViewerTier(pageTier: AdminTier | null): Promise<AdminViewerTier | null> {
  if (await requestAdministersPlatform()) return 'platform';
  const entry = await requestPrincipal();
  if (
    pageTier === 'org' &&
    entry &&
    (await canAdminister(entry.principal, null, { ...entry.scope, tier: 'org' }))
  ) {
    return 'org';
  }
  return null;
}

/**
 * Admin Layout (Phase 4.4)
 *
 * Layout for all admin routes.
 * Admits whoever the authorization policy says may use the page: a platform
 * admin anywhere, an org OWNER/ADMIN on an org-tier page (§111 t-810).
 * Everyone else is redirected to the landing route; unauthenticated users to
 * login.
 */
export default async function AdminLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const session = await getServerSession();

  // Redirect to login if not authenticated
  if (!session) {
    redirect('/login');
  }

  // Shared settings are read-only outside the install org at `multi` (§107
  // t-753); every page below asks the provider rather than working it out.
  // Started now so its one membership read runs alongside the policy's
  // instead of after it. It never throws.
  const sharedSettingsRead = getSharedSettingsAccess(session);

  // Redirect to the landing route if the authorization policy says this
  // principal may not use this page. The third of the places Sunrise asks the
  // question — the guards cover the API, this covers the admin tree's own
  // shell. A cookie session is the only way to reach a layout, so the
  // credential is not in doubt here.
  //
  // Asked once for the platform tier and, for whoever that refuses, once for
  // the org tier (§111 t-810): an org OWNER/ADMIN may open a page listed in
  // `ORG_TIER_ADMIN_PAGES` or by the fork (t-817), and no other, less any core
  // section the fork closed (t-929). The page comes from the proxy's
  // header, because a layout is not handed a pathname; no header is no page,
  // and no page is the platform's. This runs on a full load only — Next.js
  // does not re-render a layout on in-app navigation — so `AdminTierGate`
  // below re-checks each navigation for the reader, and every API route the
  // page calls checks for itself. The gate and the sidebar judge by the list
  // this read built, handed down, so the browser never builds its own.
  const requestHeaders = await headers();
  const orgTierPages = orgTierAdminPages();
  const viewerTier = await adminViewerTier(
    adminPageTier(requestHeaders.get(ADMIN_PATHNAME_HEADER), orgTierPages)
  );
  if (!viewerTier) {
    redirect(AUTH_LANDING_ROUTE);
  }

  // At `multi` every org-tier page is one org's, so the header names it
  // (§111 t-813). At `single` there is only the install org, and the header is
  // as it was. Started alongside the shared-settings read.
  const multiTenant = isMultiTenant();
  // The name is a label, so a failed lookup leaves it out rather than taking
  // the console down with it.
  const actingOrgRead = multiTenant
    ? requestActingOrg().catch((error: unknown) => {
        logger.error('admin layout: could not read the acting org', error);
        return null;
      })
    : Promise.resolve(null);
  // A support session (§121 t-824) is named across the whole console, and
  // so is one whose grant has just ended — the next request is refused, and
  // this says why and offers the way back. Like the org name, a failed read
  // leaves the banner out rather than taking the console down.
  const supportRead = multiTenant
    ? requestSupportSession().catch((error: unknown) => {
        logger.error('admin layout: could not read the support session', error);
        return null;
      })
    : Promise.resolve(null);
  const [sharedSettings, actingOrg, supportSession] = await Promise.all([
    sharedSettingsRead,
    actingOrgRead,
    supportRead,
  ]);

  return (
    <div className="bg-background flex h-screen overflow-hidden">
      <AdminSidebar viewerTier={viewerTier} multiTenant={multiTenant} orgTierPages={orgTierPages} />
      <div className="flex flex-1 flex-col overflow-hidden">
        {supportSession && <SupportBanner view={supportSession} />}
        {/* Every page of one org's rows, closed sections included: a platform
            admin there is still looking at the entered org's. */}
        <AdminHeader orgName={actingOrg?.name} orgTierPages={orgScopedAdminPages()} />
        <InFlightExecutionBanner />
        <main className="flex-1 overflow-y-auto overscroll-contain">
          <div className="p-6">
            <SharedSettingsAccessProvider
              readOnly={sharedSettings.readOnly}
              canSwitch={sharedSettings.canSwitch}
              installOrgMember={sharedSettings.installOrgMember}
              isInstallOrg={sharedSettings.isInstallOrg}
            >
              <AdminTierGate viewerTier={viewerTier} orgTierPages={orgTierPages}>
                {children}
              </AdminTierGate>
            </SharedSettingsAccessProvider>
          </div>
        </main>
      </div>
    </div>
  );
}
