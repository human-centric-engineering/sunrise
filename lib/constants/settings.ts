/**
 * Settings Page Constants
 *
 * Type-safe constants for the settings page tabs.
 * Used by the useUrlTabs hook and SettingsTabs component.
 */

export const SETTINGS_TABS = {
  PROFILE: 'profile',
  SECURITY: 'security',
  NOTIFICATIONS: 'notifications',
  ACCOUNT: 'account',
} as const;

export const SETTINGS_TAB_VALUES = Object.values(SETTINGS_TABS);

export type SettingsTab = (typeof SETTINGS_TABS)[keyof typeof SETTINGS_TABS];

/**
 * Default tab when no URL parameter is present or value is invalid
 */
export const DEFAULT_SETTINGS_TAB: SettingsTab = SETTINGS_TABS.PROFILE;

/**
 * Page titles for each settings tab
 * Used by useUrlTabs to update document.title on tab change
 */
export const SETTINGS_TAB_TITLES: Record<SettingsTab, string> = {
  [SETTINGS_TABS.PROFILE]: 'Profile - Settings - Sunrise',
  [SETTINGS_TABS.SECURITY]: 'Security - Settings - Sunrise',
  [SETTINGS_TABS.NOTIFICATIONS]: 'Notifications - Settings - Sunrise',
  [SETTINGS_TABS.ACCOUNT]: 'Account - Settings - Sunrise',
};
