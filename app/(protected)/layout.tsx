import type { Metadata } from 'next';
import { AppHeader } from '@/components/layouts/app-header';
import { ProtectedNav } from '@/components/layouts/protected-nav';

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
    <div className="bg-background min-h-screen">
      <AppHeader logoHref="/dashboard" navigation={<ProtectedNav />} />
      <main className="container mx-auto px-4 py-8">{children}</main>
    </div>
  );
}
