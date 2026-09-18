/**
 * Session revocation (#489)
 *
 * Nothing in this codebase deleted session rows before this — which is what let
 * a stolen session outlive the email change it was used to perform. These cases
 * pin the two shapes that matter: sparing the current session (the
 * `revokeOtherSessions` behaviour better-auth already gives `changePassword`),
 * and revoking everything when the current session cannot be identified.
 *
 * @see lib/auth/sessions.ts · lib/auth/config.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const deleteMany = vi.fn();
const findFirst = vi.fn();

vi.mock('@/lib/db/client', () => ({
  prisma: {
    session: {
      deleteMany: (...args: unknown[]) => deleteMany(...args) as unknown,
      findFirst: (...args: unknown[]) => findFirst(...args) as unknown,
    },
  },
}));

import { revokeUserSessions, findMostRecentSessionToken } from '@/lib/auth/sessions';

describe('revokeUserSessions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    deleteMany.mockResolvedValue({ count: 0 });
  });

  it('spares the current session when its token is given', async () => {
    // Matches `changePassword({ revokeOtherSessions: true })`: the person doing
    // the change stays signed in, everything else does not.
    deleteMany.mockResolvedValue({ count: 2 });

    const revoked = await revokeUserSessions({
      userId: 'user-1',
      exceptSessionToken: 'keep-me',
      reason: 'email_changed',
    });

    expect(deleteMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', token: { not: 'keep-me' } },
    });
    expect(revoked).toBe(2);
  });

  it('revokes every session when the current one cannot be identified', async () => {
    // The safe degradation: signing the user out costs one login, whereas
    // guessing wrong would leave an attacker's session alive.
    deleteMany.mockResolvedValue({ count: 3 });

    await revokeUserSessions({ userId: 'user-1', reason: 'email_changed' });

    expect(deleteMany).toHaveBeenCalledWith({ where: { userId: 'user-1' } });
  });

  it('treats a null token the same as an absent one', async () => {
    // `auth.api.getSession` returns null when there is no session on the
    // request, and that value is passed straight through.
    await revokeUserSessions({
      userId: 'user-1',
      exceptSessionToken: null,
      reason: 'email_changed',
    });

    expect(deleteMany).toHaveBeenCalledWith({ where: { userId: 'user-1' } });
  });

  it('scopes the delete to the one user', async () => {
    // A missing `userId` filter here would sign out the entire install.
    await revokeUserSessions({ userId: 'user-1', reason: 'email_changed' });

    const where = deleteMany.mock.calls[0]?.[0] as { where: { userId?: string } };
    expect(where.where.userId).toBe('user-1');
  });

  it('narrows to the sessions acting in one org when activeOrgId is given (§106)', async () => {
    // A member removed from an org loses the sessions INSIDE it and keeps the
    // rest — without the filter every session of theirs would go.
    deleteMany.mockResolvedValue({ count: 1 });
    const count = await revokeUserSessions({
      userId: 'user-1',
      activeOrgId: 'cmorg000000000000000other',
      reason: 'removed from org',
    });

    expect(count).toBe(1);
    expect(deleteMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', activeOrgId: 'cmorg000000000000000other' },
    });
  });

  it('does not add an org filter when none is given', async () => {
    await revokeUserSessions({ userId: 'user-1', reason: 'email_changed' });
    const where = deleteMany.mock.calls[0]?.[0] as { where: Record<string, unknown> };
    expect(where.where).not.toHaveProperty('activeOrgId');
  });
});

describe('findMostRecentSessionToken', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the newest session for the user', async () => {
    // This is what afterEmailVerificationHook falls back to when getSession
    // can't see a session on the request — the newest row is, in that
    // situation, the one better-auth just minted for this exact flow.
    findFirst.mockResolvedValue({ token: 'newest-token' });

    const token = await findMostRecentSessionToken('user-1');

    expect(token).toBe('newest-token');
    expect(findFirst).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      orderBy: { createdAt: 'desc' },
      select: { token: true },
    });
  });

  it('returns null when the user has no sessions at all', async () => {
    findFirst.mockResolvedValue(null);

    expect(await findMostRecentSessionToken('user-1')).toBeNull();
  });
});
