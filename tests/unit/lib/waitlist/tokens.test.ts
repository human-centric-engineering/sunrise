/**
 * Unit tests: the waitlist's confirm and leave tokens (§125 t-977).
 *
 * The confirm token is the invitation pattern (hash stored, raw token only in
 * the email, identifier names the entry, not the address); the leave token is
 * HMAC-signed with a scheme tag, so another scheme's token signed with the
 * same secret does not verify here.
 *
 * @see lib/waitlist/tokens.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHash } from 'node:crypto';

const { mockTx, mockPrisma } = vi.hoisted(() => {
  const mockTx = { verification: { deleteMany: vi.fn(), create: vi.fn() } };
  return {
    mockTx,
    mockPrisma: {
      verification: { findMany: vi.fn() },
      $transaction: vi.fn(async (fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx)),
    },
  };
});

vi.mock('@/lib/db/client', () => ({ prisma: mockPrisma }));

import {
  confirmUrl,
  deleteConfirmTokens,
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
    mockTx.verification.create.mockResolvedValue({ id: 'v-new' });
  });

  it('stores only the hash, under the entry id, for seven days', async () => {
    // Act
    const { id, token, expiresAt } = await issueConfirmToken('entry-1', NOW);

    // Assert
    expect(id).toBe('v-new');
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(expiresAt.getTime() - NOW.getTime()).toBe(WAITLIST_CONFIRM_TTL_MS);
    const [{ data }] = mockTx.verification.create.mock.calls[0] as [
      { data: { identifier: string; value: string; expiresAt: Date } },
    ];
    expect(data).toEqual({
      identifier: 'waitlist-confirm:entry-1',
      value: sha256(token),
      expiresAt,
    });
    expect(data.value).not.toBe(token);
  });

  it('keeps the entry’s live links and clears only its expired ones', async () => {
    // A re-send must not kill the link already in the inbox: a failed send,
    // or a stranger resubmitting the address, would otherwise break it.
    await issueConfirmToken('entry-1', NOW);

    expect(mockTx.verification.deleteMany).toHaveBeenCalledOnce();
    expect(mockTx.verification.deleteMany).toHaveBeenCalledWith({
      where: { identifier: 'waitlist-confirm:entry-1', expiresAt: { lte: NOW } },
    });
  });
});

describe('findConfirmToken', () => {
  it('matches the raw token against the stored hash, among current rows only', async () => {
    mockPrisma.verification.findMany.mockResolvedValue([{ id: 'v1', value: sha256('right') }]);

    expect(await findConfirmToken('entry-1', 'right', NOW)).toEqual({
      id: 'v1',
      value: sha256('right'),
    });
    expect(mockPrisma.verification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { identifier: 'waitlist-confirm:entry-1', expiresAt: { gt: NOW } },
      })
    );
  });

  it('matches an earlier link as well as the newest', async () => {
    mockPrisma.verification.findMany.mockResolvedValue([
      { id: 'v-old', value: sha256('first') },
      { id: 'v-new', value: sha256('second') },
    ]);

    expect(await findConfirmToken('entry-1', 'first', NOW)).toEqual({
      id: 'v-old',
      value: sha256('first'),
    });
    expect(await findConfirmToken('entry-1', 'second', NOW)).toEqual({
      id: 'v-new',
      value: sha256('second'),
    });
  });

  it('is null for a wrong token, and for none stored (used, expired or never issued)', async () => {
    mockPrisma.verification.findMany.mockResolvedValue([{ id: 'v1', value: sha256('right') }]);
    expect(await findConfirmToken('entry-1', 'wrong', NOW)).toBeNull();

    mockPrisma.verification.findMany.mockResolvedValue([]);
    expect(await findConfirmToken('entry-1', 'right', NOW)).toBeNull();
  });
});

describe('deleteConfirmTokens', () => {
  it('deletes the entries’ tokens by identifier, in chunks of a thousand', async () => {
    const ids = Array.from({ length: 1001 }, (_, i) => `e${i}`);

    await deleteConfirmTokens(mockTx as never, ids);

    const calls = mockTx.verification.deleteMany.mock.calls.map(
      (c) => (c[0] as { where: { identifier: { in: string[] } } }).where.identifier.in
    );
    expect(calls.map((c) => c.length)).toEqual([1000, 1]);
    expect(calls[0][0]).toBe('waitlist-confirm:e0');
    expect(calls[1][0]).toBe('waitlist-confirm:e1000');
  });

  it('makes no call for no entries', async () => {
    await deleteConfirmTokens(mockTx as never, []);

    expect(mockTx.verification.deleteMany).not.toHaveBeenCalled();
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
