'use client';

/**
 * Settings Tabs Component
 *
 * Client component that renders the settings page tabs with URL persistence.
 * Uses the useUrlTabs hook to sync tab state with URL query parameters.
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

import { Suspense } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { ProfileForm } from '@/components/forms/profile-form';
import { PasswordForm } from '@/components/forms/password-form';
import { PreferencesForm } from '@/components/forms/preferences-form';
import { DeleteAccountForm } from '@/components/forms/delete-account-form';
import { useUrlTabs } from '@/lib/hooks/use-url-tabs';
import {
  SETTINGS_TABS,
  SETTINGS_TAB_VALUES,
  SETTINGS_TAB_TITLES,
  DEFAULT_SETTINGS_TAB,
  type SettingsTab,
} from '@/lib/constants/settings';
import type { UserPreferences } from '@/types';

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
}: SettingsTabsProps) {
  const { activeTab, setActiveTab } = useUrlTabs<SettingsTab>({
    defaultTab: DEFAULT_SETTINGS_TAB,
    allowedTabs: SETTINGS_TAB_VALUES,
    titles: SETTINGS_TAB_TITLES,
  });

  // Wrapper to handle Radix's string type for onValueChange
  const handleTabChange = (value: string) => {
    setActiveTab(value as SettingsTab);
  };

  return (
    <Tabs value={activeTab} onValueChange={handleTabChange} className="space-y-6">
      <TabsList className="grid w-full grid-cols-4">
        <TabsTrigger value={SETTINGS_TABS.PROFILE}>Profile</TabsTrigger>
        <TabsTrigger value={SETTINGS_TABS.SECURITY}>Security</TabsTrigger>
        <TabsTrigger value={SETTINGS_TABS.NOTIFICATIONS}>Notifications</TabsTrigger>
        <TabsTrigger value={SETTINGS_TABS.ACCOUNT}>Account</TabsTrigger>
      </TabsList>

      {/* Profile Tab */}
      <TabsContent value={SETTINGS_TABS.PROFILE}>
        <Card>
          <CardHeader>
            <CardTitle>Profile</CardTitle>
            <CardDescription>Manage your public profile information</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Avatar Section */}
            <div className="flex items-center gap-4">
              <Avatar className="h-20 w-20">
                <AvatarImage src={user.image || undefined} alt={user.name} />
                <AvatarFallback className="text-lg">{initials}</AvatarFallback>
              </Avatar>
              <div>
                <p className="font-medium">{user.name}</p>
                <Badge variant="secondary" className="mt-1">
                  Photo upload coming soon
                </Badge>
              </div>
            </div>

            <Separator />

            {/* Profile Form */}
            <Suspense fallback={<div>Loading...</div>}>
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
            <CardTitle>Security</CardTitle>
            <CardDescription>Manage your password and security settings</CardDescription>
          </CardHeader>
          <CardContent>
            {hasPasswordAccount ? (
              <Suspense fallback={<div>Loading...</div>}>
                <PasswordForm />
              </Suspense>
            ) : (
              <div className="text-muted-foreground space-y-2 py-4 text-center">
                <p>
                  You signed in with{' '}
                  <span className="text-foreground font-medium">
                    {oauthProviders.join(', ') || 'an external provider'}
                  </span>
                  .
                </p>
                <p className="text-sm">
                  Password settings are not available for accounts using external authentication.
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      </TabsContent>

      {/* Notifications Tab */}
      <TabsContent value={SETTINGS_TABS.NOTIFICATIONS}>
        <Card>
          <CardHeader>
            <CardTitle>Email Notifications</CardTitle>
            <CardDescription>Choose what emails you want to receive</CardDescription>
          </CardHeader>
          <CardContent>
            <Suspense fallback={<div>Loading...</div>}>
              <PreferencesForm preferences={preferences} />
            </Suspense>
          </CardContent>
        </Card>
      </TabsContent>

      {/* Account Tab */}
      <TabsContent value={SETTINGS_TABS.ACCOUNT}>
        <Card>
          <CardHeader>
            <CardTitle>Account</CardTitle>
            <CardDescription>View account information and manage your account</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Account Info */}
            <div className="space-y-4">
              <h3 className="font-medium">Account Information</h3>
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <p className="text-muted-foreground text-sm">Email</p>
                  <p className="font-medium">{user.email}</p>
                </div>
                <div>
                  <p className="text-muted-foreground text-sm">Email Verified</p>
                  <p className="font-medium">{user.emailVerified ? 'Yes' : 'No'}</p>
                </div>
                <div>
                  <p className="text-muted-foreground text-sm">Role</p>
                  <Badge variant="outline">{user.role || 'USER'}</Badge>
                </div>
                <div>
                  <p className="text-muted-foreground text-sm">Member Since</p>
                  <p className="font-medium">
                    {new Date(user.createdAt).toLocaleDateString('en-US', {
                      year: 'numeric',
                      month: 'long',
                      day: 'numeric',
                    })}
                  </p>
                </div>
              </div>
            </div>

            <Separator />

            {/* Danger Zone */}
            <div className="space-y-4">
              <h3 className="font-medium text-red-600 dark:text-red-400">Danger Zone</h3>
              <DeleteAccountForm />
            </div>
          </CardContent>
        </Card>
      </TabsContent>
    </Tabs>
  );
}
