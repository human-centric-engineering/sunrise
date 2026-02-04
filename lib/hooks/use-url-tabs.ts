'use client';

/**
 * useUrlTabs Hook
 *
 * A reusable hook that syncs tab state with URL query parameters.
 * Provides SPA-like navigation without full page reloads.
 *
 * @example
 * ```tsx
 * const { activeTab, setActiveTab } = useUrlTabs({
 *   defaultTab: 'profile',
 *   allowedTabs: ['profile', 'security', 'notifications'],
 *   titles: {
 *     profile: 'Settings - Profile - MyApp',
 *     security: 'Settings - Security - MyApp',
 *     notifications: 'Settings - Notifications - MyApp',
 *   },
 * });
 *
 * <Tabs value={activeTab} onValueChange={setActiveTab}>
 *   ...
 * </Tabs>
 * ```
 */

import { useCallback, useEffect, useMemo } from 'react';
import { useSearchParams, useRouter, usePathname } from 'next/navigation';

export interface UseUrlTabsOptions<T extends string = string> {
  /** Query parameter name (default: 'tab') */
  paramName?: string;
  /** Default tab when URL param is missing or invalid */
  defaultTab: T;
  /** Valid tab values for validation */
  allowedTabs: readonly T[];
  /** Optional map of tab values to page titles (updates document.title) */
  titles?: Partial<Record<T, string>>;
}

export interface UseUrlTabsReturn<T extends string = string> {
  /** Currently active tab */
  activeTab: T;
  /** Set the active tab (updates URL) */
  setActiveTab: (tab: T) => void;
  /** Check if a specific tab is active */
  isActive: (tab: T) => boolean;
}

/**
 * Hook for URL-synced tab navigation
 *
 * Features:
 * - Reads initial tab from URL query params
 * - Updates URL when tab changes (SPA behavior)
 * - Validates against allowed tab values
 * - Falls back to default tab for invalid values
 * - Uses router.replace for no history pollution on invalid URLs
 */
export function useUrlTabs<T extends string = string>({
  paramName = 'tab',
  defaultTab,
  allowedTabs,
  titles,
}: UseUrlTabsOptions<T>): UseUrlTabsReturn<T> {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  // Get current tab from URL, validate against allowed values
  const activeTab = useMemo(() => {
    const urlTab = searchParams.get(paramName);

    if (urlTab && allowedTabs.includes(urlTab as T)) {
      return urlTab as T;
    }

    return defaultTab;
  }, [searchParams, paramName, allowedTabs, defaultTab]);

  // Clean up invalid tab values from URL
  useEffect(() => {
    const urlTab = searchParams.get(paramName);

    // If there's a tab param but it's invalid, clean it up
    if (urlTab && !allowedTabs.includes(urlTab as T)) {
      const params = new URLSearchParams(searchParams.toString());
      params.delete(paramName);

      const cleanUrl = params.toString() ? `${pathname}?${params.toString()}` : pathname;
      router.replace(cleanUrl, { scroll: false });
    }
  }, [searchParams, paramName, allowedTabs, pathname, router]);

  // Update document title when tab changes
  useEffect(() => {
    if (titles && titles[activeTab]) {
      document.title = titles[activeTab];
    }
  }, [activeTab, titles]);

  // Update URL when tab changes
  const setActiveTab = useCallback(
    (tab: T) => {
      // Validate the tab value
      if (!allowedTabs.includes(tab)) {
        return;
      }

      // Build new URL with updated tab parameter
      const params = new URLSearchParams(searchParams.toString());

      if (tab === defaultTab) {
        // Remove param if it's the default (cleaner URLs)
        params.delete(paramName);
      } else {
        params.set(paramName, tab);
      }

      const newUrl = params.toString() ? `${pathname}?${params.toString()}` : pathname;

      // Use replace to avoid polluting browser history for tab switches
      router.replace(newUrl, { scroll: false });
    },
    [searchParams, pathname, router, paramName, defaultTab, allowedTabs]
  );

  // Helper to check if a tab is active
  const isActive = useCallback((tab: T) => activeTab === tab, [activeTab]);

  return {
    activeTab,
    setActiveTab,
    isActive,
  };
}
