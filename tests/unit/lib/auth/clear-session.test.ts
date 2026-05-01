/**
 * Unit Tests: clearInvalidSession
 *
 * Tests the utility function that redirects to the clear-session endpoint
 * when an invalid session is detected (user deleted, session expired, etc.).
 * The redirect endpoint handles actual cookie deletion; this function only
 * builds the target URL and triggers the redirect.
 *
 * Test Coverage:
 * - Happy path: redirects to /api/auth/clear-session with provided returnUrl
 * - Default returnUrl: uses '/' when no argument is given
 * - URL encoding: special characters in returnUrl are encoded correctly
 * - Return type: function always redirects (never returns normally)
 *
 * Contract note: clearInvalidSession does NOT touch cookies, sessions, or
 * logging — it delegates all of that to the /api/auth/clear-session route
 * handler. Tests are intentionally scoped to the redirect URL contract only.
 *
 * @see lib/auth/clear-session.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { clearInvalidSession } from '@/lib/auth/clear-session';

/**
 * Mock next/navigation — redirect() throws in Next.js to signal a redirect
 * (NEXT_REDIRECT error), so we reproduce that behaviour in tests.
 */
vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT: ${url}`);
  }),
}));

import { redirect } from 'next/navigation';

describe('clearInvalidSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('redirect target URL', () => {
    it('should redirect to /api/auth/clear-session with the provided returnUrl encoded', () => {
      // Arrange: a simple dashboard path
      const returnUrl = '/dashboard';

      // Act + Assert: redirect always throws NEXT_REDIRECT
      expect(() => clearInvalidSession(returnUrl)).toThrow(
        `NEXT_REDIRECT: /api/auth/clear-session?returnUrl=${encodeURIComponent(returnUrl)}`
      );

      // Verify redirect was called with the exact URL
      expect(vi.mocked(redirect)).toHaveBeenCalledWith(
        `/api/auth/clear-session?returnUrl=${encodeURIComponent(returnUrl)}`
      );
      expect(vi.mocked(redirect)).toHaveBeenCalledTimes(1);
    });

    it('should redirect to /api/auth/clear-session?returnUrl=%2F when no argument is given', () => {
      // Arrange: no returnUrl — default is '/'
      // The default '/' encodes to '%2F'

      // Act + Assert
      expect(() => clearInvalidSession()).toThrow(
        `NEXT_REDIRECT: /api/auth/clear-session?returnUrl=${encodeURIComponent('/')}`
      );

      expect(vi.mocked(redirect)).toHaveBeenCalledWith(
        `/api/auth/clear-session?returnUrl=${encodeURIComponent('/')}`
      );
    });

    it('should percent-encode special characters in the returnUrl', () => {
      // Arrange: path with query string and slashes — these must be encoded so the
      // clear-session handler can forward the user back to the exact original page
      const returnUrl = '/search?q=hello world&page=2';

      // Act + Assert
      expect(() => clearInvalidSession(returnUrl)).toThrow(
        `NEXT_REDIRECT: /api/auth/clear-session?returnUrl=${encodeURIComponent(returnUrl)}`
      );

      expect(vi.mocked(redirect)).toHaveBeenCalledWith(
        `/api/auth/clear-session?returnUrl=${encodeURIComponent(returnUrl)}`
      );
    });

    it('should use /api/auth/clear-session as the fixed endpoint regardless of returnUrl', () => {
      // Arrange: a deeply nested path to confirm the base URL never changes
      const returnUrl = '/admin/orchestration/agents/abc-123';

      // Act
      expect(() => clearInvalidSession(returnUrl)).toThrow(/^NEXT_REDIRECT: /);

      // Assert: only one redirect call, always targeting /api/auth/clear-session
      expect(vi.mocked(redirect)).toHaveBeenCalledTimes(1);
      const [calledUrl] = vi.mocked(redirect).mock.calls[0];
      expect(calledUrl).toMatch(/^\/api\/auth\/clear-session\?returnUrl=/);
      expect(calledUrl).toContain(encodeURIComponent(returnUrl));
    });
  });
});
