import type { Metadata } from 'next';
import { AppHeader } from '@/components/layouts/app-header';
import { PublicNav } from '@/components/layouts/public-nav';

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
 */
export default function PublicLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <div className="bg-background min-h-screen">
      <AppHeader logoHref="/" navigation={<PublicNav />} />
      <main>{children}</main>
    </div>
  );
}
