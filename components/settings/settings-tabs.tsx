'use client';

/**
 * Settings Tabs Component
 *
 * Client component that renders the settings page tabs with URL persistence
 * and analytics tracking. Uses useTrackedUrlTabs for automatic tab change tracking.
 *
 * @example
 * ```tsx
 * <SettingsTabs
 *   user={userData}
 *   preferences={userPreferences}
 *   hasPasswordAccount={true}
 *   oauthProviders={['Google']}
 * />
 * ```
 */

import { Suspense, useMemo } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Badge } from '@/components/ui/badge';
import { ProfileForm } from '@/components/forms/profile-form';
import { AvatarUpload } from '@/components/forms/avatar-upload';
import { PasswordForm } from '@/components/forms/password-form';
import { PreferencesForm } from '@/components/forms/preferences-form';
import { DeleteAccountForm } from '@/components/forms/delete-account-form';
import { LanguageForm, type LanguageFormProps } from '@/components/settings/language-form';
import { useTrackedUrlTabs } from '@/lib/hooks/use-tracked-url-tabs';
import { EVENTS } from '@/lib/analytics/events/constants';
import {
  SETTINGS_TABS,
  SETTINGS_TAB_VALUES,
  DEFAULT_SETTINGS_TAB,
  type SettingsTab,
} from '@/lib/constants/settings';
import type { UserPreferences } from '@/types';
import { DEFAULT_USER_ROLE } from '@/lib/auth/roles';
import { BRAND } from '@/lib/brand';

/**
 * User data passed from server component
 */
interface SettingsUser {
  name: string;
  email: string;
  bio: string | null;
  phone: string | null;
  timezone: string | null;
  location: string | null;
  image: string | null;
  emailVerified: boolean;
  role: string | null;
  createdAt: Date;
}

/**
 * Props for SettingsTabs component
 */
interface SettingsTabsProps {
  /** User profile data */
  user: SettingsUser;
  /** User preferences (email notifications, etc.) */
  preferences: UserPreferences;
  /** Whether user has a password-based account */
  hasPasswordAccount: boolean;
  /** List of OAuth provider names (e.g., ['Google', 'GitHub']) */
  oauthProviders: string[];
  /** User initials for avatar fallback */
  initials: string;
  /** The stored interface language and the languages on offer (built on the server) */
  language: LanguageFormProps;
}

/**
 * Settings tabs with URL-synced navigation
 *
 * Features:
 * - URL persistence via query params (?tab=security)
 * - SPA-like navigation (no page reload)
 * - Browser back/forward support
 * - Invalid URL fallback to default tab
 */
export function SettingsTabs({
  user,
  preferences,
  hasPasswordAccount,
  oauthProviders,
  initials,
  language,
}: SettingsTabsProps) {
  const t = useTranslations('account.settings');
  const format = useFormatter();

  // document.title per tab, in the viewer's language. Replaces the layout's
  // `%s - brand` template, so it carries the brand itself.
  const titles = useMemo<Record<SettingsTab, string>>(
    () => ({
      [SETTINGS_TABS.PROFILE]: t('tabTitle', { tab: t('tabs.profile'), brand: BRAND.name }),
      [SETTINGS_TABS.SECURITY]: t('tabTitle', { tab: t('tabs.security'), brand: BRAND.name }),
      [SETTINGS_TABS.NOTIFICATIONS]: t('tabTitle', {
        tab: t('tabs.notifications'),
        brand: BRAND.name,
      }),
      [SETTINGS_TABS.ACCOUNT]: t('tabTitle', { tab: t('tabs.account'), brand: BRAND.name }),
    }),
    [t]
  );

  const { activeTab, setActiveTab } = useTrackedUrlTabs<SettingsTab>({
    defaultTab: DEFAULT_SETTINGS_TAB,
    allowedTabs: SETTINGS_TAB_VALUES,
    titles,
    tracking: {
      eventName: EVENTS.SETTINGS_TAB_CHANGED,
    },
  });

  // Cast to handle Radix's string type for onValueChange
  const handleTabChange = (value: string) => setActiveTab(value as SettingsTab);

  return (
    <Tabs value={activeTab} onValueChange={handleTabChange} className="space-y-6">
      <TabsList className="grid w-full grid-cols-4">
        <TabsTrigger value={SETTINGS_TABS.PROFILE}>{t('tabs.profile')}</TabsTrigger>
        <TabsTrigger value={SETTINGS_TABS.SECURITY}>{t('tabs.security')}</TabsTrigger>
        <TabsTrigger value={SETTINGS_TABS.NOTIFICATIONS}>{t('tabs.notifications')}</TabsTrigger>
        <TabsTrigger value={SETTINGS_TABS.ACCOUNT}>{t('tabs.account')}</TabsTrigger>
      </TabsList>

      {/* Profile Tab */}
      <TabsContent value={SETTINGS_TABS.PROFILE}>
        <Card>
          <CardHeader>
            <CardTitle>{t('profileTab.title')}</CardTitle>
            <CardDescription>{t('profileTab.description')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Avatar Section */}
            <AvatarUpload currentAvatar={user.image} userName={user.name} initials={initials} />

            <Separator />

            {/* Profile Form */}
            <Suspense fallback={<div>{t('loading')}</div>}>
              <ProfileForm
                user={{
                  name: user.name,
                  email: user.email,
                  bio: user.bio,
                  phone: user.phone,
                  timezone: user.timezone,
                  location: user.location,
                }}
              />
            </Suspense>
          </CardContent>
        </Card>
      </TabsContent>

      {/* Security Tab */}
      <TabsContent value={SETTINGS_TABS.SECURITY}>
        <Card>
          <CardHeader>
            <CardTitle>{t('securityTab.title')}</CardTitle>
            <CardDescription>{t('securityTab.description')}</CardDescription>
          </CardHeader>
          <CardContent>
            {hasPasswordAccount ? (
              <Suspense fallback={<div>{t('loading')}</div>}>
                <PasswordForm />
              </Suspense>
            ) : (
              <div className="text-muted-foreground space-y-2 py-4 text-center">
                <p>
                  {t.rich('securityTab.signedInWith', {
                    providers: oauthProviders.join(', ') || t('securityTab.externalProvider'),
                    provider: (chunks) => (
                      <span className="text-foreground font-medium">{chunks}</span>
                    ),
                  })}
                </p>
                <p className="text-sm">{t('securityTab.noPassword')}</p>
              </div>
            )}
          </CardContent>
        </Card>
      </TabsContent>

      {/* Notifications Tab */}
      <TabsContent value={SETTINGS_TABS.NOTIFICATIONS}>
        <Card>
          <CardHeader>
            <CardTitle>{t('notificationsTab.title')}</CardTitle>
            <CardDescription>{t('notificationsTab.description')}</CardDescription>
          </CardHeader>
          <CardContent>
            <Suspense fallback={<div>{t('loading')}</div>}>
              <PreferencesForm preferences={preferences} />
            </Suspense>
          </CardContent>
        </Card>
      </TabsContent>

      {/* Account Tab */}
      <TabsContent value={SETTINGS_TABS.ACCOUNT}>
        <Card>
          <CardHeader>
            <CardTitle>{t('accountTab.title')}</CardTitle>
            <CardDescription>{t('accountTab.description')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Account Info */}
            <div className="space-y-4">
              <h3 className="font-medium">{t('accountTab.info')}</h3>
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <p className="text-muted-foreground text-sm">{t('accountTab.email')}</p>
                  <p className="font-medium">{user.email}</p>
                </div>
                <div>
                  <p className="text-muted-foreground text-sm">{t('accountTab.emailVerified')}</p>
                  <p className="font-medium">
                    {user.emailVerified ? t('accountTab.yes') : t('accountTab.no')}
                  </p>
                </div>
                <div>
                  <p className="text-muted-foreground text-sm">{t('accountTab.role')}</p>
                  <Badge variant="outline">{user.role || DEFAULT_USER_ROLE}</Badge>
                </div>
                <div>
                  <p className="text-muted-foreground text-sm">{t('accountTab.memberSince')}</p>
                  <p className="font-medium">{format.dateTime(user.createdAt, 'long')}</p>
                </div>
              </div>
            </div>

            <Separator />

            {/* Interface language */}
            <div className="space-y-4">
              <h3 className="font-medium">{t('accountTab.language')}</h3>
              <LanguageForm locale={language.locale} options={language.options} />
            </div>

            <Separator />

            {/* Danger Zone */}
            <div className="space-y-4">
              <h3 className="font-medium text-red-600 dark:text-red-400">
                {t('accountTab.dangerZone')}
              </h3>
              <DeleteAccountForm />
            </div>
          </CardContent>
        </Card>
      </TabsContent>
    </Tabs>
  );
}
