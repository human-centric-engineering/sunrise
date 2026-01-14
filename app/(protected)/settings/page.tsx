/**
 * Settings Page
 *
 * User settings with tabbed navigation for:
 * - Profile: Edit profile information
 * - Security: Change password
 * - Notifications: Email preferences
 * - Account: Account info and deletion
 *
 * Phase 3.2: User Management
 */

import type { Metadata } from 'next';
import { Suspense } from 'react';
import { getServerSession } from '@/lib/auth/utils';
import { clearInvalidSession } from '@/lib/auth/clear-session';
import { prisma } from '@/lib/db/client';
import { DEFAULT_USER_PREFERENCES, type UserPreferences } from '@/types';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { ProfileForm } from '@/components/forms/profile-form';
import { PasswordForm } from '@/components/forms/password-form';
import { PreferencesForm } from '@/components/forms/preferences-form';
import { DeleteAccountForm } from '@/components/forms/delete-account-form';

export const metadata: Metadata = {
  title: 'Settings - Sunrise',
  description: 'Manage your account settings and preferences',
};

export default async function SettingsPage() {
  const session = await getServerSession();

  if (!session) {
    clearInvalidSession('/settings');
  }

  // Fetch full user data with preferences
  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: {
      id: true,
      name: true,
      email: true,
      emailVerified: true,
      image: true,
      role: true,
      createdAt: true,
      bio: true,
      phone: true,
      timezone: true,
      location: true,
      preferences: true,
    },
  });

  if (!user) {
    clearInvalidSession('/settings');
  }

  // Parse preferences from JSON
  const preferences = parsePreferences(user.preferences);

  // Get user initials for avatar fallback
  const initials = user.name
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div>
        <h1 className="text-2xl font-bold">Settings</h1>
        <p className="text-muted-foreground">Manage your account settings and preferences</p>
      </div>

      {/* Settings Tabs */}
      <Tabs defaultValue="profile" className="space-y-6">
        <TabsList className="grid w-full grid-cols-4">
          <TabsTrigger value="profile">Profile</TabsTrigger>
          <TabsTrigger value="security">Security</TabsTrigger>
          <TabsTrigger value="notifications">Notifications</TabsTrigger>
          <TabsTrigger value="account">Account</TabsTrigger>
        </TabsList>

        {/* Profile Tab */}
        <TabsContent value="profile">
          <Card>
            <CardHeader>
              <CardTitle>Profile</CardTitle>
              <CardDescription>Manage your public profile information</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              {/* Avatar Placeholder */}
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
        <TabsContent value="security">
          <Card>
            <CardHeader>
              <CardTitle>Security</CardTitle>
              <CardDescription>Manage your password and security settings</CardDescription>
            </CardHeader>
            <CardContent>
              <Suspense fallback={<div>Loading...</div>}>
                <PasswordForm />
              </Suspense>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Notifications Tab */}
        <TabsContent value="notifications">
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
        <TabsContent value="account">
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
    </div>
  );
}

/**
 * Parse preferences from database JSON field
 */
function parsePreferences(dbPreferences: unknown): UserPreferences {
  if (!dbPreferences || typeof dbPreferences !== 'object') {
    return DEFAULT_USER_PREFERENCES;
  }

  const prefs = dbPreferences as Record<string, unknown>;

  return {
    email: {
      marketing:
        typeof (prefs.email as Record<string, unknown>)?.marketing === 'boolean'
          ? ((prefs.email as Record<string, unknown>).marketing as boolean)
          : DEFAULT_USER_PREFERENCES.email.marketing,
      productUpdates:
        typeof (prefs.email as Record<string, unknown>)?.productUpdates === 'boolean'
          ? ((prefs.email as Record<string, unknown>).productUpdates as boolean)
          : DEFAULT_USER_PREFERENCES.email.productUpdates,
      securityAlerts: true,
    },
  };
}
