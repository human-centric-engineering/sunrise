/**
 * Settings Page
 *
 * User settings with tabbed navigation for:
 * - Profile: Edit profile information
 * - Security: Change password
 * - Notifications: Email preferences
 * - Account: Account info and deletion
 *
 * URL-persistent tabs: Each tab has its own URL (/settings?tab=security)
 * for shareable links and browser history support.
 *
 * Phase 3.2: User Management
 */

import type { Metadata } from 'next';
import { getServerSession } from '@/lib/auth/utils';
import { clearInvalidSession } from '@/lib/auth/clear-session';
import { prisma } from '@/lib/db/client';
import { DEFAULT_USER_PREFERENCES } from '@/lib/validations/user';
import type { UserPreferences } from '@/types';
import { SettingsTabs } from '@/components/settings/settings-tabs';
import { getInitials } from '@/lib/utils/initials';

export const metadata: Metadata = {
  title: 'Settings',
  description: 'Manage your account settings and preferences',
};

export default async function SettingsPage() {
  const session = await getServerSession();

  if (!session) {
    clearInvalidSession('/settings');
  }

  // Fetch full user data with preferences and accounts
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
      accounts: {
        select: {
          providerId: true,
          password: true,
        },
      },
    },
  });

  if (!user) {
    clearInvalidSession('/settings');
  }

  // Parse preferences from JSON
  const preferences = parsePreferences(user.preferences);

  // Check if user has a password account
  const hasPasswordAccount = user.accounts.some((account) => account.password !== null);

  // Get OAuth provider names (excluding credential provider)
  const oauthProviders = user.accounts
    .filter((account) => account.providerId !== 'credential' && account.password === null)
    .map((account) => formatProviderName(account.providerId));

  // Get user initials for avatar fallback
  const initials = getInitials(user.name);

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div>
        <h1 className="text-2xl font-bold">Settings</h1>
        <p className="text-muted-foreground">Manage your account settings and preferences</p>
      </div>

      {/* Settings Tabs with URL persistence */}
      <SettingsTabs
        user={{
          name: user.name,
          email: user.email,
          bio: user.bio,
          phone: user.phone,
          timezone: user.timezone,
          location: user.location,
          image: user.image,
          emailVerified: user.emailVerified,
          role: user.role,
          createdAt: user.createdAt,
        }}
        preferences={preferences}
        hasPasswordAccount={hasPasswordAccount}
        oauthProviders={oauthProviders}
        initials={initials}
      />
    </div>
  );
}

/**
 * Format OAuth provider ID to human-readable name
 */
function formatProviderName(providerId: string): string {
  const providerNames: Record<string, string> = {
    google: 'Google',
    github: 'GitHub',
    facebook: 'Facebook',
    twitter: 'Twitter',
    apple: 'Apple',
    microsoft: 'Microsoft',
    discord: 'Discord',
    linkedin: 'LinkedIn',
  };

  return providerNames[providerId.toLowerCase()] || providerId;
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
