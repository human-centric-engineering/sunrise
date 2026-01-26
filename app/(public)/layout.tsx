import type { Metadata } from 'next';
import { AppHeader } from '@/components/layouts/app-header';
import { PublicNav } from '@/components/layouts/public-nav';
import { PublicFooter } from '@/components/layouts/public-footer';
import { MaintenanceWrapper } from '@/components/maintenance-wrapper';
import { PageTracker } from '@/components/analytics';

export const metadata: Metadata = {
  title: {
    template: '%s - Sunrise',
    default: 'Sunrise',
  },
  description:
    'A production-ready Next.js starter template designed for rapid application development',
};

/**
 * Public Layout
 *
 * Layout for public pages (landing, about, contact, etc.)
 * Includes shared header with branding, navigation, and user actions.
 *
 * Phase 3.5: Landing Page & Marketing
 * Phase 4.4: Added maintenance mode support
 */
export default function PublicLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <MaintenanceWrapper>
      <PageTracker />
      <div className="bg-background flex min-h-screen flex-col">
        <AppHeader logoHref="/" navigation={<PublicNav />} />
        <main className="flex-1">{children}</main>
        <PublicFooter />
      </div>
    </MaintenanceWrapper>
  );
}
