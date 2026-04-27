/**
 * Settings Page Tests
 *
 * Tests the protected settings page Server Component.
 *
 * Test Coverage:
 * - Redirect to /login (via clearInvalidSession) when no session exists
 * - Redirect to /login when user not found in database
 * - Successful render with valid user and all data
 * - Preferences parsed from stored JSON (parseUserPreferences integration)
 * - Null preferences fall back to defaults
 * - Password account detection (hasPasswordAccount flag)
 * - OAuth provider name formatting (known and unknown providers)
 * - User initials computed from name
 * - Page metadata
 *
 * @see app/(protected)/settings/page.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
/**
 * Mock next/navigation — redirect() is used by clearInvalidSession().
 * It throws so the page function stops executing (matches Next.js runtime behaviour).
 */
vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
}));

/**
 * Mock getServerSession — the page's first async call.
 */
vi.mock('@/lib/auth/utils', () => ({
  getServerSession: vi.fn(),
}));

/**
 * Mock clearInvalidSession — delegates to redirect() internally.
 * We throw the same sentinel the redirect mock uses so callers can assert
 * both that clearInvalidSession was called and that execution stopped.
 */
vi.mock('@/lib/auth/clear-session', () => ({
  clearInvalidSession: vi.fn((returnUrl: string) => {
    throw new Error(
      `NEXT_REDIRECT:/api/auth/clear-session?returnUrl=${encodeURIComponent(returnUrl)}`
    );
  }),
}));

/**
 * Mock Prisma client — prevents real DB calls.
 */
vi.mock('@/lib/db/client', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
    },
  },
}));

/**
 * Mock SettingsTabs — heavy client component; we just verify it receives
 * the correct props rather than rendering the full tab tree.
 */
vi.mock('@/components/settings/settings-tabs', () => ({
  SettingsTabs: ({
    user,
    preferences,
    hasPasswordAccount,
    oauthProviders,
    initials,
  }: {
    user: { name: string; email: string };
    preferences: {
      email: { marketing: boolean; productUpdates: boolean; securityAlerts: boolean };
    };
    hasPasswordAccount: boolean;
    oauthProviders: string[];
    initials: string;
  }) => (
    <div
      data-testid="settings-tabs"
      data-name={user.name}
      data-email={user.email}
      data-has-password={String(hasPasswordAccount)}
      data-providers={JSON.stringify(oauthProviders)}
      data-initials={initials}
      data-preferences={JSON.stringify(preferences)}
    />
  ),
}));

import SettingsPage, { metadata } from '@/app/(protected)/settings/page';
import { getServerSession } from '@/lib/auth/utils';
import { clearInvalidSession } from '@/lib/auth/clear-session';
import { prisma } from '@/lib/db/client';
import { DEFAULT_USER_PREFERENCES } from '@/lib/validations/user';

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

const MOCK_SESSION = {
  session: {
    id: 'session_abc',
    userId: 'user_abc',
    expiresAt: new Date(Date.now() + 86400_000),
    token: 'tok_abc',
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  user: {
    id: 'user_abc',
    email: 'alice@example.com',
    name: 'Alice Example',
    emailVerified: true,
    image: null,
    role: 'USER' as const,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
};

const VALID_PREFERENCES = {
  email: {
    marketing: true,
    productUpdates: true,
    securityAlerts: true,
  },
};

/** Full mock DB user with a password account and an OAuth account. */
function makeFullUser(
  overrides: Partial<{
    preferences: unknown;
    accounts: Array<{ providerId: string; password: string | null }>;
  }> = {}
) {
  return {
    id: 'user_abc',
    name: 'Alice Example',
    email: 'alice@example.com',
    emailVerified: true,
    image: null,
    role: 'USER',
    createdAt: new Date('2024-01-01'),
    bio: 'Hello world',
    phone: '+1234567890',
    timezone: 'UTC',
    location: 'London',
    preferences: VALID_PREFERENCES,
    accounts: [
      { providerId: 'credential', password: 'hashed_pw' },
      { providerId: 'google', password: null },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SettingsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Metadata
  // -------------------------------------------------------------------------

  describe('metadata', () => {
    it('has the correct title', () => {
      expect(metadata.title).toBe('Settings');
    });

    it('has the correct description', () => {
      expect(metadata.description).toBe('Manage your account settings and preferences');
    });
  });

  // -------------------------------------------------------------------------
  // Authentication redirect
  // -------------------------------------------------------------------------

  describe('authentication guard', () => {
    it('calls clearInvalidSession and redirects when no session exists', async () => {
      // Arrange
      vi.mocked(getServerSession).mockResolvedValue(null);

      // Act & Assert
      await expect(SettingsPage()).rejects.toThrow('NEXT_REDIRECT');
      expect(clearInvalidSession).toHaveBeenCalledWith('/settings');
    });

    it('calls clearInvalidSession and redirects when user is not found in the database', async () => {
      // Arrange: valid session but user missing from DB
      vi.mocked(getServerSession).mockResolvedValue(MOCK_SESSION as never);
      vi.mocked(prisma.user.findUnique).mockResolvedValue(null);

      // Act & Assert
      await expect(SettingsPage()).rejects.toThrow('NEXT_REDIRECT');
      expect(clearInvalidSession).toHaveBeenCalledWith('/settings');
    });
  });

  // -------------------------------------------------------------------------
  // Successful render
  // -------------------------------------------------------------------------

  describe('successful render', () => {
    it('renders the page heading', async () => {
      // Arrange
      vi.mocked(getServerSession).mockResolvedValue(MOCK_SESSION as never);
      vi.mocked(prisma.user.findUnique).mockResolvedValue(makeFullUser() as never);

      // Act
      const Component = await SettingsPage();
      render(Component);

      // Assert
      expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Settings');
    });

    it('renders the page subtitle', async () => {
      // Arrange
      vi.mocked(getServerSession).mockResolvedValue(MOCK_SESSION as never);
      vi.mocked(prisma.user.findUnique).mockResolvedValue(makeFullUser() as never);

      // Act
      const Component = await SettingsPage();
      render(Component);

      // Assert
      expect(screen.getByText('Manage your account settings and preferences')).toBeInTheDocument();
    });

    it('renders SettingsTabs with user name and email', async () => {
      // Arrange
      vi.mocked(getServerSession).mockResolvedValue(MOCK_SESSION as never);
      vi.mocked(prisma.user.findUnique).mockResolvedValue(makeFullUser() as never);

      // Act
      const Component = await SettingsPage();
      render(Component);

      // Assert: SettingsTabs receives the user data from the DB row
      const tabs = screen.getByTestId('settings-tabs');
      expect(tabs).toHaveAttribute('data-name', 'Alice Example');
      expect(tabs).toHaveAttribute('data-email', 'alice@example.com');
    });

    it('queries the database with the session user ID', async () => {
      // Arrange
      vi.mocked(getServerSession).mockResolvedValue(MOCK_SESSION as never);
      vi.mocked(prisma.user.findUnique).mockResolvedValue(makeFullUser() as never);

      // Act
      await SettingsPage();

      // Assert: the right user ID was used in the DB query
      expect(prisma.user.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'user_abc' },
        })
      );
    });
  });

  // -------------------------------------------------------------------------
  // parseUserPreferences integration
  // -------------------------------------------------------------------------

  describe('preferences parsing', () => {
    it('passes parsed preferences to SettingsTabs when stored preferences are valid', async () => {
      // Arrange
      vi.mocked(getServerSession).mockResolvedValue(MOCK_SESSION as never);
      vi.mocked(prisma.user.findUnique).mockResolvedValue(
        makeFullUser({ preferences: VALID_PREFERENCES }) as never
      );

      // Act
      const Component = await SettingsPage();
      render(Component);

      // Assert: the parsed (not raw) preferences are forwarded
      const tabs = screen.getByTestId('settings-tabs');
      const passed = JSON.parse(tabs.getAttribute('data-preferences') ?? '{}');
      expect(passed.email.marketing).toBe(true);
      expect(passed.email.productUpdates).toBe(true);
      // securityAlerts is forced true by parseUserPreferences regardless of stored value
      expect(passed.email.securityAlerts).toBe(true);
    });

    it('falls back to DEFAULT_USER_PREFERENCES when stored preferences are null', async () => {
      // Arrange
      vi.mocked(getServerSession).mockResolvedValue(MOCK_SESSION as never);
      vi.mocked(prisma.user.findUnique).mockResolvedValue(
        makeFullUser({ preferences: null }) as never
      );

      // Act
      const Component = await SettingsPage();
      render(Component);

      // Assert: defaults are passed through, not the raw null
      const tabs = screen.getByTestId('settings-tabs');
      const passed = JSON.parse(tabs.getAttribute('data-preferences') ?? '{}');
      expect(passed).toEqual(DEFAULT_USER_PREFERENCES);
    });

    it('falls back to DEFAULT_USER_PREFERENCES when stored preferences have an invalid shape', async () => {
      // Arrange: corrupt JSON object that fails Zod parse
      vi.mocked(getServerSession).mockResolvedValue(MOCK_SESSION as never);
      vi.mocked(prisma.user.findUnique).mockResolvedValue(
        makeFullUser({ preferences: { unexpected_key: 42 } }) as never
      );

      // Act
      const Component = await SettingsPage();
      render(Component);

      // Assert
      const tabs = screen.getByTestId('settings-tabs');
      const passed = JSON.parse(tabs.getAttribute('data-preferences') ?? '{}');
      expect(passed).toEqual(DEFAULT_USER_PREFERENCES);
    });

    it('forces securityAlerts to true even when stored value is false', async () => {
      // Arrange
      vi.mocked(getServerSession).mockResolvedValue(MOCK_SESSION as never);
      vi.mocked(prisma.user.findUnique).mockResolvedValue(
        makeFullUser({
          preferences: {
            email: { marketing: false, productUpdates: false, securityAlerts: false },
          },
        }) as never
      );

      // Act
      const Component = await SettingsPage();
      render(Component);

      // Assert: securityAlerts is coerced to true by parseUserPreferences
      const tabs = screen.getByTestId('settings-tabs');
      const passed = JSON.parse(tabs.getAttribute('data-preferences') ?? '{}');
      expect(passed.email.securityAlerts).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Password account detection
  // -------------------------------------------------------------------------

  describe('hasPasswordAccount', () => {
    it('passes hasPasswordAccount=true when the user has a credential account with a password', async () => {
      // Arrange: credential account with a non-null password
      vi.mocked(getServerSession).mockResolvedValue(MOCK_SESSION as never);
      vi.mocked(prisma.user.findUnique).mockResolvedValue(
        makeFullUser({
          accounts: [{ providerId: 'credential', password: 'hashed_pw' }],
        }) as never
      );

      // Act
      const Component = await SettingsPage();
      render(Component);

      // Assert
      expect(screen.getByTestId('settings-tabs')).toHaveAttribute('data-has-password', 'true');
    });

    it('passes hasPasswordAccount=false when no account has a non-null password', async () => {
      // Arrange: only OAuth accounts, no password set
      vi.mocked(getServerSession).mockResolvedValue(MOCK_SESSION as never);
      vi.mocked(prisma.user.findUnique).mockResolvedValue(
        makeFullUser({
          accounts: [
            { providerId: 'google', password: null },
            { providerId: 'github', password: null },
          ],
        }) as never
      );

      // Act
      const Component = await SettingsPage();
      render(Component);

      // Assert
      expect(screen.getByTestId('settings-tabs')).toHaveAttribute('data-has-password', 'false');
    });

    it('passes hasPasswordAccount=false when the user has no accounts at all', async () => {
      // Arrange
      vi.mocked(getServerSession).mockResolvedValue(MOCK_SESSION as never);
      vi.mocked(prisma.user.findUnique).mockResolvedValue(makeFullUser({ accounts: [] }) as never);

      // Act
      const Component = await SettingsPage();
      render(Component);

      // Assert
      expect(screen.getByTestId('settings-tabs')).toHaveAttribute('data-has-password', 'false');
    });
  });

  // -------------------------------------------------------------------------
  // OAuth provider name formatting
  // -------------------------------------------------------------------------

  describe('oauthProviders formatting', () => {
    it('excludes the credential provider from OAuth providers list', async () => {
      // Arrange: credential + google
      vi.mocked(getServerSession).mockResolvedValue(MOCK_SESSION as never);
      vi.mocked(prisma.user.findUnique).mockResolvedValue(
        makeFullUser({
          accounts: [
            { providerId: 'credential', password: 'hashed_pw' },
            { providerId: 'google', password: null },
          ],
        }) as never
      );

      // Act
      const Component = await SettingsPage();
      render(Component);

      // Assert: 'credential' is excluded; 'google' is formatted to 'Google'
      const tabs = screen.getByTestId('settings-tabs');
      const providers: string[] = JSON.parse(tabs.getAttribute('data-providers') ?? '[]');
      expect(providers).not.toContain('credential');
      expect(providers).toContain('Google');
    });

    it('formats known provider IDs to human-readable names', async () => {
      // Arrange: all known providers
      vi.mocked(getServerSession).mockResolvedValue(MOCK_SESSION as never);
      vi.mocked(prisma.user.findUnique).mockResolvedValue(
        makeFullUser({
          accounts: [
            { providerId: 'google', password: null },
            { providerId: 'github', password: null },
            { providerId: 'discord', password: null },
            { providerId: 'microsoft', password: null },
          ],
        }) as never
      );

      // Act
      const Component = await SettingsPage();
      render(Component);

      // Assert
      const tabs = screen.getByTestId('settings-tabs');
      const providers: string[] = JSON.parse(tabs.getAttribute('data-providers') ?? '[]');
      expect(providers).toEqual(['Google', 'GitHub', 'Discord', 'Microsoft']);
    });

    it('preserves the raw provider ID for unknown provider names', async () => {
      // Arrange: an unrecognised provider
      vi.mocked(getServerSession).mockResolvedValue(MOCK_SESSION as never);
      vi.mocked(prisma.user.findUnique).mockResolvedValue(
        makeFullUser({
          accounts: [{ providerId: 'okta', password: null }],
        }) as never
      );

      // Act
      const Component = await SettingsPage();
      render(Component);

      // Assert: unknown provider falls back to raw ID
      const tabs = screen.getByTestId('settings-tabs');
      const providers: string[] = JSON.parse(tabs.getAttribute('data-providers') ?? '[]');
      expect(providers).toContain('okta');
    });

    it('produces an empty providers list when all accounts are credential-type', async () => {
      // Arrange
      vi.mocked(getServerSession).mockResolvedValue(MOCK_SESSION as never);
      vi.mocked(prisma.user.findUnique).mockResolvedValue(
        makeFullUser({
          accounts: [{ providerId: 'credential', password: 'hashed_pw' }],
        }) as never
      );

      // Act
      const Component = await SettingsPage();
      render(Component);

      // Assert
      const tabs = screen.getByTestId('settings-tabs');
      const providers: string[] = JSON.parse(
        tabs.getAttribute('data-providers') ?? '["non-empty"]'
      );
      expect(providers).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // User initials
  // -------------------------------------------------------------------------

  describe('initials computation', () => {
    it('passes initials derived from the user name to SettingsTabs', async () => {
      // Arrange
      vi.mocked(getServerSession).mockResolvedValue(MOCK_SESSION as never);
      vi.mocked(prisma.user.findUnique).mockResolvedValue(
        makeFullUser() as never // name = 'Alice Example'
      );

      // Act
      const Component = await SettingsPage();
      render(Component);

      // Assert: getInitials('Alice Example') → 'AE'
      expect(screen.getByTestId('settings-tabs')).toHaveAttribute('data-initials', 'AE');
    });

    it('passes single-letter initial for a single-word name', async () => {
      // Arrange
      vi.mocked(getServerSession).mockResolvedValue(MOCK_SESSION as never);
      vi.mocked(prisma.user.findUnique).mockResolvedValue(makeFullUser() as never);
      // Override the name on the returned object inline
      const user = makeFullUser();
      user.name = 'Madonna';
      vi.mocked(prisma.user.findUnique).mockResolvedValue(user as never);

      // Act
      const Component = await SettingsPage();
      render(Component);

      // Assert: getInitials('Madonna') → 'M'
      expect(screen.getByTestId('settings-tabs')).toHaveAttribute('data-initials', 'M');
    });
  });
});
