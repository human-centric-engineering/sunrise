/**
 * Unit Test: invite_only gates in lib/auth/config.ts
 *
 * Two layers, because account creation arrives by several paths:
 *
 * - `signupModeBeforeHook` — better-auth's `hooks.before`, covering
 *   POST /api/auth/sign-up/email.
 * - `userCreateBeforeHook` — the default-deny backstop every user insert
 *   passes through. It must NOT key off the endpoint path: a Google signup
 *   arrives via /callback/:id, an ID-token sign-in via /sign-in/social, and a
 *   plugin a fork enables later via something else again.
 *
 * The seam module itself (`isInviteOnly` / `isInvitedSignup` /
 * `isFirstHumanBootstrap`) is mocked here and tested for real in
 * tests/unit/lib/auth/signup-mode.test.ts — this file pins the branching.
 *
 * Per gotcha #13 — importing @/lib/auth/config triggers betterAuth({...}) +
 * validateEmailConfig() at module load, so every side-effect surface is mocked
 * before the import.
 *
 * @see lib/auth/config.ts
 * @see lib/auth/signup-mode.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockEnv = vi.hoisted(() => ({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
  BETTER_AUTH_SECRET: 'x'.repeat(32),
  BETTER_AUTH_URL: 'http://localhost:3000',
  RESEND_API_KEY: 'test-resend-key',
  EMAIL_FROM: 'test@example.com',
  NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
  GOOGLE_CLIENT_ID: '',
  GOOGLE_CLIENT_SECRET: '',
  REQUIRE_EMAIL_VERIFICATION: undefined as boolean | undefined,
  SIGNUP_MODE: 'open',
}));

vi.mock('@/lib/env', () => ({ env: mockEnv }));

vi.mock('@/lib/auth/signup-mode', () => ({
  isInviteOnly: vi.fn(() => false),
  isInvitedSignup: vi.fn(() => false),
  invitedSignupInvitation: vi.fn(() => null),
  isFirstHumanBootstrap: vi.fn(async () => false),
  runInvitedSignup: vi.fn(<T>(fn: () => Promise<T>) => fn()),
}));

vi.mock('better-auth', () => ({
  betterAuth: vi.fn((cfg: unknown) => ({
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
  createAuthMiddleware: vi.fn((fn: unknown) => fn),
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

vi.mock('@/lib/email/send', () => ({ sendEmail: vi.fn() }));

vi.mock('@/lib/utils/invitation-token', () => ({
  validateInvitationToken: vi.fn(),
  deleteInvitationToken: vi.fn(),
  getValidInvitation: vi.fn(),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    user: { update: vi.fn(), findFirst: vi.fn(), count: vi.fn(async () => 1) },
    account: { findFirst: vi.fn() },
    verification: { findFirst: vi.fn() },
    authBootstrap: { findUnique: vi.fn(async () => ({ id: 'singleton' })), upsert: vi.fn() },
  },
}));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

vi.mock('@/emails/welcome', () => ({ default: vi.fn(() => null) }));
vi.mock('@/emails/verify-email', () => ({ default: vi.fn(() => null) }));
vi.mock('@/emails/reset-password', () => ({ default: vi.fn(() => null) }));

import { signupModeBeforeHook, userCreateBeforeHook } from '@/lib/auth/config';
import { isInviteOnly, isInvitedSignup, isFirstHumanBootstrap } from '@/lib/auth/signup-mode';
import { getOAuthState } from 'better-auth/api';
import { validateInvitationToken, getValidInvitation } from '@/lib/utils/invitation-token';

// Loosely-typed handles for the better-auth / invitation mocks, matching the
// MockedFn pattern in config-database-hook.test.ts: the real signatures demand
// full OAuthState and invitation-metadata objects whose extra fields play no
// part in the branch under test.
type MockedFn = ReturnType<typeof vi.fn>;
const mockGetOAuthState = getOAuthState as unknown as MockedFn;
const mockValidateInvitationToken = validateInvitationToken as unknown as MockedFn;
const mockGetValidInvitation = getValidInvitation as unknown as MockedFn;

const OAUTH_CTX = { path: '/callback/google' };

function oauthUser(email = 'new@example.com') {
  return {
    id: 'user_1',
    createdAt: new Date(),
    updatedAt: new Date(),
    email,
    emailVerified: true,
    name: 'New User',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isInviteOnly).mockReturnValue(false);
  vi.mocked(isInvitedSignup).mockReturnValue(false);
  vi.mocked(isFirstHumanBootstrap).mockResolvedValue(false);
  mockGetOAuthState.mockResolvedValue(null);
});

describe('signupModeBeforeHook', () => {
  it('allows public signup in the default open mode', async () => {
    await expect(signupModeBeforeHook({ path: '/sign-up/email' })).resolves.toBeUndefined();
    expect(isFirstHumanBootstrap).not.toHaveBeenCalled();
  });

  it('refuses public email/password signup under invite_only', async () => {
    vi.mocked(isInviteOnly).mockReturnValue(true);

    await expect(signupModeBeforeHook({ path: '/sign-up/email' })).rejects.toThrow(
      'Sign-up is by invitation only.'
    );
  });

  it('refuses with FORBIDDEN, not a 500', async () => {
    vi.mocked(isInviteOnly).mockReturnValue(true);

    await expect(signupModeBeforeHook({ path: '/sign-up/email' })).rejects.toMatchObject({
      status: 'FORBIDDEN',
    });
  });

  it('leaves every other endpoint alone under invite_only', async () => {
    vi.mocked(isInviteOnly).mockReturnValue(true);

    // Sign-in, password reset and the rest must keep working — invite_only
    // closes account creation, not the whole auth surface.
    await expect(signupModeBeforeHook({ path: '/sign-in/email' })).resolves.toBeUndefined();
    await expect(signupModeBeforeHook({ path: '/forget-password' })).resolves.toBeUndefined();
    await expect(signupModeBeforeHook({ path: undefined })).resolves.toBeUndefined();
  });

  it('exempts an invitation-authorised signup', async () => {
    // accept-invite calls auth.api.signUpEmail, which reaches this hook with
    // ctx.path === '/sign-up/email'. Without the exemption, invite_only would
    // refuse the invitation flow it exists to serve.
    vi.mocked(isInviteOnly).mockReturnValue(true);
    vi.mocked(isInvitedSignup).mockReturnValue(true);

    await expect(signupModeBeforeHook({ path: '/sign-up/email' })).resolves.toBeUndefined();
  });

  it('admits the first human on an empty database', async () => {
    vi.mocked(isInviteOnly).mockReturnValue(true);
    vi.mocked(isFirstHumanBootstrap).mockResolvedValue(true);

    await expect(signupModeBeforeHook({ path: '/sign-up/email' })).resolves.toBeUndefined();
  });

  it('closes again once the bootstrap window has passed', async () => {
    vi.mocked(isInviteOnly).mockReturnValue(true);
    vi.mocked(isFirstHumanBootstrap).mockResolvedValue(false);

    await expect(signupModeBeforeHook({ path: '/sign-up/email' })).rejects.toThrow(
      'Sign-up is by invitation only.'
    );
  });
});

describe('userCreateBeforeHook — invite_only creation gate', () => {
  it('allows an un-invited OAuth signup in open mode', async () => {
    const result = await userCreateBeforeHook(oauthUser(), OAUTH_CTX);

    expect(result.data.email).toBe('new@example.com');
  });

  it('refuses an un-invited OAuth signup under invite_only', async () => {
    // Without this branch a fork running invite_only still accumulates
    // self-created accounts through the Google button.
    vi.mocked(isInviteOnly).mockReturnValue(true);

    await expect(userCreateBeforeHook(oauthUser(), OAUTH_CTX)).rejects.toThrow(
      'Sign-up is by invitation only.'
    );
  });

  it('refuses with FORBIDDEN', async () => {
    vi.mocked(isInviteOnly).mockReturnValue(true);

    await expect(userCreateBeforeHook(oauthUser(), OAUTH_CTX)).rejects.toMatchObject({
      status: 'FORBIDDEN',
    });
  });

  it('admits an invited OAuth signup and honours the invitation role', async () => {
    vi.mocked(isInviteOnly).mockReturnValue(true);
    mockGetOAuthState.mockResolvedValue({
      invitationEmail: 'invited@example.com',
      invitationToken: 'token-abc',
    });
    mockValidateInvitationToken.mockResolvedValue(true);
    mockGetValidInvitation.mockResolvedValue({ metadata: { role: 'USER' } });

    const result = await userCreateBeforeHook(oauthUser('invited@example.com'), OAUTH_CTX);

    expect(result.data.role).toBe('USER');
  });

  it('admits a valid token whose invitation record does not parse', async () => {
    // A valid token with no usable record falls through to the bootstrap block.
    // The gate keys off the authorisation itself, not the record, so this
    // genuinely-invited account is not refused on the way past.
    vi.mocked(isInviteOnly).mockReturnValue(true);
    mockGetOAuthState.mockResolvedValue({
      invitationEmail: 'invited@example.com',
      invitationToken: 'token-abc',
    });
    mockValidateInvitationToken.mockResolvedValue(true);
    mockGetValidInvitation.mockResolvedValue(null);

    const result = await userCreateBeforeHook(oauthUser('invited@example.com'), OAUTH_CTX);

    expect(result.data.email).toBe('invited@example.com');
  });

  it('refuses an OAuth signup whose invitation token is invalid', async () => {
    vi.mocked(isInviteOnly).mockReturnValue(true);
    mockGetOAuthState.mockResolvedValue({
      invitationEmail: 'invited@example.com',
      invitationToken: 'stale-token',
    });
    mockValidateInvitationToken.mockResolvedValue(false);

    await expect(userCreateBeforeHook(oauthUser('invited@example.com'), OAUTH_CTX)).rejects.toThrow(
      'Sign-up is by invitation only.'
    );
  });

  it('admits the first human on an empty database', async () => {
    vi.mocked(isInviteOnly).mockReturnValue(true);
    vi.mocked(isFirstHumanBootstrap).mockResolvedValue(true);

    const result = await userCreateBeforeHook(oauthUser(), OAUTH_CTX);

    expect(result.data.email).toBe('new@example.com');
  });

  it('refuses ID-token social sign-in, which is not a /callback/ path', async () => {
    // better-auth also creates accounts from POST /sign-in/social with an
    // idToken. It is a distinct endpoint path, so the gate must not key off
    // '/callback/' — this is the path that slipped through the first version.
    vi.mocked(isInviteOnly).mockReturnValue(true);

    await expect(userCreateBeforeHook(oauthUser(), { path: '/sign-in/social' })).rejects.toThrow(
      'Sign-up is by invitation only.'
    );
  });

  it('refuses an unrecognised creation path, rather than defaulting to allow', async () => {
    // Default-deny: a plugin a fork enables later (magic-link, email-OTP,
    // passkey) must be refused by default rather than silently admitted.
    vi.mocked(isInviteOnly).mockReturnValue(true);

    await expect(
      userCreateBeforeHook(oauthUser(), { path: '/some-future-plugin/sign-up' })
    ).rejects.toThrow('Sign-up is by invitation only.');
  });

  it('refuses email/password creation reaching this hook, as defence in depth', async () => {
    // signupModeBeforeHook already closed /sign-up/email; this hook refusing it
    // too means a gap there cannot silently become an open door here.
    vi.mocked(isInviteOnly).mockReturnValue(true);

    await expect(userCreateBeforeHook(oauthUser(), null)).rejects.toThrow(
      'Sign-up is by invitation only.'
    );
  });

  it('exempts an invitation-authorised signup regardless of path', async () => {
    // accept-invite runs inside runInvitedSignup() and creates its user with a
    // null context — the exemption must not depend on the path either.
    vi.mocked(isInviteOnly).mockReturnValue(true);
    vi.mocked(isInvitedSignup).mockReturnValue(true);

    const result = await userCreateBeforeHook(oauthUser('invited@example.com'), null);

    expect(result.data.email).toBe('invited@example.com');
  });
});
