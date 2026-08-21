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
 * Refuse real network requests.
 *
 * A component that fetches on mount, in a test that hasn't stubbed `fetch`,
 * issues a genuine HTTP request. happy-dom's document URL is
 * `http://localhost:3000`, so a relative path resolves against it and the
 * suite spends the run connecting to a dev server that isn't there —
 * ~470 `ECONNREFUSED ::1:3000` lines per full run before this guard.
 *
 * Nothing failed because of it, but every one of those is a socket opened
 * during a test, and one still in flight when Vitest tears the environment
 * down is the shape of the `EnvironmentTeardownError` reported on #597.
 *
 * **It has to hook here, not `globalThis.fetch`.** happy-dom ships its own
 * fetch implementation (`happy-dom/lib/fetch/`) over `node:http`, and binds
 * its module references at import time — before this file runs. Patching
 * `globalThis.fetch`, or `node:http`'s `request`, intercepts none of it. That
 * is why the traffic was so hard to attribute: it appears in the output with
 * no test name attached, because it lands after the test that caused it.
 *
 * The rejection deliberately matches what happy-dom itself throws for a failed
 * connection — a `DOMException` named `NetworkError` (`happy-dom/lib/fetch/
 * Fetch.js:540`), not a `TypeError` — so a test that asserts on the error shape
 * sees no change. A test that *wants* a response must stub it:
 * `vi.stubGlobal('fetch', vi.fn())`, or mock the module that calls it.
 *
 * Known wart: happy-dom brackets this hook with `startTask()` / `endTask()` and
 * no `try/finally` (same file, ~line 115), so throwing here leaks one async
 * task. Nothing in the suite is affected — vitest tears down with `abort()`,
 * which resets the counters — but a test that awaits
 * `happyDOM.waitUntilComplete()` after a blocked request will hang to the 30s
 * timeout. Returning a `Response` is the only non-throwing exit the interceptor
 * offers, and that would turn a rejection into a success, which is the larger
 * lie.
 */
{
  interface InterceptedRequest {
    request: { url: string; signal?: AbortSignal };
  }
  interface HappyDomFetchSettings {
    interceptor: {
      // happy-dom `await`s the async hook, so a plain `void` return is a valid
      // "carry on with the real request" answer.
      beforeAsyncRequest?: (ctx: InterceptedRequest) => Promise<Response | void> | void;
      beforeSyncRequest?: (ctx: InterceptedRequest) => void;
    } | null;
  }
  const happyDom = (globalThis as { happyDOM?: { settings?: { fetch?: HappyDomFetchSettings } } })
    .happyDOM;

  const blocked = (url: string): DOMException =>
    new DOMException(
      `Blocked a real network request to ${url}. Tests must not reach the ` +
        `network: stub it with vi.stubGlobal('fetch', …), or mock the module ` +
        `that issues it. See tests/setup.ts.`,
      'NetworkError'
    );

  // happy-dom's interceptor signals refusal by throwing; node's rejects. Same
  // error either way, built once, so the two halves cannot drift.
  const refuse = (url: string): never => {
    throw blocked(url);
  };

  // Fail loud if the hook point moves. `settings.fetch.interceptor` is not a
  // stable API across happy-dom majors, and a silently-skipped guard restores
  // ~470 real connections per run with nothing pointing at the cause — the
  // original #597 diagnosis took five attempts precisely because this traffic
  // arrives unattributed.
  //
  // Keyed on the user-agent rather than on `globalThis.happyDOM`, so a rename
  // of that object still trips the check instead of skipping in silence — and
  // rather than on `typeof window`, which fires for ANY DOM environment. That
  // second point is not hypothetical: `jsdom` is a runtime dependency of this
  // repo, so `--environment jsdom` or a per-file `@vitest-environment jsdom`
  // would otherwise fail every affected file with a message blaming a
  // happy-dom upgrade that never happened. A non-happy-dom DOM environment
  // simply gets no guard, which is the status quo for it.
  const isHappyDom =
    typeof navigator !== 'undefined' && /happydom/i.test(navigator.userAgent ?? '');
  if (isHappyDom && !happyDom?.settings?.fetch) {
    throw new Error(
      'tests/setup.ts: happy-dom is the environment but `window.happyDOM.settings.fetch` ' +
        'is missing, so the network guard did not install. The hook point has probably ' +
        'moved in a happy-dom upgrade — re-point it rather than removing this check. ' +
        'See #597.'
    );
  }

  // happy-dom runs this hook BEFORE its own aborted-signal check
  // (`Fetch.js:115` vs `:127`), so refusing unconditionally would pre-empt
  // `AbortError` with `NetworkError` — silently disabling every
  // `if (err.name === 'AbortError') return` branch under test, of which
  // `chat-interface.tsx` and `approval-card.tsx` each have one. Mirror
  // happy-dom's check first so an aborted request still rejects as an abort.
  const refuseUnlessAborted = ({ request }: InterceptedRequest): void => {
    // happy-dom's own `data:` branch sits *after* this hook (`Fetch.js:133`),
    // so an unconditional refusal would block a URI that opens no socket at
    // all. Returning without throwing lets happy-dom resolve it normally.
    if (/^(data|blob):/i.test(request.url)) return;

    if (request.signal?.aborted) {
      throw (
        request.signal.reason ?? new DOMException('signal is aborted without reason', 'AbortError')
      );
    }
    return refuse(request.url);
  };

  if (happyDom?.settings?.fetch) {
    happyDom.settings.fetch.interceptor = {
      beforeAsyncRequest: refuseUnlessAborted,
      beforeSyncRequest: refuseUnlessAborted,
    };
  }

  /**
   * The same refusal for the node environment, which has no interceptor.
   *
   * The hook above is happy-dom's, so it only covers the 479 files that opt
   * into a DOM. Since `vitest.config.ts` defaults to `node`, the other 605 ran
   * against real undici with nothing in the way — the guard did not fail, it
   * simply was not there, which is the quieter half of the same problem it was
   * written for.
   *
   * Patching `globalThis.fetch` is right *here* and wrong for happy-dom, for
   * the reason the comment above gives: happy-dom binds its own fetch at import
   * time and never consults this global. Under node it is the only fetch there
   * is.
   *
   * Rejects rather than throws, because `fetch` never throws synchronously and
   * a test doing `await expect(...).rejects` should see the same shape it saw
   * under happy-dom. `vi.stubGlobal('fetch', …)` still overrides it, which is
   * the documented escape hatch.
   */
  if (!isHappyDom) {
    const realFetch = globalThis.fetch;
    const urlOf = (input: RequestInfo | URL): string => {
      if (typeof input === 'string') return input;
      if (input instanceof URL) return input.href;
      return input.url;
    };

    globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlOf(input);
      // `data:` and `blob:` open no socket; happy-dom resolves them normally,
      // so node must too or the two environments disagree.
      if (/^(data|blob):/i.test(url)) return realFetch(input, init);

      const signal =
        init?.signal ?? (typeof input === 'object' && 'signal' in input ? input.signal : null);
      if (signal?.aborted) {
        // `reason` is `any` and a test may set it to anything; only pass it on
        // when it is throwable, so the rejection is always an Error.
        const reason: unknown = signal.reason;
        return Promise.reject(
          reason instanceof Error
            ? reason
            : new DOMException('signal is aborted without reason', 'AbortError')
        );
      }
      return Promise.reject(blocked(url));
    };
  }
}

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
