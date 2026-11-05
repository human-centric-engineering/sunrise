/**
 * Unit tests: confirming a waitlist address and leaving the list (§125 t-977).
 *
 * The tenancy entry is real (`runAsCredentialLookup` → `resolveCredentialOrg`
 * → `runAsOrg`), so the org each write ran in is asserted, and a suspended
 * org's link is refused the way a suspended org's credentials are. Prisma
 * and the erasure writer are mocked; what reached them is asserted.
 *
 * @see lib/waitlist/confirm.ts · lib/waitlist/entry-org.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { getTenantContext } from '@/lib/tenancy/context';

const { mockTx, mockPrisma, mockErase, seen } = vi.hoisted(() => {
  const mockTx = {
    waitlistConfirmToken: { deleteMany: vi.fn() },
    waitlistEntry: { updateMany: vi.fn() },
  };
  return {
    mockTx,
    mockPrisma: {
      waitlistConfirmToken: { findMany: vi.fn() },
      waitlistEntry: { findUnique: vi.fn() },
      $transaction: vi.fn(async (fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx)),
    },
    mockErase: vi.fn(),
    seen: { sources: [] as Array<string | undefined> },
  };
});

vi.mock('@/lib/db/client', () => ({ prisma: mockPrisma }));
vi.mock('@/lib/waitlist/erase', () => ({ eraseWaitlistEntry: mockErase }));

import { confirmWaitlistEntry, leaveWaitlist } from '@/lib/waitlist/confirm';
import { signLeaveToken } from '@/lib/waitlist/tokens';

const NOW = new Date('2026-11-04T12:00:00Z');
const TOKEN = 'a'.repeat(64);
const HASH = createHash('sha256').update(TOKEN).digest('hex');

beforeEach(() => {
  vi.clearAllMocks();
  seen.sources = [];
  mockPrisma.waitlistConfirmToken.findMany.mockImplementation(async () => {
    seen.sources.push(getTenantContext()?.source);
    return [{ id: 'v1', tokenHash: HASH }];
  });
  mockPrisma.waitlistEntry.findUnique.mockImplementation(async () => {
    seen.sources.push(getTenantContext()?.source);
    return { orgId: INSTALL_ORG_ID, org: { status: 'ACTIVE' } };
  });
  mockTx.waitlistConfirmToken.deleteMany.mockResolvedValue({ count: 1 });
  mockTx.waitlistEntry.updateMany.mockImplementation(async () => {
    seen.sources.push(getTenantContext()?.source);
    return { count: 1 };
  });
  mockErase.mockImplementation(async () => {
    seen.sources.push(getTenantContext()?.source);
    return { receiptId: 'r1', erasedAt: NOW };
  });
});

describe('confirmWaitlistEntry', () => {
  it('uses the token up and confirms the entry, inside the entry’s org', async () => {
    // Act
    const result = await confirmWaitlistEntry('entry-1', TOKEN, NOW);

    // Assert
    expect(result).toBe('confirmed');
    expect(mockTx.waitlistConfirmToken.deleteMany).toHaveBeenCalledWith({ where: { id: 'v1' } });
    expect(mockTx.waitlistEntry.updateMany).toHaveBeenCalledWith({
      where: { id: 'entry-1', confirmedAt: null },
      data: { confirmedAt: NOW },
    });
    // The entry's other links (earlier sends) are used up with it
    expect(mockTx.waitlistConfirmToken.deleteMany).toHaveBeenLastCalledWith({
      where: { entryId: 'entry-1' },
    });
    // The org looked up under the credential-lookup (system) scope; the
    // token, tenant-owned like the entry, checked in the org; written there
    expect(seen.sources).toEqual(['system', 'waitlist-link', 'waitlist-link']);
  });

  it('a wrong, expired or used token is invalid, and nothing of the entry is touched', async () => {
    mockPrisma.waitlistConfirmToken.findMany.mockResolvedValue([]);

    expect(await confirmWaitlistEntry('entry-1', TOKEN, NOW)).toBe('invalid');
    // Only the entry's org was read, to enter it
    expect(mockPrisma.waitlistEntry.findUnique).toHaveBeenCalledWith({
      where: { id: 'entry-1' },
      select: { orgId: true, org: { select: { status: true } } },
    });
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(mockTx.waitlistEntry.updateMany).not.toHaveBeenCalled();
  });

  it('a second click racing the first is invalid: the token is used once', async () => {
    mockTx.waitlistConfirmToken.deleteMany.mockResolvedValue({ count: 0 });

    expect(await confirmWaitlistEntry('entry-1', TOKEN, NOW)).toBe('invalid');
    expect(mockTx.waitlistEntry.updateMany).not.toHaveBeenCalled();
  });

  it('an entry that is gone is invalid, like an unknown token', async () => {
    mockPrisma.waitlistEntry.findUnique.mockResolvedValue(null);

    expect(await confirmWaitlistEntry('entry-1', TOKEN, NOW)).toBe('invalid');
    expect(mockPrisma.waitlistConfirmToken.findMany).not.toHaveBeenCalled();
  });

  it('a suspended org’s link is invalid and confirms nothing', async () => {
    mockPrisma.waitlistEntry.findUnique.mockResolvedValue({
      orgId: 'org-b',
      org: { status: 'SUSPENDED' },
    });

    expect(await confirmWaitlistEntry('entry-1', TOKEN, NOW)).toBe('invalid');
    expect(mockPrisma.waitlistConfirmToken.findMany).not.toHaveBeenCalled();
    expect(mockTx.waitlistEntry.updateMany).not.toHaveBeenCalled();
  });
});

describe('leaveWaitlist', () => {
  it('erases the entry the token names, as the person themselves, inside its org', async () => {
    // Act
    const result = await leaveWaitlist(signLeaveToken('entry-1'));

    // Assert
    expect(result).toBe('left');
    expect(mockErase).toHaveBeenCalledWith({
      entryId: 'entry-1',
      actorUserId: null,
      reason: 'self_service',
    });
    expect(seen.sources).toEqual(['system', 'waitlist-link']);
  });

  it('refuses a token that is not ours, erasing nothing', async () => {
    const forged = `${Buffer.from(JSON.stringify({ typ: 'waitlist-leave', entryId: 'entry-1' })).toString('base64url')}.bad`;

    expect(await leaveWaitlist(forged)).toBe('invalid');
    expect(mockPrisma.waitlistEntry.findUnique).not.toHaveBeenCalled();
    expect(mockErase).not.toHaveBeenCalled();
  });

  it('a second click finds the entry gone and still answers left', async () => {
    mockPrisma.waitlistEntry.findUnique.mockResolvedValue(null);

    expect(await leaveWaitlist(signLeaveToken('entry-1'))).toBe('left');
    expect(mockErase).not.toHaveBeenCalled();
  });

  it('an entry whose org is suspended is unavailable, not left: it is still there', async () => {
    mockPrisma.waitlistEntry.findUnique.mockResolvedValue({
      orgId: 'org-b',
      org: { status: 'SUSPENDED' },
    });

    expect(await leaveWaitlist(signLeaveToken('entry-1'))).toBe('unavailable');
    expect(mockErase).not.toHaveBeenCalled();
  });
});
