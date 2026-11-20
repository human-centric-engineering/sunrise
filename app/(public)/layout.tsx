import type { Metadata } from 'next';
import { getLocale } from 'next-intl/server';
import { AppHeader } from '@/components/layouts/app-header';
import { PublicNav } from '@/components/layouts/public-nav';
import { PublicFooter } from '@/components/layouts/public-footer';
import { MaintenanceWrapper } from '@/components/maintenance-wrapper';
import { LanguageSwitch } from '@/components/layouts/language-switch';
import { BRAND } from '@/lib/brand';
import { localeOptions } from '@/lib/i18n/locale-options';
import { requestPrincipal } from '@/lib/auth/admin-page-viewer';
import { logger } from '@/lib/logging';

export const metadata: Metadata = {
  title: {
    template: `%s - ${BRAND.name}`,
    default: BRAND.name,
  },
  // Was the starter blurb, hardcoded — which every fork shipped as the meta
  // description across its whole marketing surface. The root layout's
  // `BRAND.description` does NOT reach here: Next resolves metadata at the
  // nearest segment that defines a field, so a group declaring `description`
  // overrides the root outright. That is why #519's root-only fix was not
  // enough on its own.
  description: BRAND.description,
};

/**
 * Is anyone signed in on this request? The principal is cached per request and
 * the locale resolution has already read it, so asking costs nothing more. A
 * failed read answers "no": the switch then shows, and for a signed-in user it
 * only sets a cookie their own choice outranks.
 */
async function isSignedIn(): Promise<boolean> {
  try {
    return (await requestPrincipal()) !== null;
  } catch (error) {
    logger.warn('Public layout could not read the session; showing the language switch', {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Public Layout
 *
 * Layout for public pages (landing, about, contact, etc.)
 * Includes shared header with branding, navigation, and user actions.
 *
 * Phase 3.5: Landing Page & Marketing
 * Phase 4.4: Added maintenance mode support
 *
 * The footer carries a visitor's language switch (§138 t-1073) when there is
 * more than one language and nobody is signed in: a signed-in user's own
 * choice outranks the visitor cookie the switch sets, so they pick in their
 * settings instead.
 */
export default async function PublicLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const options = localeOptions();
  const showLanguageSwitch = options.length > 1 && !(await isSignedIn());
  const languageSwitch = showLanguageSwitch ? (
    <LanguageSwitch options={options} current={await getLocale()} />
  ) : null;

  return (
    <MaintenanceWrapper>
      <div className="bg-background flex min-h-screen flex-col">
        <AppHeader logoHref="/" navigation={<PublicNav />} />
        <main className="flex-1">{children}</main>
        <PublicFooter languageSwitch={languageSwitch} />
      </div>
    </MaintenanceWrapper>
  );
}
