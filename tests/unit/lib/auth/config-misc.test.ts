/**
 * Auth Config — Miscellaneous coverage tests
 *
 * Covers two uncovered branches in lib/auth/config.ts that are too narrow
 * to fit cleanly into the existing per-hook test files:
 *
 * 1. `config.advanced.database.generateId()` — returns false (delegates ID
 *    generation to Prisma's @default(cuid())).
 *
 * 2. `config.socialProviders.google.enabled` short-circuit — the `&&` in
 *    `!!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET)` is false when
 *    GOOGLE_CLIENT_ID is set but GOOGLE_CLIENT_SECRET is missing.
 *
 * The module exports `auth` (the betterAuth return value), not the raw config
 * object. We inspect the config via the betterAuth mock's call arguments.
 *
 * Per gotcha #13 — importing @/lib/auth/config triggers betterAuth({...}) +
 * validateEmailConfig() at module load. All side-effect surfaces must be
 * mocked BEFORE importing the module.
 *
 * Per gotcha #14 — we use a mutable env object to test Google enabled state
 * without vi.resetModules() (which would require re-loading all mocks).
 * The module is loaded once per test file; we inspect the betterAuth call arg
 * to verify the computed config values.
 *
 * @see lib/auth/config.ts L440, L477
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mutable env object — captured by vi.mock factory; fields mutated per-test.
// Per gotcha #14 pattern.
// ---------------------------------------------------------------------------

const mockEnv = {
  NODE_ENV: 'test' as 'test' | 'development' | 'production',
  DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
  BETTER_AUTH_SECRET: 'x'.repeat(32),
  BETTER_AUTH_URL: 'http://localhost:3000',
  RESEND_API_KEY: 'test-resend-key',
  EMAIL_FROM: 'test@example.com',
  NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
  GOOGLE_CLIENT_ID: '' as string | undefined,
  GOOGLE_CLIENT_SECRET: '' as string | undefined,
  REQUIRE_EMAIL_VERIFICATION: undefined as boolean | undefined,
};

// ---------------------------------------------------------------------------
// Side-effect mocks — must be declared before the module import.
// See gotcha #13 for why each of these is needed.
// ---------------------------------------------------------------------------

vi.mock('@/lib/env', () => ({
  env: mockEnv,
}));

vi.mock('better-auth', () => ({
  betterAuth: vi.fn((cfg: unknown) => ({
    // Store the raw config arg so tests can inspect it
    _rawConfig: cfg,
    api: { getSession: vi.fn() },
    handler: vi.fn(),
  })),
}));

vi.mock('better-auth/adapters/prisma', () => ({
  prismaAdapter: vi.fn(() => ({})),
}));

vi.mock('better-auth/api', () => ({
  getOAuthState: vi.fn(),
  APIError: class APIError extends Error {
    status: string;
    constructor(status: string, body: { message?: string } = {}) {
      super(body.message ?? status);
      this.name = 'APIError';
      this.status = status;
    }
  },
}));

vi.mock('@/lib/email/client', () => ({
  validateEmailConfig: vi.fn(),
  getResendClient: vi.fn(() => null),
  isEmailEnabled: vi.fn(() => false),
}));

vi.mock('@/lib/email/send', () => ({
  sendEmail: vi.fn(),
}));

vi.mock('@/lib/utils/invitation-token', () => ({
  validateInvitationToken: vi.fn(),
  deleteInvitationToken: vi.fn(),
  getValidInvitation: vi.fn(),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    user: { update: vi.fn(), findFirst: vi.fn() },
    account: { findFirst: vi.fn() },
    verification: { findFirst: vi.fn() },
  },
}));

vi.mock('@/lib/logging', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@/emails/welcome', () => ({
  default: vi.fn(() => null),
}));

vi.mock('@/emails/verify-email', () => ({
  default: vi.fn(() => null),
}));

vi.mock('@/emails/reset-password', () => ({
  default: vi.fn(() => null),
}));

// ---------------------------------------------------------------------------
// Safe to import after mocks are in place.
// The module evaluates betterAuth({...}) at import time — we capture the
// config arg from the mock to inspect computed fields.
// ---------------------------------------------------------------------------

import { betterAuth } from 'better-auth';

beforeEach(() => {
  vi.clearAllMocks();
  mockEnv.GOOGLE_CLIENT_ID = '';
  mockEnv.GOOGLE_CLIENT_SECRET = '';
  mockEnv.REQUIRE_EMAIL_VERIFICATION = undefined;
});

// Helper: extract the raw config object passed to betterAuth({...}) on module load.
// The module loads once; on the first import, betterAuth is called with the full
// config. This helper is called AFTER the import to read the call argument.
type BetterAuthConfigArg = {
  advanced?: { database?: { generateId?: () => unknown } };
  socialProviders?: { google?: { enabled: boolean; clientId: string; clientSecret: string } };
};

function getBetterAuthConfigArg(): BetterAuthConfigArg {
  // betterAuth is called once at module load time.
  // The mock captures the config arg as its first parameter.
  const calls = vi.mocked(betterAuth).mock.calls;
  if (calls.length === 0) {
    throw new Error(
      'betterAuth was not called — ensure @/lib/auth/config has been imported before this helper.'
    );
  }
  return calls[0][0] as BetterAuthConfigArg;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('config.advanced.database.generateId', () => {
  it('returns false to delegate ID generation to Prisma', async () => {
    // Arrange: import the module — betterAuth({...}) executes at load time
    await import('@/lib/auth/config');

    // Act: extract generateId from the captured betterAuth config arg
    const configArg = getBetterAuthConfigArg();
    const generateId = configArg.advanced?.database?.generateId;

    expect(generateId).toBeDefined();
    const result = generateId!();

    // Assert: returning false tells better-auth to let Prisma handle ID creation
    // (see comment at lib/auth/config.ts L468-475)
    expect(result).toBe(false);
  });
});

describe('config.socialProviders.google.enabled', () => {
  it('is false when GOOGLE_CLIENT_ID is set but GOOGLE_CLIENT_SECRET is missing', async () => {
    // Arrange: mutate env BEFORE the module loads (module evaluates config at load time).
    // Since module caching means the module may already be loaded, we use vi.resetModules()
    // here to force a fresh evaluation with the mutated env.
    mockEnv.GOOGLE_CLIENT_ID = 'google-client-id-123';
    mockEnv.GOOGLE_CLIENT_SECRET = '';

    vi.resetModules();
    vi.clearAllMocks();

    // Re-import after resetModules so betterAuth({...}) re-runs with new env
    await import('@/lib/auth/config');
    const configArg = getBetterAuthConfigArg();

    // Assert: !!(truthy && '') === false
    expect(configArg.socialProviders?.google?.enabled).toBe(false);
  });

  it('is true when both GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are set', async () => {
    // Arrange
    mockEnv.GOOGLE_CLIENT_ID = 'google-client-id-123';
    mockEnv.GOOGLE_CLIENT_SECRET = 'google-secret-456';

    vi.resetModules();
    vi.clearAllMocks();

    await import('@/lib/auth/config');
    const configArg = getBetterAuthConfigArg();

    // Assert: !!(truthy && truthy) === true
    expect(configArg.socialProviders?.google?.enabled).toBe(true);
  });
});
