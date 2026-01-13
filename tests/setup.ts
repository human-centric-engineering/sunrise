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
