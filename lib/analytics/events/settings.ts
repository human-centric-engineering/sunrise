'use client';

/**
 * Settings Analytics Helpers
 *
 * Hooks and functions for tracking settings-related events.
 *
 * Phase 4.5: Analytics Integration
 *
 * @example
 * ```tsx
 * import { useSettingsAnalytics } from '@/lib/analytics/events';
 *
 * function SettingsTabs() {
 *   const { trackTabChanged } = useSettingsAnalytics();
 *
 *   const handleTabChange = (newTab: SettingsTab) => {
 *     trackTabChanged({ tab: newTab, previous_tab: currentTab });
 *     setActiveTab(newTab);
 *   };
 * }
 * ```
 */

import { useCallback } from 'react';
import { useAnalytics } from '../hooks';
import { EVENTS } from './constants';
import type {
  SettingsTabEventProps,
  ProfileUpdatedEventProps,
  PreferencesUpdatedEventProps,
} from './types';
import type { TrackResult } from '../types';

/**
 * Hook for settings page analytics events
 *
 * Provides type-safe helpers for tracking settings interactions
 * including tab changes, profile updates, and preference changes.
 *
 * @example Track tab change
 * ```tsx
 * const { trackTabChanged } = useSettingsAnalytics();
 *
 * const handleTabChange = (newTab: SettingsTab) => {
 *   trackTabChanged({ tab: newTab, previous_tab: currentTab });
 * };
 * ```
 *
 * @example Track profile update
 * ```tsx
 * const { trackProfileUpdated } = useSettingsAnalytics();
 *
 * const handleSave = async () => {
 *   const changedFields = getChangedFields(original, updated);
 *   await trackProfileUpdated({ fields_changed: changedFields });
 * };
 * ```
 */
export function useSettingsAnalytics() {
  const { track } = useAnalytics();

  /**
   * Track settings tab change
   *
   * @param props - Tab change properties
   */
  const trackTabChanged = useCallback(
    (props: SettingsTabEventProps): Promise<TrackResult> => {
      return track(EVENTS.SETTINGS_TAB_CHANGED, props);
    },
    [track]
  );

  /**
   * Track profile update
   *
   * @param props - Fields that were changed
   */
  const trackProfileUpdated = useCallback(
    (props: ProfileUpdatedEventProps): Promise<TrackResult> => {
      return track(EVENTS.PROFILE_UPDATED, props);
    },
    [track]
  );

  /**
   * Track password change
   */
  const trackPasswordChanged = useCallback((): Promise<TrackResult> => {
    return track(EVENTS.PASSWORD_CHANGED);
  }, [track]);

  /**
   * Track preferences update
   *
   * @param props - Updated preference values
   */
  const trackPreferencesUpdated = useCallback(
    (props: PreferencesUpdatedEventProps): Promise<TrackResult> => {
      return track(EVENTS.PREFERENCES_UPDATED, props);
    },
    [track]
  );

  /**
   * Track avatar upload
   */
  const trackAvatarUploaded = useCallback((): Promise<TrackResult> => {
    return track(EVENTS.AVATAR_UPLOADED);
  }, [track]);

  /**
   * Track account deletion
   */
  const trackAccountDeleted = useCallback((): Promise<TrackResult> => {
    return track(EVENTS.ACCOUNT_DELETED);
  }, [track]);

  return {
    trackTabChanged,
    trackProfileUpdated,
    trackPasswordChanged,
    trackPreferencesUpdated,
    trackAvatarUploaded,
    trackAccountDeleted,
  };
}
