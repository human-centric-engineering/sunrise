import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { AppHeader } from '@/components/layouts/app-header';
import { ProtectedNav } from '@/components/layouts/protected-nav';
import { ProtectedFooter } from '@/components/layouts/protected-footer';
import { MaintenanceWrapperWithAdminNotice } from '@/components/maintenance-wrapper';
import { BRAND } from '@/lib/brand';
import { AUTH_LANDING_ROUTE } from '@/lib/auth-landing/route';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('account.layout.meta');
  return {
    title: {
      template: t('titleTemplate', { brand: BRAND.name }),
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
 */
export default function ProtectedLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <MaintenanceWrapperWithAdminNotice>
      <div className="bg-background flex min-h-screen flex-col">
        <AppHeader logoHref={AUTH_LANDING_ROUTE} navigation={<ProtectedNav />} />
        <main className="container mx-auto flex-1 px-4 py-8">{children}</main>
        <ProtectedFooter />
      </div>
    </MaintenanceWrapperWithAdminNotice>
  );
}
