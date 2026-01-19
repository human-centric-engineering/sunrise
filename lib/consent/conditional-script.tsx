'use client';

/**
 * Conditional Script Loader
 *
 * Component for conditionally loading scripts based on cookie consent.
 * Only renders children when the user has consented to optional cookies.
 *
 * @example
 * ```tsx
 * import { ConditionalScript } from '@/lib/consent';
 * import Script from 'next/script';
 *
 * // Load Google Analytics only with consent
 * <ConditionalScript>
 *   <Script
 *     src="https://www.googletagmanager.com/gtag/js?id=GA_MEASUREMENT_ID"
 *     strategy="afterInteractive"
 *   />
 * </ConditionalScript>
 *
 * // Execute code only with consent
 * <ConditionalScript>
 *   {() => {
 *     // Initialize analytics
 *     window.gtag('config', 'GA_MEASUREMENT_ID');
 *   }}
 * </ConditionalScript>
 * ```
 *
 * Phase 3.5: Landing Page & Marketing
 */

import { useEffect } from 'react';
import { useHasOptionalConsent } from './use-consent';

interface ConditionalScriptProps {
  /**
   * Children to render when consent is given.
   * Can be React nodes (like Script components) or a function to execute.
   */
  children: React.ReactNode | (() => void);
  /**
   * Callback when consent status changes.
   * Useful for cleanup when consent is revoked.
   */
  onConsentChange?: (hasConsent: boolean) => void;
}

/**
 * ConditionalScript component
 *
 * Renders children only when the user has consented to optional cookies.
 * Use this to wrap analytics scripts, marketing pixels, or any third-party
 * scripts that require consent.
 */
export function ConditionalScript({ children, onConsentChange }: ConditionalScriptProps) {
  const hasConsent = useHasOptionalConsent();

  // Call onConsentChange callback when consent status changes
  useEffect(() => {
    onConsentChange?.(hasConsent);
  }, [hasConsent, onConsentChange]);

  // Execute function children when consent is granted
  useEffect(() => {
    if (hasConsent && typeof children === 'function') {
      children();
    }
  }, [hasConsent, children]);

  // Don't render if no consent
  if (!hasConsent) {
    return null;
  }

  // If children is a function, it was already executed in useEffect
  if (typeof children === 'function') {
    return null;
  }

  // Render React node children
  return <>{children}</>;
}

/**
 * Hook to check if optional scripts should load
 *
 * For more complex conditional loading logic, use this hook directly.
 *
 * @example
 * ```tsx
 * const shouldLoadAnalytics = useShouldLoadOptionalScripts();
 *
 * useEffect(() => {
 *   if (shouldLoadAnalytics) {
 *     // Initialize complex analytics setup
 *   }
 * }, [shouldLoadAnalytics]);
 * ```
 */
export function useShouldLoadOptionalScripts(): boolean {
  return useHasOptionalConsent();
}
