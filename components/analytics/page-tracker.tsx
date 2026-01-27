'use client';

/**
 * Page Tracker Component
 *
 * A client component that tracks page views on route changes.
 * Place this ONCE in the root layout alongside UserIdentifier.
 *
 * Use with skipInitial={true} when UserIdentifier handles the initial page view.
 * This ensures proper ordering: identify → page on initial load.
 *
 * The root layout never remounts during client-side navigation, so this
 * component reliably catches all subsequent route changes via usePathname().
 *
 * Phase 4.5: Analytics Integration
 *
 * @example
 * ```tsx
 * // In root layout (app/layout.tsx)
 * <AnalyticsProvider>
 *   <Suspense fallback={null}>
 *     <UserIdentifier />
 *     <PageTracker skipInitial />
 *   </Suspense>
 *   {children}
 * </AnalyticsProvider>
 * ```
 */

import { usePageTracking } from '@/lib/analytics';

interface PageTrackerProps {
  /** Additional properties to include with every page view */
  properties?: Record<string, string | number | boolean>;
  /** Skip tracking the initial page load (handled by UserIdentifier) */
  skipInitial?: boolean;
}

export function PageTracker({ properties, skipInitial }: PageTrackerProps) {
  usePageTracking({ properties, skipInitial });
  return null;
}
