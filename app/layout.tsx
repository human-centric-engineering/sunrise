import type { Metadata } from 'next';
import { Suspense } from 'react';
import { headers } from 'next/headers';
import '@/app/globals.css';
import '@/app/brand-theme.css'; // fork-owned per-surface palette; must cascade after globals
import { ThemeProvider } from '@/hooks/use-theme';
import { ErrorHandlingProvider } from '@/app/error-handling-provider';
import { ConsentProvider } from '@/lib/consent';
import { CookieBanner } from '@/components/cookie-consent';
import { AnalyticsProvider } from '@/lib/analytics';
import { AnalyticsScripts, UserIdentifier, PageTracker } from '@/components/analytics';
import { SurfaceSync } from '@/components/surface-sync';
import { BRAND } from '@/lib/brand';

export const metadata: Metadata = {
  title: `${BRAND.name} - Next.js Starter`,
  description:
    'A production-ready Next.js starter template designed for rapid application development',
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const headersList = await headers();
  const nonce = headersList.get('x-nonce') ?? undefined;
  // Rendering surface, classified per-request in proxy.ts. Drives the fork-owned
  // app/brand-theme.css (empty in vanilla Sunrise). On <html> so body-portaled
  // overlays inherit it; kept current across client nav by <SurfaceSync> below.
  const surface = headersList.get('x-surface') ?? 'consumer';

  return (
    <html lang="en" data-surface={surface} suppressHydrationWarning>
      <head>
        <script
          nonce={nonce}
          suppressHydrationWarning
          dangerouslySetInnerHTML={{
            __html: `
              (function() {
                try {
                  const stored = localStorage.getItem('theme');
                  if (stored === 'light' || stored === 'dark') {
                    document.documentElement.classList.add(stored);
                  } else {
                    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
                    const theme = prefersDark ? 'dark' : 'light';
                    document.documentElement.classList.add(theme);
                    localStorage.setItem('theme', theme);
                  }
                } catch (e) {}
              })();
            `,
          }}
        />
      </head>
      <body suppressHydrationWarning>
        <SurfaceSync />
        <ErrorHandlingProvider>
          <ConsentProvider>
            <AnalyticsProvider>
              <ThemeProvider>
                {children}
                <CookieBanner />
              </ThemeProvider>
              <Suspense fallback={null}>
                <UserIdentifier />
                <PageTracker skipInitial />
              </Suspense>
              <AnalyticsScripts nonce={nonce} />
            </AnalyticsProvider>
          </ConsentProvider>
        </ErrorHandlingProvider>
      </body>
    </html>
  );
}
