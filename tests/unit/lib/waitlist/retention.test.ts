/**
 * Unit tests: waitlist retention (§125 t-976)
 *
 * The cut-offs and the population each deletion asks for. That the deletes
 * leave entries inside their windows alone, against a populated table, is
 * `smoke:waitlist-admin`'s.
 *
 * @see lib/waitlist/retention.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DEFAULT_WAITLIST_RETENTION, type ResolvedWaitlistConfig } from '@/lib/waitlist/config';

const { mockPrisma, mockConfig } = vi.hoisted(() => ({
  mockPrisma: {
    waitlistEntry: { deleteMany: vi.fn() },
    waitlistListState: { findMany: vi.fn() },
  },
  mockConfig: { current: null },
}));

vi.mock('@/lib/db/client', () => ({ prisma: mockPrisma }));
vi.mock('@/lib/waitlist/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/waitlist/config')>()),
  getWaitlistConfig: () => mockConfig.current,
}));

import { pruneWaitlistEntries, runWaitlistRetention } from '@/lib/waitlist/retention';

const CONFIG: ResolvedWaitlistConfig = {
  consentVersion: 'v1',
  fields: [],
  lists: [{ key: 'default' }],
  screen: null,
  retention: DEFAULT_WAITLIST_RETENTION,
};

const NOW = new Date('2026-11-04T12:00:00Z');

beforeEach(() => {
  vi.clearAllMocks();
  mockConfig.current = null;
  mockPrisma.waitlistEntry.deleteMany.mockResolvedValue({ count: 0 });
  mockPrisma.waitlistListState.findMany.mockResolvedValue([]);
});

describe('pruneWaitlistEntries', () => {
  it('deletes removed entries 90 days after removal by default', async () => {
    mockPrisma.waitlistEntry.deleteMany.mockResolvedValueOnce({ count: 3 });

    const result = await pruneWaitlistEntries(CONFIG, NOW);

    expect(mockPrisma.waitlistEntry.deleteMany).toHaveBeenCalledWith({
      where: { removedAt: { lt: new Date('2026-08-06T12:00:00Z') } },
    });
    expect(result).toEqual({ removedDeleted: 3, closedListDeleted: 0 });
  });

  it('uses the windows the config sets', async () => {
    await pruneWaitlistEntries(
      { ...CONFIG, retention: { removedDays: 30, closedListMonths: 6 } },
      NOW
    );

    expect(mockPrisma.waitlistEntry.deleteMany).toHaveBeenCalledWith({
      where: { removedAt: { lt: new Date('2026-10-05T12:00:00Z') } },
    });
    expect(mockPrisma.waitlistListState.findMany).toHaveBeenCalledWith({
      where: { open: false, changedAt: { lt: new Date('2026-05-04T12:00:00Z') } },
      select: { list: true },
    });
  });

  it('deletes a long-closed list’s confirmed entries, never a joined, removed or unconfirmed one', async () => {
    mockPrisma.waitlistListState.findMany.mockResolvedValue([{ list: 'beta' }, { list: 'wave1' }]);
    mockPrisma.waitlistEntry.deleteMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 12 });

    const result = await pruneWaitlistEntries(CONFIG, NOW);

    // Closed 12 calendar months ago or more.
    expect(mockPrisma.waitlistListState.findMany).toHaveBeenCalledWith({
      where: { open: false, changedAt: { lt: new Date('2025-11-04T12:00:00Z') } },
      select: { list: true },
    });
    expect(mockPrisma.waitlistEntry.deleteMany).toHaveBeenLastCalledWith({
      where: {
        list: { in: ['beta', 'wave1'] },
        confirmedAt: { not: null },
        // Joined entries are erased with their account; removed and
        // unconfirmed ones have windows of their own.
        joinedAt: null,
        removedAt: null,
      },
    });
    expect(result).toEqual({ removedDeleted: 0, closedListDeleted: 12 });
  });

  it('issues no closed-list delete when no list has been closed that long', async () => {
    await pruneWaitlistEntries(CONFIG, NOW);

    expect(mockPrisma.waitlistEntry.deleteMany).toHaveBeenCalledTimes(1);
  });
});

describe('runWaitlistRetention', () => {
  it('reads nothing while the app has no waitlist', async () => {
    await expect(runWaitlistRetention(NOW)).resolves.toEqual({
      removedDeleted: 0,
      closedListDeleted: 0,
    });
    expect(mockPrisma.waitlistEntry.deleteMany).not.toHaveBeenCalled();
    expect(mockPrisma.waitlistListState.findMany).not.toHaveBeenCalled();
  });

  it('prunes with the app’s config when it has one', async () => {
    mockConfig.current = { ...CONFIG, retention: { removedDays: 1, closedListMonths: 12 } };

    await runWaitlistRetention(NOW);

    expect(mockPrisma.waitlistEntry.deleteMany).toHaveBeenCalledWith({
      where: { removedAt: { lt: new Date('2026-11-03T12:00:00Z') } },
    });
  });
});
