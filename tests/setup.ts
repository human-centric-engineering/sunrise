/**
 * Global Test Setup
 *
 * This file runs before all tests and sets up:
 * - Testing Library matchers
 * - Global mocks for Next.js modules
 * - Environment variables for testing
 */

/**
 * Set up test environment variables BEFORE any imports
 * This is critical because lib/env.ts validates environment variables at module load time
 */
// Use Object.defineProperty to set read-only NODE_ENV
Object.defineProperty(process.env, 'NODE_ENV', {
  value: 'test',
  writable: true,
  enumerable: true,
  configurable: true,
});
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
process.env.BETTER_AUTH_SECRET = 'test-secret-key-for-testing-only';
process.env.BETTER_AUTH_URL = 'http://localhost:3000';
process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3000';

// Email disabled by default in tests (prevents accidental email sending)
process.env.RESEND_API_KEY = '';
process.env.EMAIL_FROM = 'test@example.com';

import '@testing-library/jest-dom';
import { expect, vi, afterEach } from 'vitest';

/**
 * Mock Next.js navigation hooks
 *
 * These are used frequently in components but need to be mocked for testing.
 */
vi.mock('next/navigation', () => ({
  useRouter: vi.fn(() => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  })),
  usePathname: vi.fn(() => '/'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
  useParams: vi.fn(() => ({})),
  redirect: vi.fn(),
  notFound: vi.fn(),
}));

/**
 * Mock Next.js headers
 *
 * Used in Server Components and API routes
 */
vi.mock('next/headers', () => ({
  cookies: vi.fn(() => ({
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
    has: vi.fn(),
    getAll: vi.fn(() => []),
  })),
  headers: vi.fn(() => new Map()),
}));

/**
 * Mock Analytics Events
 *
 * Analytics hooks require AnalyticsProvider context.
 * We mock them globally to allow component testing without the provider.
 */
vi.mock('@/lib/analytics/events', () => ({
  useAuthAnalytics: vi.fn(() => ({
    trackSignup: vi.fn().mockResolvedValue({ success: true }),
    trackLogin: vi.fn().mockResolvedValue({ success: true }),
    trackLogout: vi.fn().mockResolvedValue({ success: true }),
    identifyUser: vi.fn().mockResolvedValue({ success: true }),
    resetUser: vi.fn().mockResolvedValue({ success: true }),
  })),
  useSettingsAnalytics: vi.fn(() => ({
    trackTabChanged: vi.fn().mockResolvedValue({ success: true }),
    trackProfileUpdated: vi.fn().mockResolvedValue({ success: true }),
    trackPasswordChanged: vi.fn().mockResolvedValue({ success: true }),
    trackPreferencesUpdated: vi.fn().mockResolvedValue({ success: true }),
    trackAvatarUploaded: vi.fn().mockResolvedValue({ success: true }),
    trackAccountDeleted: vi.fn().mockResolvedValue({ success: true }),
  })),
  useFormAnalytics: vi.fn(() => ({
    trackContactFormSubmitted: vi.fn().mockResolvedValue({ success: true }),
    trackInviteAccepted: vi.fn().mockResolvedValue({ success: true }),
    trackPasswordResetRequested: vi.fn().mockResolvedValue({ success: true }),
  })),
  EVENTS: {
    USER_SIGNED_UP: 'user_signed_up',
    USER_LOGGED_IN: 'user_logged_in',
    USER_LOGGED_OUT: 'user_logged_out',
    SETTINGS_TAB_CHANGED: 'settings_tab_changed',
    PROFILE_UPDATED: 'profile_updated',
    PASSWORD_CHANGED: 'password_changed',
    PREFERENCES_UPDATED: 'preferences_updated',
    AVATAR_UPLOADED: 'avatar_uploaded',
    ACCOUNT_DELETED: 'account_deleted',
    CONTACT_FORM_SUBMITTED: 'contact_form_submitted',
    INVITE_ACCEPTED: 'invite_accepted',
    PASSWORD_RESET_REQUESTED: 'password_reset_requested',
  },
}));

/**
 * Clean up after each test
 *
 * Restore all mocks to prevent test interference
 */
afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Extend Vitest matchers with custom assertions
 *
 * Add any custom matchers here if needed
 */
expect.extend({
  // Example custom matcher (can add more as needed):
  // toBeValidCuid(received: string) {
  //   const pass = /^c[a-z0-9]{24}$/i.test(received);
  //   return {
  //     pass,
  //     message: () => `Expected ${received} to be a valid CUID`,
  //   };
  // },
});
