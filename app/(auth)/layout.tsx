import type { Metadata } from 'next';
import { Suspense } from 'react';
import { ThemeToggle } from '@/components/theme-toggle';
import { PageTracker } from '@/components/analytics';

export const metadata: Metadata = {
  title: {
    template: '%s - Sunrise',
    default: 'Authentication - Sunrise',
  },
  description: 'Sign in or create an account',
};

/**
 * Auth Layout
 *
 * Minimal centered layout for authentication pages (login, signup, etc.)
 * No navigation or footer - just centered content on a clean background
 */
export default function AuthLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <>
      <Suspense fallback={null}>
        <PageTracker skipInitial />
      </Suspense>
      <div className="bg-background min-h-screen">
        <div className="absolute top-4 right-4">
          <ThemeToggle />
        </div>
        <div className="flex min-h-screen items-center justify-center p-4">
          <div className="w-full max-w-md">{children}</div>
        </div>
      </div>
    </>
  );
}
