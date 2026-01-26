'use client';

/**
 * Page Tracker Component
 *
 * A client component that tracks page views automatically.
 * Add this to layout components to enable automatic page tracking.
 *
 * Phase 4.5: Analytics Integration
 *
 * @example
 * ```tsx
 * // In a server component layout
 * import { PageTracker } from '@/components/analytics';
 *
 * export default function Layout({ children }) {
 *   return (
 *     <>
 *       <PageTracker />
 *       {children}
 *     </>
 *   );
 * }
 * ```
 */

import { usePageTracking } from '@/lib/analytics';

interface PageTrackerProps {
  /** Additional properties to include with every page view */
  properties?: Record<string, string | number | boolean>;
  /** Skip tracking the initial page load */
  skipInitial?: boolean;
}

export function PageTracker({ properties, skipInitial }: PageTrackerProps) {
  usePageTracking({ properties, skipInitial });
  return null;
}
