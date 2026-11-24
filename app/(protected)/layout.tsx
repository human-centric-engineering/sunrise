import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { AppHeader } from '@/components/layouts/app-header';
import { ProtectedNav } from '@/components/layouts/protected-nav';
import { ProtectedFooter } from '@/components/layouts/protected-footer';
import { MaintenanceWrapperWithAdminNotice } from '@/components/maintenance-wrapper';
import { BRAND } from '@/lib/brand';
import { AUTH_LANDING_ROUTE } from '@/lib/auth-landing/route';
import { requestMemberPlatformAdmin } from '@/lib/auth/admin-page-viewer';
import { MemberPlatformAdminBanner } from '@/components/layouts/member-platform-admin-banner';
import { logger } from '@/lib/logging';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('account.layout.meta');
  return {
    title: {
      // No words to translate, and `%s` must reach Next intact.
      template: `%s - ${BRAND.name}`,
      default: t('titleDefault', { brand: BRAND.name }),
    },
    description: t('description'),
  };
}

/**
 * Protected Layout
 *
 * Layout for all protected routes (dashboard, settings, profile, etc.)
 * Protected by proxy - unauthenticated users are redirected to /login
 *
 * Phase 3.2: Added navigation links
 * Phase 4.4: Added maintenance mode support
 *
 * A platform admin acting in a customer org as a member there (t-1032) is
 * shown the way back to the install org: as an org MEMBER the admin console
 * is closed to them, so this shell is the one they see.
 */
export default async function ProtectedLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // A label and a way back, so a failed read leaves it out rather than
  // taking the page down.
  const memberAdmin = await requestMemberPlatformAdmin().catch((error: unknown) => {
    logger.error('protected layout: could not read the member platform admin view', error);
    return null;
  });
  return (
    <MaintenanceWrapperWithAdminNotice>
      <div className="bg-background flex min-h-screen flex-col">
        {memberAdmin && <MemberPlatformAdminBanner view={memberAdmin} />}
        <AppHeader logoHref={AUTH_LANDING_ROUTE} navigation={<ProtectedNav />} />
        <main className="container mx-auto flex-1 px-4 py-8">{children}</main>
        <ProtectedFooter />
      </div>
    </MaintenanceWrapperWithAdminNotice>
  );
}
