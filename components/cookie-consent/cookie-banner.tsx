'use client';

/**
 * Cookie Consent Banner Component
 *
 * GDPR/PECR-compliant cookie consent banner that appears at the bottom of the screen.
 * Shows only when the user hasn't made a consent choice yet.
 *
 * Features:
 * - Equal prominence for both choices (GDPR compliant)
 * - Accessible with keyboard navigation and ARIA labels
 * - Respects dark mode
 * - Delayed appearance to not interrupt initial page load
 *
 * Phase 3.5: Landing Page & Marketing
 */

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { useConsent, useShouldShowConsentBanner, BANNER_DELAY_MS } from '@/lib/consent';
import { PreferencesModal } from './preferences-modal';

export function CookieBanner() {
  const { acceptAll, rejectOptional, isPreferencesOpen, openPreferences, closePreferences } =
    useConsent();
  const shouldShow = useShouldShowConsentBanner();
  const [delayPassed, setDelayPassed] = useState(false);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  // Start delay timer when banner should show
  useEffect(() => {
    if (shouldShow && !delayPassed) {
      timerRef.current = setTimeout(() => {
        setDelayPassed(true);
      }, BANNER_DELAY_MS);

      return () => {
        if (timerRef.current) {
          clearTimeout(timerRef.current);
        }
      };
    }
  }, [shouldShow, delayPassed]);

  // Compute visibility: show if should show AND delay has passed
  const isVisible = shouldShow && delayPassed;

  // Don't render banner if not visible, but always render the preferences modal
  if (!isVisible) {
    return <PreferencesModal open={isPreferencesOpen} onOpenChange={closePreferences} />;
  }

  return (
    <>
      {/* Banner */}
      <div
        role="dialog"
        aria-modal="false"
        aria-label="Cookie consent"
        aria-describedby="cookie-banner-description"
        className="bg-background fixed right-0 bottom-0 left-0 z-50 border-t shadow-lg"
      >
        <div className="container mx-auto px-4 py-4 sm:py-6">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            {/* Content */}
            <div className="flex-1">
              <p id="cookie-banner-description" className="text-muted-foreground text-sm">
                We use cookies to improve your experience. Essential cookies are always active for
                security and functionality. Optional cookies help us analyze usage and improve our
                services.{' '}
                <Link
                  href="/privacy"
                  className="text-foreground underline underline-offset-4 hover:no-underline"
                >
                  Privacy Policy
                </Link>
              </p>
            </div>

            {/* Actions */}
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <Button variant="ghost" size="sm" onClick={openPreferences} className="text-sm">
                Manage Preferences
              </Button>

              {/* Equal prominence buttons (GDPR compliance) */}
              <div className="flex gap-2">
                <Button variant="outline" onClick={rejectOptional} className="flex-1 sm:flex-none">
                  Essential Only
                </Button>
                <Button variant="default" onClick={acceptAll} className="flex-1 sm:flex-none">
                  Accept All
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Preferences Modal */}
      <PreferencesModal open={isPreferencesOpen} onOpenChange={closePreferences} />
    </>
  );
}
