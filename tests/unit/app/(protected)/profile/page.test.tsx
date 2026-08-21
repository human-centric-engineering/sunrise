// @vitest-environment happy-dom

/**
 * Profile Page Tests
 *
 * Tests the protected profile page Server Component.
 *
 * Test Coverage:
 * - Redirect to /login (via clearInvalidSession) when no session exists
 * - Redirect when the session's user is no longer in the database
 * - Renders name, email, role and the verified badge
 * - Bio block appears only when a bio is set
 * - Timezone formatting, and the UTC fallback when unset
 * - Fork-registered account sections (#595)
 * - Page metadata
 *
 * @see app/(protected)/profile/page.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
  useSearchParams: () => ({ get: () => null }),
}));

vi.mock('@/lib/auth/utils', () => ({
  getServerSession: vi.fn(),
}));

vi.mock('@/lib/auth/clear-session', () => ({
  clearInvalidSession: vi.fn((returnUrl: string) => {
    throw new Error(
      `NEXT_REDIRECT:/api/auth/clear-session?returnUrl=${encodeURIComponent(returnUrl)}`
    );
  }),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: { user: { findUnique: vi.fn() } },
}));

/** The account-section fork seam ships empty; one test below fills it. */
vi.mock('@/lib/app/account-sections', () => ({ initAppAccountSections: vi.fn() }));

import ProfilePage, { metadata } from '@/app/(protected)/profile/page';
import { getServerSession } from '@/lib/auth/utils';
import { clearInvalidSession } from '@/lib/auth/clear-session';
import { prisma } from '@/lib/db/client';
import { initAppAccountSections } from '@/lib/app/account-sections';
import {
  registerAccountSection,
  __resetAccountSectionRegistryForTests,
  type AccountSectionProps,
} from '@/lib/account-sections/registry';

// ---------------------------------------------------------------------------
// Fixtures
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

function makeUser(overrides: Record<string, unknown> = {}) {
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
    timezone: 'Europe/London',
    location: 'London',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ProfilePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetAccountSectionRegistryForTests();
  });

  it('declares its own page metadata', () => {
    expect(metadata.title).toBe('Profile');
  });

  it('clears the session and redirects when there is no session', async () => {
    vi.mocked(getServerSession).mockResolvedValue(null);

    await expect(ProfilePage()).rejects.toThrow('NEXT_REDIRECT');
    expect(clearInvalidSession).toHaveBeenCalledWith('/profile');
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('clears the session when the session user no longer exists', async () => {
    vi.mocked(getServerSession).mockResolvedValue(MOCK_SESSION);
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null);

    await expect(ProfilePage()).rejects.toThrow('NEXT_REDIRECT');
    expect(clearInvalidSession).toHaveBeenCalledWith('/profile');
  });

  it('renders the profile identity, role and verified badge', async () => {
    vi.mocked(getServerSession).mockResolvedValue(MOCK_SESSION);
    vi.mocked(prisma.user.findUnique).mockResolvedValue(makeUser() as never);

    render(await ProfilePage());

    expect(screen.getByRole('heading', { name: 'Alice Example' })).toBeInTheDocument();
    expect(screen.getAllByText('alice@example.com').length).toBeGreaterThan(0);
    expect(screen.getByText('USER')).toBeInTheDocument();
    expect(screen.getByText('Verified')).toBeInTheDocument();
    expect(screen.getByText('Hello world')).toBeInTheDocument();
  });

  it('omits the About block when no bio is set', async () => {
    vi.mocked(getServerSession).mockResolvedValue(MOCK_SESSION);
    vi.mocked(prisma.user.findUnique).mockResolvedValue(makeUser({ bio: null }) as never);

    render(await ProfilePage());

    expect(screen.queryByRole('heading', { name: 'About' })).not.toBeInTheDocument();
  });

  it('formats the timezone for display and falls back to UTC when unset', async () => {
    vi.mocked(getServerSession).mockResolvedValue(MOCK_SESSION);
    vi.mocked(prisma.user.findUnique).mockResolvedValue(
      makeUser({ timezone: 'America/New_York' }) as never
    );
    const { unmount } = render(await ProfilePage());
    expect(screen.getByText('America / New York')).toBeInTheDocument();
    unmount();

    vi.mocked(prisma.user.findUnique).mockResolvedValue(makeUser({ timezone: null }) as never);
    render(await ProfilePage());
    expect(screen.getByText('UTC')).toBeInTheDocument();
  });

  describe('account sections (#595)', () => {
    it('renders nothing extra when no fork has registered a section', async () => {
      vi.mocked(getServerSession).mockResolvedValue(MOCK_SESSION);
      vi.mocked(prisma.user.findUnique).mockResolvedValue(makeUser() as never);

      render(await ProfilePage());

      expect(screen.queryByTestId('app-section')).not.toBeInTheDocument();
    });

    it('renders a registered section, and hands it the signed-in user id', async () => {
      // The seam is only worth anything if the SLOT is on the page. Registry
      // unit tests cannot see a missing `<AccountSections/>` in page.tsx.
      vi.mocked(initAppAccountSections).mockImplementation(() =>
        registerAccountSection({
          id: 'github-connect',
          Component: ({ userId }: AccountSectionProps) => (
            <div data-testid="app-section" data-user-id={userId} />
          ),
        })
      );
      vi.mocked(getServerSession).mockResolvedValue(MOCK_SESSION);
      vi.mocked(prisma.user.findUnique).mockResolvedValue(makeUser() as never);

      render(await ProfilePage());

      expect(screen.getByTestId('app-section')).toHaveAttribute('data-user-id', 'user_abc');
    });
  });
});
