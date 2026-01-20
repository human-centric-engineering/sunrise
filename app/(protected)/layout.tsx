import type { Metadata } from 'next';
import { AppHeader } from '@/components/layouts/app-header';
import { ProtectedNav } from '@/components/layouts/protected-nav';
import { ProtectedFooter } from '@/components/layouts/protected-footer';
import { MaintenanceWrapperWithAdminNotice } from '@/components/maintenance-wrapper';

export const metadata: Metadata = {
  title: {
    template: '%s - Sunrise',
    default: 'Dashboard - Sunrise',
  },
  description: 'Your dashboard',
};

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
        <AppHeader logoHref="/dashboard" navigation={<ProtectedNav />} />
        <main className="container mx-auto flex-1 px-4 py-8">{children}</main>
        <ProtectedFooter />
      </div>
    </MaintenanceWrapperWithAdminNotice>
  );
}
