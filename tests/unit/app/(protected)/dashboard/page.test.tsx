// @vitest-environment happy-dom

/**
 * Dashboard Page Tests
 *
 * Tests the protected dashboard Server Component. Modelled on its direct
 * sibling `tests/unit/app/(protected)/profile/page.test.tsx` — same shape
 * (async server component, `getServerSession` + a single Prisma read), so the
 * mocking follows that file rather than inventing a second convention.
 *
 * Test Coverage:
 * - Redirect (via clearInvalidSession) when no session exists
 * - Redirect when the session's user is no longer in the database
 * - Greeting, email and avatar initials
 * - Profile completion arithmetic at both ends and in between
 * - Role badge, including the fallback when `role` is null
 *
 * The page had no test at all before this; it was picked up by the per-file
 * coverage floor when the role sweep touched one line of it, which is the floor
 * doing its job.
 *
 * @see app/(protected)/dashboard/page.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/lib/auth/utils', () => ({ getServerSession: vi.fn() }));

vi.mock('@/lib/auth/clear-session', () => ({
  clearInvalidSession: vi.fn((returnUrl: string) => {
    throw new Error(`NEXT_REDIRECT:${returnUrl}`);
  }),
}));

vi.mock('@/lib/db/client', () => ({ prisma: { user: { findUnique: vi.fn() } } }));

vi.mock('@/lib/auth/verification-status', () => ({
  getVerificationStatus: vi.fn().mockResolvedValue({ status: 'verified' }),
}));

// Stubbed to a marker that renders NO page data. It has its own test, and a
// stub echoing the email would make `getByText(email)` ambiguous — the welcome
// card is the one this file is asserting.
vi.mock('@/components/dashboard/email-status-card', () => ({
  EmailStatusCard: () => <div data-testid="email-card" />,
}));

import DashboardPage from '@/app/(protected)/dashboard/page';
import { getServerSession } from '@/lib/auth/utils';
import { prisma } from '@/lib/db/client';
import { DEFAULT_USER_ROLE, PLATFORM_ADMIN_ROLE } from '@/lib/auth/roles';

const MOCK_SESSION = {
  session: { id: 'session_abc', userId: 'user_abc' },
  user: { id: 'user_abc', name: 'Ada Lovelace', email: 'ada@example.com' },
};

/** A fully-populated user — every profile field set, so completion is 100%. */
function completeUser(overrides: Record<string, unknown> = {}) {
  return {
    id: 'user_abc',
    name: 'Ada Lovelace',
    email: 'ada@example.com',
    emailVerified: true,
    image: 'https://example.com/a.png',
    role: DEFAULT_USER_ROLE,
    bio: 'Mathematician',
    phone: '+44 20 7946 0000',
    timezone: 'Europe/London',
    location: 'London',
    ...overrides,
  };
}

const mockedSession = vi.mocked(getServerSession);
const mockedFindUnique = vi.mocked(prisma.user.findUnique);

/** Render the async server component. */
async function renderPage() {
  render(await DashboardPage());
}

beforeEach(() => {
  vi.clearAllMocks();
  // @ts-expect-error — the mock returns the narrow shape the page reads.
  mockedSession.mockResolvedValue(MOCK_SESSION);
  // @ts-expect-error — as above.
  mockedFindUnique.mockResolvedValue(completeUser());
});

describe('access', () => {
  it('redirects when there is no session', async () => {
    mockedSession.mockResolvedValue(null);
    await expect(renderPage()).rejects.toThrow('NEXT_REDIRECT:/dashboard');
  });

  it('redirects when the session user no longer exists', async () => {
    // A deleted account with a live cookie. The page must not render a
    // half-populated dashboard from the session alone.
    mockedFindUnique.mockResolvedValue(null);
    await expect(renderPage()).rejects.toThrow('NEXT_REDIRECT:/dashboard');
  });
});

describe('rendering', () => {
  it('greets by first name and shows the email', async () => {
    await renderPage();
    expect(screen.getByText('Hello, Ada!')).toBeTruthy();
    expect(screen.getByText('ada@example.com')).toBeTruthy();
  });

  it('builds avatar initials from the first two name parts', async () => {
    await renderPage();
    expect(screen.getByText('AL')).toBeTruthy();
  });

  it('shows the role', async () => {
    // @ts-expect-error — narrow shape.
    mockedFindUnique.mockResolvedValue(completeUser({ role: PLATFORM_ADMIN_ROLE }));
    await renderPage();
    expect(screen.getByText(PLATFORM_ADMIN_ROLE)).toBeTruthy();
  });

  it('falls back to the default role when the column is null', async () => {
    // `role` is nullable in the schema. The badge must name a role rather than
    // rendering empty — the fallback the sweep pointed at the constant.
    // @ts-expect-error — narrow shape.
    mockedFindUnique.mockResolvedValue(completeUser({ role: null }));
    await renderPage();
    expect(screen.getByText(DEFAULT_USER_ROLE)).toBeTruthy();
  });
});

describe('profile completion', () => {
  it('is 100% when every field is set', async () => {
    await renderPage();
    expect(screen.getByText('100%')).toBeTruthy();
    expect(screen.getByText(/7 of 7 fields completed/)).toBeTruthy();
  });

  it('counts only the populated fields', async () => {
    // Four of seven set (name, email, timezone, location) → 57%. Asserting the
    // rounded number rather than the ratio, since that is what a user reads.
    // @ts-expect-error — narrow shape.
    mockedFindUnique.mockResolvedValue(completeUser({ image: null, bio: null, phone: null }));
    await renderPage();
    expect(screen.getByText('57%')).toBeTruthy();
    expect(screen.getByText(/4 of 7 fields completed/)).toBeTruthy();
  });
});
