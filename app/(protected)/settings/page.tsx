/**
 * Settings Page
 *
 * User settings with tabbed navigation for:
 * - Profile: Edit profile information
 * - Security: Change password
 * - Notifications: Email preferences
 * - Account: Account info, interface language and deletion
 *
 * URL-persistent tabs: Each tab has its own URL (/settings?tab=security)
 * for shareable links and browser history support.
 *
 * Phase 3.2: User Management
 */

import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { getServerSession } from '@/lib/auth/utils';
import { clearInvalidSession } from '@/lib/auth/clear-session';
import { prisma } from '@/lib/db/client';
import { parseUserPreferences } from '@/lib/validations/user';
import { SettingsTabs } from '@/components/settings/settings-tabs';
import { getInitials } from '@/lib/utils/initials';
import { AccountSections } from '@/components/account/account-sections';
import { localeOptions } from '@/lib/i18n/locale-options';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('account.settings.meta');
  return { title: t('title'), description: t('description') };
}

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
      locale: true,
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
  const preferences = parseUserPreferences(user.preferences);

  // Check if user has a password account
  const hasPasswordAccount = user.accounts.some((account) => account.password !== null);

  // Get OAuth provider names (excluding credential provider)
  const oauthProviders = user.accounts
    .filter((account) => account.providerId !== 'credential' && account.password === null)
    .map((account) => formatProviderName(account.providerId));

  // Get user initials for avatar fallback
  const initials = getInitials(user.name);

  const t = await getTranslations('account.settings');

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div>
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <p className="text-muted-foreground">{t('description')}</p>
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
        language={{ locale: user.locale, options: localeOptions() }}
      />

      {/* Fork-registered sections (#595). Renders nothing in vanilla Sunrise.
          Below the tabs rather than as a fifth one: the tab list is a fixed
          four-column grid, and a fork's section is not always tab-shaped. */}
      <AccountSections surface="settings" userId={user.id} />
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
