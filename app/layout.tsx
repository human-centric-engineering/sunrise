import type { Metadata } from 'next';
import { Suspense } from 'react';
import { headers } from 'next/headers';
import '@/app/globals.css';
import '@/app/brand-theme.css'; // fork-owned per-surface palette; must cascade after globals
import { ThemeProvider } from '@/hooks/use-theme';
import { NO_FLASH_THEME_SCRIPT } from '@/lib/theme';
import { ErrorHandlingProvider } from '@/app/error-handling-provider';
import { ConsentProvider } from '@/lib/consent';
import { CookieBanner } from '@/components/cookie-consent';
import { AnalyticsProvider } from '@/lib/analytics';
import { AnalyticsScripts, UserIdentifier, PageTracker } from '@/components/analytics';
import { SurfaceSync } from '@/components/surface-sync';
import { DEFAULT_SURFACE } from '@/lib/app/surface';
import { BRAND } from '@/lib/brand';

// Root metadata, driven entirely by the BRAND seam (#519). The `template`
// gives every page that sets only a plain string title consistent branding;
// a route group declaring its own `title.template` still wins, so there is no
// double-branding. Previously this hardcoded "- Next.js Starter" and the
// starter blurb, which every fork inherited on any un-templated page.
export const metadata: Metadata = {
  title: {
    default: BRAND.name,
    template: `%s - ${BRAND.name}`,
  },
  description: BRAND.description,
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
  const surface = headersList.get('x-surface') ?? DEFAULT_SURFACE;

  return (
    <html lang="en" data-surface={surface} suppressHydrationWarning>
      <head>
        <script
          nonce={nonce}
          suppressHydrationWarning
          dangerouslySetInnerHTML={{
            __html: NO_FLASH_THEME_SCRIPT,
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
