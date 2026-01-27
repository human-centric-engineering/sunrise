'use client';

/**
 * useTrackedUrlTabs Hook
 *
 * A reusable hook that combines URL-synced tabs with optional analytics tracking.
 * Extends useUrlTabs with built-in tab change tracking, previousTab initialization,
 * and double-fire prevention.
 *
 * @example Basic usage (no tracking)
 * ```tsx
 * const { activeTab, setActiveTab } = useTrackedUrlTabs({
 *   defaultTab: 'overview',
 *   allowedTabs: ['overview', 'details', 'history'],
 * });
 * ```
 *
 * @example With analytics tracking
 * ```tsx
 * const { activeTab, setActiveTab } = useTrackedUrlTabs({
 *   defaultTab: 'profile',
 *   allowedTabs: ['profile', 'security', 'notifications'],
 *   tracking: {
 *     eventName: 'settings_tab_changed',
 *   },
 * });
 * // Tracks: { tab: 'security', previous_tab: 'profile' }
 * ```
 *
 * @example With custom property names
 * ```tsx
 * const { activeTab, setActiveTab } = useTrackedUrlTabs({
 *   defaultTab: 'overview',
 *   allowedTabs: ['overview', 'details'],
 *   tracking: {
 *     eventName: 'admin_tab_changed',
 *     tabPropertyName: 'selected_tab',      // default: 'tab'
 *     previousPropertyName: 'from_tab',     // default: 'previous_tab'
 *   },
 * });
 * // Tracks: { selected_tab: 'details', from_tab: 'overview' }
 * ```
 */

import { useCallback, useEffect, useRef } from 'react';
import { useUrlTabs, type UseUrlTabsOptions, type UseUrlTabsReturn } from './use-url-tabs';
import { useAnalytics } from '@/lib/analytics';

/**
 * Tracking configuration for tab changes
 */
export interface TabTrackingOptions {
  /** Analytics event name (e.g., 'settings_tab_changed') */
  eventName: string;
  /** Property name for the new tab (default: 'tab') */
  tabPropertyName?: string;
  /** Property name for the previous tab (default: 'previous_tab') */
  previousPropertyName?: string;
  /** Additional properties to include with every tab change event */
  additionalProperties?: Record<string, unknown>;
}

/**
 * Options for useTrackedUrlTabs
 */
export interface UseTrackedUrlTabsOptions<T extends string = string> extends UseUrlTabsOptions<T> {
  /** Optional tracking configuration - omit to disable tracking */
  tracking?: TabTrackingOptions;
}

/**
 * Return type for useTrackedUrlTabs (same as useUrlTabs)
 */
export type UseTrackedUrlTabsReturn<T extends string = string> = UseUrlTabsReturn<T>;

/**
 * Hook for URL-synced tab navigation with optional analytics tracking
 *
 * Features:
 * - All features from useUrlTabs (URL sync, validation, title updates)
 * - Optional analytics tracking on tab changes
 * - Automatic previousTab initialization (no more undefined on first change)
 * - Double-fire prevention (handles Radix + URL sync race condition)
 * - Customizable event and property names
 */
export function useTrackedUrlTabs<T extends string = string>({
  tracking,
  ...urlTabsOptions
}: UseTrackedUrlTabsOptions<T>): UseTrackedUrlTabsReturn<T> {
  const { activeTab, setActiveTab: baseSetActiveTab, isActive } = useUrlTabs(urlTabsOptions);
  const { track } = useAnalytics();

  // Track previous tab for analytics
  const previousTabRef = useRef<T | undefined>(undefined);

  // Initialize previousTabRef with active tab on mount
  useEffect(() => {
    if (previousTabRef.current === undefined) {
      previousTabRef.current = activeTab;
    }
  }, [activeTab]);

  // Wrapped setActiveTab that handles tracking
  const setActiveTab = useCallback(
    (newTab: T) => {
      // Only track if tab actually changed (prevents double-fire from URL sync)
      if (tracking && newTab !== previousTabRef.current) {
        const {
          eventName,
          tabPropertyName = 'tab',
          previousPropertyName = 'previous_tab',
          additionalProperties = {},
        } = tracking;

        void track(eventName, {
          [tabPropertyName]: newTab,
          [previousPropertyName]: previousTabRef.current,
          ...additionalProperties,
        });

        previousTabRef.current = newTab;
      } else if (!tracking && newTab !== previousTabRef.current) {
        // Update ref even without tracking (for consistent previousTab value)
        previousTabRef.current = newTab;
      }

      baseSetActiveTab(newTab);
    },
    [tracking, track, baseSetActiveTab]
  );

  return {
    activeTab,
    setActiveTab,
    isActive,
  };
}
