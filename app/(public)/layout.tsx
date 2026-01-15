import type { Metadata } from 'next';
import { AppHeader } from '@/components/layouts/app-header';

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
 * Layout for public pages (about, pricing, etc.)
 * Includes shared header with branding and user actions.
 */
export default function PublicLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <div className="bg-background min-h-screen">
      <AppHeader logoHref="/" />
      <main>{children}</main>
    </div>
  );
}
