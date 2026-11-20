'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { useConsent } from '@/lib/consent';
import { BRAND } from '@/lib/brand';
import { resolveFooterCopyright } from '@/lib/footer/copyright';
import { footerNavItems, footerLegalItems } from '@/lib/app/public-nav';
import { DEFAULT_FOOTER_NAV, DEFAULT_FOOTER_LEGAL } from '@/lib/public-nav/types';
import { defaultNavLabelKey } from '@/components/layouts/default-nav-label';

/**
 * Public Footer Component
 *
 * Footer for public/marketing pages.
 * Includes navigation links, legal links, and the attribution line
 * (fork-overridable via `lib/app/footer.ts`).
 *
 * Phase 3.5: Landing Page & Marketing
 */

// Fork overrides (non-null arrays) replace the platform defaults wholesale.
const navigationLinks = footerNavItems ?? DEFAULT_FOOTER_NAV;
const legalLinks = footerLegalItems ?? DEFAULT_FOOTER_LEGAL;
// Only the platform's own labels come from the catalogue; a fork's are its text.
const isDefaultNavigation = footerNavItems == null;
const isDefaultLegal = footerLegalItems == null;

interface PublicFooterProps {
  /**
   * The visitor's language switch, built by the public layout (which knows
   * the languages and whether anyone is signed in). Omitted, nothing renders.
   */
  languageSwitch?: ReactNode;
}

export function PublicFooter({ languageSwitch }: PublicFooterProps = {}) {
  const t = useTranslations('layout');
  const labelFor = (href: string, label: string, isDefault: boolean): string => {
    const key = isDefault ? defaultNavLabelKey(href) : null;
    return key ? t(`nav.${key}`) : label;
  };
  const currentYear = new Date().getFullYear();
  const { openPreferences } = useConsent();
  const copyright = resolveFooterCopyright(currentYear, BRAND.legalName);

  return (
    <footer className="border-t">
      <div className="container mx-auto px-4 py-8">
        <div className="flex flex-col items-center gap-6 sm:flex-row sm:justify-between">
          {/* Navigation Links */}
          <nav className="flex flex-wrap justify-center gap-x-6 gap-y-2">
            {navigationLinks.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="text-muted-foreground hover:text-foreground text-sm transition-colors"
              >
                {labelFor(link.href, link.label, isDefaultNavigation)}
              </Link>
            ))}
          </nav>

          {/* Legal Links — the override governs links; the Cookie Preferences
              control below is always rendered by the platform (consent is a
              legal requirement in many jurisdictions, not fork-overridable). */}
          <nav className="flex flex-wrap justify-center gap-x-6 gap-y-2">
            {legalLinks.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="text-muted-foreground hover:text-foreground text-sm transition-colors"
              >
                {labelFor(link.href, link.label, isDefaultLegal)}
              </Link>
            ))}
            <button
              onClick={openPreferences}
              className="text-muted-foreground hover:text-foreground text-sm transition-colors"
            >
              {t('footer.cookiePreferences')}
            </button>
          </nav>

          {languageSwitch}

          {/* Attribution — last in the DOM, and last visually in both layouts
              (#561). It used to sit on a dedicated centred row below, costing
              ~44px: free on a scrolling marketing page, expensive on the
              no-login app surfaces forks host in this group. Inline also
              matches ProtectedFooter, which never had a separate row.

              Placed last rather than first with `order-last`: CSS `order`
              changes only the visual order, never the DOM or the accessibility
              tree, so ordering it visually while leaving it first in the source
              would put the reading order and the visual order in disagreement
              (WCAG 1.3.2). Source order is the honest way to say "last". */}
          {copyright && <p className="text-muted-foreground text-sm">{copyright}</p>}
        </div>
      </div>
    </footer>
  );
}
