/**
 * Cookie Consent Module
 *
 * GDPR/PECR-compliant cookie consent system for Sunrise.
 *
 * @example
 * ```tsx
 * // In app layout
 * import { ConsentProvider } from '@/lib/consent';
 *
 * <ConsentProvider>
 *   {children}
 * </ConsentProvider>
 *
 * // In components
 * import { useConsent, useHasOptionalConsent } from '@/lib/consent';
 *
 * const { consent, acceptAll } = useConsent();
 * const hasOptional = useHasOptionalConsent();
 * ```
 *
 * Phase 3.5: Landing Page & Marketing
 */

export { ConsentProvider, ConsentContext } from '@/lib/consent/consent-provider';
export {
  useConsent,
  useHasOptionalConsent,
  useShouldShowConsentBanner,
} from '@/lib/consent/use-consent';
export { ConditionalScript, useShouldLoadOptionalScripts } from '@/lib/consent/conditional-script';
export { isConsentEnabled, COOKIE_CATEGORIES, BANNER_DELAY_MS } from '@/lib/consent/config';
export type { ConsentState, ConsentContextValue, CookieCategory } from './types';
