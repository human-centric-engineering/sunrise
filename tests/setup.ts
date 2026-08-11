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

// Rate-limit middleware disabled by default in tests. Unit and component
// tests exercise route handlers directly, so the project-root middleware
// (`middleware.ts`) doesn't normally run — but `applyRateLimit` is callable
// from any test and respects this flag, so setting it makes any incidental
// invocation a no-op. Tests that specifically exercise the rate-limit
// middleware OR want to verify section-tier behaviour at the route layer
// must clear this in their own `beforeEach` and reset bucket state per test.
process.env.RATE_LIMIT_BYPASS = 'true';

import '@testing-library/jest-dom';
import { expect, vi, afterEach } from 'vitest';

/**
 * Mock Next.js navigation hooks
 *
 * These are used frequently in components but need to be mocked for testing.
 *
 * The router comes from `createMockRouter()` rather than a literal so this
 * default stays complete as `AppRouterInstance` grows. Nothing type-checks a
 * `vi.mock` factory, so an incomplete literal here would not fail the build —
 * it would just hand every component that relies on this default a router
 * missing the new member, silently. That is the majority of the suite.
 *
 * The factory is imported *inside* an async mock factory on purpose:
 * `vi.mock` is hoisted above the import block, so referencing a top-level
 * import here risks a use-before-initialization error. A dynamic import runs
 * when the factory does, which is after module init.
 */
vi.mock('next/navigation', async () => {
  const { createMockRouter } = await import('@/tests/types/mocks');
  return {
    useRouter: vi.fn(() => createMockRouter()),
    usePathname: vi.fn(() => '/'),
    useSearchParams: vi.fn(() => new URLSearchParams()),
    useParams: vi.fn(() => ({})),
    redirect: vi.fn(),
    notFound: vi.fn(),
  };
});

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
 * Mock Analytics
 *
 * Analytics hooks require AnalyticsProvider context.
 * We mock them globally to allow component testing without the provider.
 */
vi.mock('@/lib/analytics', () => ({
  useAnalytics: vi.fn(() => ({
    track: vi.fn().mockResolvedValue({ success: true }),
    identify: vi.fn().mockResolvedValue({ success: true }),
    page: vi.fn().mockResolvedValue({ success: true }),
    reset: vi.fn().mockResolvedValue({ success: true }),
    isReady: true,
    isEnabled: true,
    providerName: 'Console',
  })),
  useFormAnalytics: vi.fn(() => ({
    trackFormSubmitted: vi.fn().mockResolvedValue({ success: true }),
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
  },
}));

/**
 * Mock Analytics Events (for useFormAnalytics and EVENTS constants)
 */
vi.mock('@/lib/analytics/events', () => ({
  useFormAnalytics: vi.fn(() => ({
    trackFormSubmitted: vi.fn().mockResolvedValue({ success: true }),
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
  },
}));

/**
 * Mock API Context (getRouteLogger)
 *
 * Many API routes use getRouteLogger for request-scoped logging.
 * This global mock returns a logger with standard methods.
 */
vi.mock('@/lib/api/context', () => ({
  getRouteLogger: vi.fn(() =>
    Promise.resolve({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      withContext: vi.fn().mockReturnThis(),
    })
  ),
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
