'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useConsent } from '@/lib/consent';
import { BRAND } from '@/lib/brand';
import { resolveFooterCopyright } from '@/lib/footer/copyright';

/**
 * Protected Footer Component
 *
 * Minimal footer for authenticated app pages.
 * Includes help link and copyright.
 *
 * Phase 3.5: Landing Page & Marketing
 */
export function ProtectedFooter() {
  const t = useTranslations('layout.footer');
  const currentYear = new Date().getFullYear();
  const { openPreferences } = useConsent();
  const copyright = resolveFooterCopyright(currentYear, BRAND.legalName);

  return (
    <footer className="border-t">
      <div className="container mx-auto px-4 py-4">
        <div className="text-muted-foreground flex flex-col items-center justify-between gap-2 text-sm sm:flex-row">
          {/* `<p>` renders only when the seam yields a line, so `false` collapses
              the row to its remaining controls rather than leaving a gap. */}
          {copyright && <p>{copyright}</p>}
          <div className="flex items-center gap-4">
            <button onClick={openPreferences} className="hover:text-foreground transition-colors">
              {t('cookiePreferences')}
            </button>
            <Link href="/contact" className="hover:text-foreground transition-colors">
              {t('helpSupport')}
            </Link>
          </div>
        </div>
      </div>
    </footer>
  );
}
