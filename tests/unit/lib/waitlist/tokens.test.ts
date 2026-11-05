/**
 * Unit tests: the waitlist's confirm and leave tokens (§125 t-977).
 *
 * The confirm token is the invitation pattern (hash stored, raw token only in
 * the email, row keyed to the entry, not the address); the leave token is
 * HMAC-signed with a scheme tag, so another scheme's token signed with the
 * same secret does not verify here.
 *
 * @see lib/waitlist/tokens.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHash } from 'node:crypto';

const { mockTx, mockPrisma } = vi.hoisted(() => {
  const mockTx = { waitlistConfirmToken: { deleteMany: vi.fn(), create: vi.fn() } };
  return {
    mockTx,
    mockPrisma: {
      waitlistConfirmToken: { findMany: vi.fn() },
      $transaction: vi.fn(async (fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx)),
    },
  };
});

vi.mock('@/lib/db/client', () => ({ prisma: mockPrisma }));

import {
  confirmUrl,
  findConfirmToken,
  issueConfirmToken,
  leaveUrl,
  signLeaveToken,
  verifyLeaveToken,
  WAITLIST_CONFIRM_TTL_MS,
} from '@/lib/waitlist/tokens';
import { generateApprovalToken } from '@/lib/orchestration/approval-tokens';

const NOW = new Date('2026-11-04T12:00:00Z');
const sha256 = (t: string) => createHash('sha256').update(t).digest('hex');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('issueConfirmToken', () => {
  beforeEach(() => {
    mockTx.waitlistConfirmToken.create.mockResolvedValue({ id: 'v-new' });
  });

  it('stores only the hash, under the entry id, for seven days', async () => {
    // Act
    const { id, token, expiresAt } = await issueConfirmToken('entry-1', NOW);

    // Assert
    expect(id).toBe('v-new');
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(expiresAt.getTime() - NOW.getTime()).toBe(WAITLIST_CONFIRM_TTL_MS);
    const [{ data }] = mockTx.waitlistConfirmToken.create.mock.calls[0] as [
      { data: { entryId: string; tokenHash: string; expiresAt: Date } },
    ];
    expect(data).toEqual({ entryId: 'entry-1', tokenHash: sha256(token), expiresAt });
    expect(data.tokenHash).not.toBe(token);
  });

  it('keeps the entry’s live links and clears only its expired ones', async () => {
    // A re-send must not kill the link already in the inbox: a failed send,
    // or a stranger resubmitting the address, would otherwise break it.
    await issueConfirmToken('entry-1', NOW);

    expect(mockTx.waitlistConfirmToken.deleteMany).toHaveBeenCalledOnce();
    expect(mockTx.waitlistConfirmToken.deleteMany).toHaveBeenCalledWith({
      where: { entryId: 'entry-1', expiresAt: { lte: NOW } },
    });
  });
});

describe('findConfirmToken', () => {
  it('matches the raw token against the stored hash, among current rows only', async () => {
    mockPrisma.waitlistConfirmToken.findMany.mockResolvedValue([
      { id: 'v1', tokenHash: sha256('right') },
    ]);

    expect(await findConfirmToken('entry-1', 'right', NOW)).toBe('v1');
    expect(mockPrisma.waitlistConfirmToken.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { entryId: 'entry-1', expiresAt: { gt: NOW } } })
    );
  });

  it('matches an earlier link as well as the newest', async () => {
    mockPrisma.waitlistConfirmToken.findMany.mockResolvedValue([
      { id: 'v-old', tokenHash: sha256('first') },
      { id: 'v-new', tokenHash: sha256('second') },
    ]);

    expect(await findConfirmToken('entry-1', 'first', NOW)).toBe('v-old');
    expect(await findConfirmToken('entry-1', 'second', NOW)).toBe('v-new');
  });

  it('is null for a wrong token, and for none stored (used, expired or never issued)', async () => {
    mockPrisma.waitlistConfirmToken.findMany.mockResolvedValue([
      { id: 'v1', tokenHash: sha256('right') },
    ]);
    expect(await findConfirmToken('entry-1', 'wrong', NOW)).toBeNull();

    mockPrisma.waitlistConfirmToken.findMany.mockResolvedValue([]);
    expect(await findConfirmToken('entry-1', 'right', NOW)).toBeNull();
  });
});

describe('leave tokens', () => {
  it('round-trips the entry id', () => {
    expect(verifyLeaveToken(signLeaveToken('entry-1'))).toBe('entry-1');
  });

  it('refuses a token whose payload was changed to name another entry', () => {
    const [, sig] = signLeaveToken('entry-1').split('.');
    const forged = Buffer.from(
      JSON.stringify({ typ: 'waitlist-leave', entryId: 'entry-2' })
    ).toString('base64url');

    expect(verifyLeaveToken(`${forged}.${sig}`)).toBeNull();
  });

  it('refuses an authentic token from another scheme signed with the same secret', () => {
    const { token } = generateApprovalToken('entry-1', 'approve');

    expect(verifyLeaveToken(token)).toBeNull();
  });

  it.each(['', 'no-dot', '.sig', 'a.b', '%%%.%%%'])('refuses %j', (token) => {
    expect(verifyLeaveToken(token)).toBeNull();
  });
});

describe('links', () => {
  it('builds both on the app origin, the leave link signed for the entry', () => {
    const confirm = new URL(confirmUrl('entry-1', 'abc'));
    const leave = new URL(leaveUrl('entry-1'));

    expect(confirm.origin).toBe('http://localhost:3000');
    expect(confirm.pathname).toBe('/waitlist/confirm');
    expect(confirm.searchParams.get('entry')).toBe('entry-1');
    expect(confirm.searchParams.get('token')).toBe('abc');
    expect(leave.pathname).toBe('/waitlist/leave');
    expect(verifyLeaveToken(leave.searchParams.get('token') ?? '')).toBe('entry-1');
  });
});
