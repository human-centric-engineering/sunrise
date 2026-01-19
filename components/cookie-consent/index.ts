/**
 * Cookie Consent Components
 *
 * GDPR/PECR-compliant cookie consent UI components.
 *
 * @example
 * ```tsx
 * import { CookieBanner, PreferencesModal } from '@/components/cookie-consent';
 *
 * // Banner appears automatically when needed
 * <CookieBanner />
 *
 * // Modal can be triggered from footer
 * <PreferencesModal open={isOpen} onOpenChange={setIsOpen} />
 * ```
 *
 * Phase 3.5: Landing Page & Marketing
 */

export { CookieBanner } from './cookie-banner';
export { PreferencesModal } from './preferences-modal';
