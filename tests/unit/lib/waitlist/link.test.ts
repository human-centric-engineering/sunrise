/**
 * Unit tests: linkWaitlistEntryToAccount() (§125 t-978)
 *
 * The update the sign-up hook makes, inside the entry's org, and that it never
 * throws into a sign-up that has already created the account.
 *
 * @see lib/waitlist/link.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockPrisma, mockRunAsEntryOrg, mockLogger } = vi.hoisted(() => ({
  mockPrisma: { waitlistEntry: { updateMany: vi.fn() } },
  mockRunAsEntryOrg: vi.fn(),
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/db/client', () => ({ prisma: mockPrisma }));
vi.mock('@/lib/logging', () => ({ logger: mockLogger }));
vi.mock('@/lib/waitlist/entry-org', () => ({ runAsWaitlistEntryOrg: mockRunAsEntryOrg }));

import { linkWaitlistEntryToAccount } from '@/lib/waitlist/link';

const NOW = new Date('2026-11-05T10:00:00Z');
const INPUT = { entryId: 'entry-1', userId: 'user-1', email: ' Ada@Example.COM ', now: NOW };

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.waitlistEntry.updateMany.mockResolvedValue({ count: 1 });
  // Run the callback, as the real helper does once the org is entered.
  mockRunAsEntryOrg.mockImplementation(async (_id: string, fn: () => Promise<unknown>) => ({
    found: true,
    value: await fn(),
  }));
});

describe('linkWaitlistEntryToAccount', () => {
  it('runs the update inside the entry’s org, keyed by the id the invitation carried', async () => {
    await linkWaitlistEntryToAccount(INPUT);

    expect(mockRunAsEntryOrg).toHaveBeenCalledWith('entry-1', expect.any(Function));
    // The update is only issued from inside the org callback.
    expect(mockPrisma.waitlistEntry.updateMany).toHaveBeenCalledTimes(1);
  });

  it('does not touch the table when the org cannot be entered', async () => {
    mockRunAsEntryOrg.mockResolvedValue({ found: false, reason: 'refused' });

    await linkWaitlistEntryToAccount(INPUT);

    expect(mockPrisma.waitlistEntry.updateMany).not.toHaveBeenCalled();
  });

  it('matches only an unlinked, unremoved entry with this id and this (normalised) address, and sets userId and joinedAt', async () => {
    await linkWaitlistEntryToAccount(INPUT);

    expect(mockPrisma.waitlistEntry.updateMany).toHaveBeenCalledWith({
      where: { id: 'entry-1', email: 'ada@example.com', userId: null, removedAt: null },
      data: { userId: 'user-1', joinedAt: NOW },
    });
  });

  it('defaults joinedAt to the current time', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      await linkWaitlistEntryToAccount({ entryId: 'entry-1', userId: 'user-1', email: 'a@b.co' });
    } finally {
      vi.useRealTimers();
    }

    expect(mockPrisma.waitlistEntry.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { userId: 'user-1', joinedAt: NOW } })
    );
  });

  it('returns true and logs the link when one row matched', async () => {
    expect(await linkWaitlistEntryToAccount(INPUT)).toBe(true);
    expect(mockLogger.info).toHaveBeenCalledWith('Waitlist entry linked to its new account', {
      entryId: 'entry-1',
      userId: 'user-1',
    });
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it('returns false and warns when no row matched (erased, already linked, other address)', async () => {
    mockPrisma.waitlistEntry.updateMany.mockResolvedValue({ count: 0 });

    expect(await linkWaitlistEntryToAccount(INPUT)).toBe(false);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'Waitlist invitation redeemed but no entry was linked',
      { entryId: 'entry-1', userId: 'user-1', reason: 'no-match' }
    );
    expect(mockLogger.info).not.toHaveBeenCalled();
  });

  it.each(['missing', 'refused'] as const)(
    'returns false and says why when the entry lookup is %s',
    async (reason) => {
      mockRunAsEntryOrg.mockResolvedValue({ found: false, reason });

      expect(await linkWaitlistEntryToAccount(INPUT)).toBe(false);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Waitlist invitation redeemed but no entry was linked',
        expect.objectContaining({ reason })
      );
    }
  );

  it('never throws: a failing update returns false and is logged with the ids', async () => {
    const failure = new Error('db down');
    mockPrisma.waitlistEntry.updateMany.mockRejectedValue(failure);

    await expect(linkWaitlistEntryToAccount(INPUT)).resolves.toBe(false);
    expect(mockLogger.error).toHaveBeenCalledWith(
      'Failed to link a waitlist entry to its new account',
      failure,
      { entryId: 'entry-1', userId: 'user-1' }
    );
  });

  it('never throws when entering the org fails', async () => {
    mockRunAsEntryOrg.mockRejectedValue(new Error('lookup failed'));

    await expect(linkWaitlistEntryToAccount(INPUT)).resolves.toBe(false);
  });
});
