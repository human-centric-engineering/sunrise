'use client';

/**
 * User Identifier Component
 *
 * Automatically identifies authenticated users to the analytics system and
 * tracks the initial page view. This ensures:
 * 1. Users are identified on page load (including after OAuth or refresh)
 * 2. The initial page view includes the correct user ID
 *
 * Place this in the root layout alongside AnalyticsProvider and PageTracker.
 * PageTracker handles subsequent navigation (with skipInitial={true}).
 *
 * Phase 4.5: Analytics Integration
 *
 * @example
 * ```tsx
 * <AnalyticsProvider>
 *   <Suspense fallback={null}>
 *     <UserIdentifier />
 *     <PageTracker skipInitial />
 *   </Suspense>
 *   {children}
 * </AnalyticsProvider>
 * ```
 */

import { useEffect, useRef } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { useSession } from '@/lib/auth/client';
import { useAnalytics } from '@/lib/analytics';

export function UserIdentifier() {
  const { data: session, isPending: isSessionPending } = useSession();
  const { identify, page, isReady } = useAnalytics();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const hasTrackedInitialRef = useRef(false);
  const identifiedUserRef = useRef<string | null>(null);

  // Handle initial page load: identify user (if logged in), then track page
  useEffect(() => {
    // Wait for analytics to be ready and session to finish loading
    if (!isReady || isSessionPending) {
      return;
    }

    // Only run once per page load
    if (hasTrackedInitialRef.current) {
      return;
    }

    const initialize = async () => {
      hasTrackedInitialRef.current = true;

      // If user is logged in, identify them first
      if (session?.user?.id && identifiedUserRef.current !== session.user.id) {
        await identify(session.user.id);
        identifiedUserRef.current = session.user.id;
      }

      // Then track the initial page view (with correct userId if logged in)
      await page(undefined, {
        path: pathname,
        url: typeof window !== 'undefined' ? window.location.href : undefined,
        search: searchParams?.toString() || undefined,
        referrer: typeof document !== 'undefined' ? document.referrer : undefined,
      });
    };

    void initialize();
  }, [isReady, isSessionPending, session?.user?.id, identify, page, pathname, searchParams]);

  // Reset identification tracking when user logs out
  useEffect(() => {
    if (!session?.user?.id && identifiedUserRef.current) {
      identifiedUserRef.current = null;
    }
  }, [session?.user?.id]);

  return null;
}
