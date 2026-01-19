import type { Metadata } from 'next';
import { AppHeader } from '@/components/layouts/app-header';
import { ProtectedNav } from '@/components/layouts/protected-nav';
import { ProtectedFooter } from '@/components/layouts/protected-footer';

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
 */
export default function ProtectedLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <div className="bg-background flex min-h-screen flex-col">
      <AppHeader logoHref="/dashboard" navigation={<ProtectedNav />} />
      <main className="container mx-auto flex-1 px-4 py-8">{children}</main>
      <ProtectedFooter />
    </div>
  );
}
