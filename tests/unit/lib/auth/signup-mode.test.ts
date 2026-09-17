/**
 * Unit Test: Signup mode seam (lib/auth/signup-mode.ts)
 *
 * The switch that lets a fork run invite-only. Three surfaces:
 *
 * 1. `isInviteOnly()` — reads SIGNUP_MODE.
 * 2. `runInvitedSignup()` / `isInvitedSignup()` — the AsyncLocalStorage
 *    exemption that keeps `accept-invite` working under invite_only. The
 *    tests below pin the properties that make it safe: it does not leak to
 *    sibling work, and it survives an await boundary (the real caller awaits
 *    `auth.api.signUpEmail` inside it).
 * 3. `isFirstHumanBootstrap()` — the empty-database escape, which must fail
 *    CLOSED because it authorises account creation.
 *
 * @see lib/auth/signup-mode.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted so the mock factory can close over it — this file imports the module
// under test statically, which resolves before a plain `const` would initialise.
const mockEnv = vi.hoisted(() => ({
  SIGNUP_MODE: 'open',
}));

vi.mock('@/lib/env', () => ({
  env: mockEnv,
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    authBootstrap: { findUnique: vi.fn() },
    user: { count: vi.fn() },
  },
}));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import {
  isInviteOnly,
  runInvitedSignup,
  isInvitedSignup,
  invitedSignupInvitation,
  isFirstHumanBootstrap,
} from '@/lib/auth/signup-mode';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { AUTH_BOOTSTRAP_ID } from '@/lib/auth/constants';

beforeEach(() => {
  vi.clearAllMocks();
  mockEnv.SIGNUP_MODE = 'open';
});

describe('isInviteOnly', () => {
  it('is false in the default open mode', () => {
    expect(isInviteOnly()).toBe(false);
  });

  it('is true when SIGNUP_MODE is invite_only', () => {
    mockEnv.SIGNUP_MODE = 'invite_only';

    expect(isInviteOnly()).toBe(true);
  });
});

describe('runInvitedSignup / isInvitedSignup', () => {
  it('reports no invited context by default', () => {
    expect(isInvitedSignup()).toBe(false);
  });

  it('marks the context inside the callback', async () => {
    const seen = await runInvitedSignup(async () => isInvitedSignup());

    expect(seen).toBe(true);
  });

  it('survives an await boundary inside the callback', async () => {
    // The real caller awaits auth.api.signUpEmail() inside this wrapper, so the
    // exemption is worthless if it does not outlive a suspension point.
    const seen = await runInvitedSignup(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
      return isInvitedSignup();
    });

    expect(seen).toBe(true);
  });

  it('does not leak the exemption after the callback resolves', async () => {
    await runInvitedSignup(async () => true);

    expect(isInvitedSignup()).toBe(false);
  });

  it('does not leak the exemption when the callback throws', async () => {
    await expect(
      runInvitedSignup(async () => {
        throw new Error('signup failed');
      })
    ).rejects.toThrow('signup failed');

    // A failed invited signup must not leave the gate open for the next caller.
    expect(isInvitedSignup()).toBe(false);
  });

  it('does not leak into concurrent unwrapped work', async () => {
    // Two signups in flight on the same process: only the invited one is exempt.
    const [invited, unwrapped] = await Promise.all([
      runInvitedSignup(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return isInvitedSignup();
      }),
      (async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return isInvitedSignup();
      })(),
    ]);

    expect(invited).toBe(true);
    expect(unwrapped).toBe(false);
  });

  it('returns the callback result to the caller', async () => {
    // accept-invite reads the created user's id off this return value.
    const result = await runInvitedSignup(async () => ({ user: { id: 'user_123' } }));

    expect(result).toEqual({ user: { id: 'user_123' } });
  });

  it('carries the invitation it was given to the hooks inside (§106)', async () => {
    const metadata = {
      name: 'Invitee',
      role: 'ADMIN',
      invitedBy: 'admin-id',
      invitedAt: '2026-09-17T00:00:00.000Z',
      orgId: 'cmorg000000000000000other',
    };

    const seen = await runInvitedSignup(async () => invitedSignupInvitation(), metadata);

    expect(seen).toEqual(metadata);
    // The exemption itself is unchanged by the payload.
    expect(await runInvitedSignup(async () => isInvitedSignup(), metadata)).toBe(true);
  });

  it('answers null for the invitation outside a wrapped signup, and when none was passed', async () => {
    expect(invitedSignupInvitation()).toBeNull();
    // Wrapped without a payload — the exemption holds, the invitation is null.
    expect(await runInvitedSignup(async () => invitedSignupInvitation())).toBeNull();
    expect(await runInvitedSignup(async () => isInvitedSignup())).toBe(true);
  });
});

describe('isFirstHumanBootstrap', () => {
  it('is true when the marker is absent and no human exists', async () => {
    vi.mocked(prisma.authBootstrap.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.user.count).mockResolvedValue(0);

    expect(await isFirstHumanBootstrap()).toBe(true);
  });

  it('counts only human users, so the seeded SERVICE account does not close the window', async () => {
    vi.mocked(prisma.authBootstrap.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.user.count).mockResolvedValue(0);

    await isFirstHumanBootstrap();

    expect(prisma.user.count).toHaveBeenCalledWith({ where: { accountType: 'HUMAN' } });
  });

  it('is false once a human exists', async () => {
    vi.mocked(prisma.authBootstrap.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.user.count).mockResolvedValue(1);

    expect(await isFirstHumanBootstrap()).toBe(false);
  });

  it('is false when the bootstrap marker is present, without counting users', async () => {
    // The marker is what makes the window close permanently — it must win even
    // if every human is later deleted and the count returns to zero (#278).
    vi.mocked(prisma.authBootstrap.findUnique).mockResolvedValue({
      id: AUTH_BOOTSTRAP_ID,
      completedAt: new Date(),
    });
    vi.mocked(prisma.user.count).mockResolvedValue(0);

    expect(await isFirstHumanBootstrap()).toBe(false);
    expect(prisma.user.count).not.toHaveBeenCalled();
  });

  it('fails closed when the marker lookup throws', async () => {
    vi.mocked(prisma.authBootstrap.findUnique).mockRejectedValue(new Error('db down'));

    expect(await isFirstHumanBootstrap()).toBe(false);
    expect(logger.error).toHaveBeenCalled();
  });

  it('fails closed when the user count throws', async () => {
    vi.mocked(prisma.authBootstrap.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.user.count).mockRejectedValue(new Error('db down'));

    // Unlike the role bootstrap (a convenience that fails open), this call
    // authorises account creation: a DB fault must refuse, not admit.
    expect(await isFirstHumanBootstrap()).toBe(false);
    expect(logger.error).toHaveBeenCalled();
  });
});
