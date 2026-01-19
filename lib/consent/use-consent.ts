'use client';

/**
 * Cookie Consent Hooks
 *
 * React hooks for accessing consent context.
 *
 * Phase 3.5: Landing Page & Marketing
 */

import { useContext } from 'react';
import { ConsentContext } from './consent-provider';
import type { ConsentContextValue } from './types';

/**
 * Access the full consent context
 *
 * @throws Error if used outside of ConsentProvider
 *
 * @example
 * ```tsx
 * const { consent, acceptAll, rejectOptional } = useConsent();
 *
 * if (consent.optional) {
 *   // Load analytics
 * }
 * ```
 */
export function useConsent(): ConsentContextValue {
  const context = useContext(ConsentContext);

  if (context === undefined) {
    throw new Error('useConsent must be used within a ConsentProvider');
  }

  return context;
}

/**
 * Check if optional cookies are consented
 *
 * Simple boolean check for conditional script loading.
 *
 * @returns true if user has consented to optional cookies
 *
 * @example
 * ```tsx
 * const hasOptional = useHasOptionalConsent();
 *
 * if (hasOptional) {
 *   // Initialize analytics
 * }
 * ```
 */
export function useHasOptionalConsent(): boolean {
  const { consent, hasConsented } = useConsent();
  return hasConsented && consent.optional;
}

/**
 * Check if the consent banner should be shown
 *
 * Returns true only when:
 * - The provider has been initialized (hydrated)
 * - The user has not yet made a consent choice
 *
 * @example
 * ```tsx
 * const shouldShowBanner = useShouldShowConsentBanner();
 *
 * if (shouldShowBanner) {
 *   return <CookieBanner />;
 * }
 * ```
 */
export function useShouldShowConsentBanner(): boolean {
  const { isInitialized, hasConsented } = useConsent();
  return isInitialized && !hasConsented;
}
