/**
 * Tests: `sessionCreateBeforeHook` — which org a new session starts in
 *
 * Two inputs, both mocked at their module boundary: the pending-signup
 * carrier (`lib/auth/pending-signup.ts`) and `activeOrgForSession`
 * (`lib/tenancy/membership.ts`, whose own arms have their own test). What
 * this file pins is the hook's ORDER and its failure shape:
 *
 * - a signup in flight wins, and the hook then reads no memberships at all —
 *   because on an auto-signed-in signup this hook runs before the after hook
 *   has written anything, and reading would find nothing and self-heal the
 *   wrong org;
 * - otherwise the membership read decides, and a self-heal is logged at
 *   `error` (the operator's signal that the signup path failed);
 * - a fault never refuses the sign-in: the session is minted with a null org.
 *
 * Per gotcha #13 — importing @/lib/auth/config triggers betterAuth({...}) +
 * validateEmailConfig() at module load, so every side-effect surface is mocked
 * before the import.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { ORG_OWNER_ROLE } from '@/lib/tenancy/roles';

const mockEnv = vi.hoisted(() => ({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
  BETTER_AUTH_SECRET: 'x'.repeat(32),
  BETTER_AUTH_URL: 'http://localhost:3000',
  NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
  EMAIL_FROM: 'test@example.com',
  SIGNUP_MODE: 'open',
}));
vi.mock('@/lib/env', () => ({
  env: mockEnv,
  isProduction: () => false,
  isDevelopment: () => false,
  isTest: () => true,
}));
vi.mock('better-auth', () => ({
  betterAuth: vi.fn(() => ({ api: { getSession: vi.fn() }, handler: vi.fn() })),
}));
vi.mock('better-auth/adapters/prisma', () => ({ prismaAdapter: vi.fn(() => ({})) }));
vi.mock('better-auth/api', () => ({
  getOAuthState: vi.fn(),
  createAuthMiddleware: vi.fn((fn: unknown) => fn),
  APIError: class APIError extends Error {},
}));
vi.mock('@/lib/db/client', () => ({ prisma: {} }));
vi.mock('@/lib/email/send', () => ({ sendEmail: vi.fn() }));
vi.mock('@/lib/email/client', () => ({ validateEmailConfig: vi.fn() }));

const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
}));
vi.mock('@/lib/logging', () => ({ logger: mockLogger }));

const mockGetPendingSignup = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/pending-signup', () => ({
  getPendingSignup: mockGetPendingSignup,
  setPendingSignup: vi.fn(),
}));

const mockActiveOrgForSession = vi.hoisted(() => vi.fn());
vi.mock('@/lib/tenancy/membership', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/tenancy/membership')>();
  return { ...actual, activeOrgForSession: mockActiveOrgForSession };
});

import { sessionCreateBeforeHook, type SessionCreateData } from '@/lib/auth/config';

const USER_ID = 'cmuser00000000000000user1';
const OTHER_ORG = 'cmorg000000000000000other';

function sessionRow(): SessionCreateData {
  return {
    userId: USER_ID,
    token: 'tok',
    expiresAt: new Date(Date.now() + 60_000),
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetPendingSignup.mockResolvedValue(null);
  mockActiveOrgForSession.mockResolvedValue({ orgId: INSTALL_ORG_ID, healed: false });
});

describe('sessionCreateBeforeHook', () => {
  it('a signup in flight decides the org, and the memberships are not read', async () => {
    mockGetPendingSignup.mockResolvedValue({
      membership: { orgId: OTHER_ORG, role: ORG_OWNER_ROLE },
    });

    const result = await sessionCreateBeforeHook(sessionRow(), null);

    expect(result).toEqual({ data: { activeOrgId: OTHER_ORG } });
    expect(mockActiveOrgForSession).not.toHaveBeenCalled();
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  it('otherwise the membership read decides', async () => {
    mockActiveOrgForSession.mockResolvedValue({ orgId: OTHER_ORG, healed: false });

    const result = await sessionCreateBeforeHook(sessionRow(), null);

    expect(result).toEqual({ data: { activeOrgId: OTHER_ORG } });
    expect(mockActiveOrgForSession).toHaveBeenCalledWith(USER_ID);
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  it('logs a self-heal at error, because it means the signup path failed', async () => {
    mockActiveOrgForSession.mockResolvedValue({ orgId: INSTALL_ORG_ID, healed: true });

    const result = await sessionCreateBeforeHook(sessionRow(), null);

    expect(result).toEqual({ data: { activeOrgId: INSTALL_ORG_ID } });
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining('no org membership at sign-in'),
      expect.objectContaining({ userId: USER_ID, orgId: INSTALL_ORG_ID })
    );
  });

  it('never refuses a sign-in: a fault mints the session with a null org', async () => {
    mockActiveOrgForSession.mockRejectedValue(new Error('db down'));

    const result = await sessionCreateBeforeHook(sessionRow(), null);

    expect(result).toEqual({ data: { activeOrgId: null } });
    expect(mockLogger.error).toHaveBeenCalledWith(
      'Failed to choose an active org for a new session',
      expect.any(Error),
      { userId: USER_ID }
    );
  });

  it('returns only the field it decides, so the rest of the row is untouched', async () => {
    // better-auth merges `{ ...row, ...data }`; returning the whole row here
    // would let this hook overwrite a token or expiry it never meant to.
    const result = await sessionCreateBeforeHook(sessionRow(), null);
    expect(Object.keys(result.data)).toEqual(['activeOrgId']);
  });
});
