/**
 * Settings Page Constants
 *
 * Type-safe constants for the settings page tabs.
 * Used by the useUrlTabs hook and SettingsTabs component.
 */

import { BRAND } from '@/lib/brand';

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

/** The part of `useTranslations('account.settings')` that {@link settingsTabTitles} needs. */
type TabTitleTranslator = (
  key: 'tabTitle' | `tabs.${SettingsTab}`,
  values?: Record<string, string>
) => string;

/**
 * Page titles for each settings tab, in the viewer's language.
 *
 * Pass `useTranslations('account.settings')`. Written to document.title on tab
 * change, which OVERWRITES the layout's `%s - ${BRAND.name}` metadata template,
 * so each title carries the brand itself or a fork sees "Sunrise" in the
 * browser tab (#432). The words are the catalogue's `account.settings.tabTitle`
 * and `account.settings.tabs.<tab>`.
 */
export function settingsTabTitles(t: TabTitleTranslator): Record<SettingsTab, string> {
  const title = (tab: SettingsTab) => t('tabTitle', { tab: t(`tabs.${tab}`), brand: BRAND.name });
  return {
    [SETTINGS_TABS.PROFILE]: title('profile'),
    [SETTINGS_TABS.SECURITY]: title('security'),
    [SETTINGS_TABS.NOTIFICATIONS]: title('notifications'),
    [SETTINGS_TABS.ACCOUNT]: title('account'),
  };
}
