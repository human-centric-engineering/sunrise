'use client';

/**
 * Analytics Hooks
 *
 * React hooks for accessing analytics context and automatic page tracking.
 *
 * Phase 4.5: Analytics Integration
 *
 * @see .context/analytics/overview.md for architecture documentation
 */

import { useContext, useEffect, useRef } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { AnalyticsContext } from './analytics-provider';
import type { AnalyticsContextValue, PageProperties } from './types';

/**
 * Access the analytics context
 *
 * Provides methods to track events, page views, and user identification.
 * All methods respect user consent - they are no-ops when consent is not given.
 *
 * @throws Error if used outside of AnalyticsProvider
 *
 * @example
 * ```tsx
 * const { track, identify, page, isReady } = useAnalytics();
 *
 * // Track a custom event
 * track('button_clicked', { buttonId: 'signup', location: 'hero' });
 *
 * // Identify a user after login
 * identify(user.id, { email: user.email, plan: user.plan });
 *
 * // Track a page view manually
 * page('Dashboard', { section: 'overview' });
 * ```
 */
export function useAnalytics(): AnalyticsContextValue {
  const context = useContext(AnalyticsContext);

  if (context === undefined) {
    throw new Error('useAnalytics must be used within an AnalyticsProvider');
  }

  return context;
}

/**
 * Check if analytics is ready
 *
 * Returns true when analytics is initialized and consent is given.
 *
 * @example
 * ```tsx
 * const isReady = useAnalyticsReady();
 * if (isReady) {
 *   // Analytics is available
 * }
 * ```
 */
export function useAnalyticsReady(): boolean {
  const { isReady } = useAnalytics();
  return isReady;
}

/**
 * Check if analytics is enabled
 *
 * Returns true when user has given consent for analytics.
 * Analytics may still be initializing - use useAnalyticsReady for full check.
 *
 * @example
 * ```tsx
 * const isEnabled = useAnalyticsEnabled();
 * if (isEnabled) {
 *   // User has consented to analytics
 * }
 * ```
 */
export function useAnalyticsEnabled(): boolean {
  const { isEnabled } = useAnalytics();
  return isEnabled;
}

/**
 * Hook options for page tracking
 */
interface UsePageTrackingOptions {
  /** Additional properties to include with page views */
  properties?: PageProperties;
  /** Skip initial page track on mount (useful when manually tracking) */
  skipInitial?: boolean;
}

/**
 * Automatic page view tracking on route changes
 *
 * Call this hook in a layout component to automatically track page views
 * whenever the route changes. Only tracks when analytics is ready and
 * consent is given.
 *
 * @param options - Optional configuration
 *
 * @example
 * ```tsx
 * // In a layout component
 * export function DashboardLayout({ children }) {
 *   usePageTracking();
 *   return <>{children}</>;
 * }
 *
 * // With custom properties
 * usePageTracking({
 *   properties: { section: 'dashboard' }
 * });
 *
 * // Skip initial page track
 * usePageTracking({ skipInitial: true });
 * ```
 */
export function usePageTracking(options: UsePageTrackingOptions = {}): void {
  const { properties, skipInitial = false } = options;
  const { page, isReady } = useAnalytics();

  // Get current route information
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Track whether we've done the initial page track
  const hasTrackedInitial = useRef(false);
  // Track the last pathname to detect real changes
  const lastPathname = useRef<string | null>(null);

  useEffect(() => {
    if (!isReady) {
      return;
    }

    // Skip initial if requested
    if (skipInitial && !hasTrackedInitial.current) {
      hasTrackedInitial.current = true;
      lastPathname.current = pathname;
      return;
    }

    // Skip if pathname hasn't changed (prevents double tracking)
    if (pathname === lastPathname.current && hasTrackedInitial.current) {
      return;
    }

    lastPathname.current = pathname;
    hasTrackedInitial.current = true;

    // Build page properties
    const pageProperties: PageProperties = {
      path: pathname,
      url: typeof window !== 'undefined' ? window.location.href : undefined,
      search: searchParams?.toString() || undefined,
      referrer: typeof document !== 'undefined' ? document.referrer : undefined,
      ...properties,
    };

    // Track page view
    page(undefined, pageProperties).catch(() => {
      // Silently ignore errors - they're already logged in the provider
    });
  }, [pathname, searchParams, isReady, page, properties, skipInitial]);
}

/**
 * Track an event with a simple API
 *
 * Returns a stable function that tracks an event when called.
 * Useful for click handlers and other event-driven tracking.
 *
 * @param eventName - Name of the event to track
 * @returns Function that tracks the event with optional properties
 *
 * @example
 * ```tsx
 * const trackClick = useTrackEvent('button_clicked');
 *
 * <button onClick={() => trackClick({ buttonId: 'signup' })}>
 *   Sign Up
 * </button>
 * ```
 */
export function useTrackEvent(eventName: string): (properties?: Record<string, unknown>) => void {
  const { track } = useAnalytics();

  return (properties?: Record<string, unknown>) => {
    track(eventName, properties).catch(() => {
      // Silently ignore errors
    });
  };
}
