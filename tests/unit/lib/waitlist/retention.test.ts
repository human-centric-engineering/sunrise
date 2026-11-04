/**
 * Unit tests: waitlist retention (§125 t-976)
 *
 * The cut-offs, the population each prune asks for, and the batch cap. That
 * the deletes leave entries inside their windows alone, against a populated
 * table, is `smoke:waitlist-admin`'s.
 *
 * @see lib/waitlist/retention.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DEFAULT_WAITLIST_RETENTION, type ResolvedWaitlistConfig } from '@/lib/waitlist/config';

const { mockPrisma, mockConfig } = vi.hoisted(() => {
  const mockConfig: { current: ResolvedWaitlistConfig | null } = { current: null };
  return {
    mockConfig,
    mockPrisma: {
      waitlistEntry: { findMany: vi.fn(), deleteMany: vi.fn() },
      waitlistListState: { findMany: vi.fn() },
    },
  };
});

vi.mock('@/lib/db/client', () => ({ prisma: mockPrisma }));
vi.mock('@/lib/waitlist/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/waitlist/config')>()),
  getWaitlistConfig: () => mockConfig.current,
}));

import {
  pruneWaitlistEntries,
  runWaitlistRetention,
  WAITLIST_RETENTION_BATCH,
  WAITLIST_RETENTION_MAX_BATCHES,
} from '@/lib/waitlist/retention';

const CONFIG: ResolvedWaitlistConfig = {
  consentVersion: 'v1',
  fields: [],
  lists: [{ key: 'default' }],
  screen: null,
  retention: DEFAULT_WAITLIST_RETENTION,
};

const NOW = new Date('2026-11-04T12:00:00Z');

/** The `where` each prune's read asked with, in call order. */
function wheres(): Array<Record<string, unknown>> {
  return mockPrisma.waitlistEntry.findMany.mock.calls.map(
    (c) => (c[0] as { where: Record<string, unknown> }).where
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockConfig.current = null;
  mockPrisma.waitlistEntry.findMany.mockResolvedValue([]);
  mockPrisma.waitlistEntry.deleteMany.mockImplementation(
    async (args: { where: { AND: [unknown, { id: { in: string[] } }] } }) => ({
      count: args.where.AND[1].id.in.length,
    })
  );
  mockPrisma.waitlistListState.findMany.mockResolvedValue([]);
});

describe('pruneWaitlistEntries', () => {
  it('deletes removed entries 90 days after removal by default, never a joined one', async () => {
    mockPrisma.waitlistEntry.findMany.mockResolvedValueOnce([{ id: 'a' }, { id: 'b' }]);

    const result = await pruneWaitlistEntries(CONFIG, NOW);

    const removedWhere = {
      removedAt: { lt: new Date('2026-08-06T12:00:00Z') },
      // An admin may remove a signed-up entry; it is still the account's.
      joinedAt: null,
    };
    expect(wheres()[0]).toEqual(removedWhere);
    // The delete repeats the where, so a row that changed since the read stays.
    expect(mockPrisma.waitlistEntry.deleteMany).toHaveBeenCalledWith({
      where: { AND: [removedWhere, { id: { in: ['a', 'b'] } }] },
    });
    expect(result).toEqual({ removedDeleted: 2, closedListDeleted: 0 });
  });

  it('deletes a backlog batch by batch in the run that finds it, unordered', async () => {
    const full = Array.from({ length: WAITLIST_RETENTION_BATCH }, (_, i) => ({ id: `r${i}` }));
    mockPrisma.waitlistEntry.findMany
      .mockResolvedValueOnce(full)
      .mockResolvedValueOnce(full)
      .mockResolvedValueOnce([{ id: 'last' }]);

    const result = await pruneWaitlistEntries(CONFIG, NOW);

    // Two full batches and a short one, then it stops: no fourth read.
    expect(result.removedDeleted).toBe(2 * WAITLIST_RETENTION_BATCH + 1);
    expect(mockPrisma.waitlistEntry.deleteMany).toHaveBeenCalledTimes(3);
    const [args] = mockPrisma.waitlistEntry.findMany.mock.calls[0] as [
      { take: number; orderBy?: unknown },
    ];
    expect(args.take).toBe(WAITLIST_RETENTION_BATCH);
    // Any expired row will do; an order would sort every match first.
    expect(args.orderBy).toBeUndefined();
  });

  it('stops at the run’s batch cap, leaving the rest for the next run', async () => {
    const full = Array.from({ length: WAITLIST_RETENTION_BATCH }, (_, i) => ({ id: `r${i}` }));
    mockPrisma.waitlistEntry.findMany.mockResolvedValue(full);

    const result = await pruneWaitlistEntries(CONFIG, NOW);

    expect(result.removedDeleted).toBe(WAITLIST_RETENTION_MAX_BATCHES * WAITLIST_RETENTION_BATCH);
  });

  it('uses the windows the config sets', async () => {
    await pruneWaitlistEntries(
      { ...CONFIG, retention: { removedDays: 30, closedListMonths: 6 } },
      NOW
    );

    expect(wheres()[0]).toMatchObject({ removedAt: { lt: new Date('2026-10-05T12:00:00Z') } });
    expect(mockPrisma.waitlistListState.findMany).toHaveBeenCalledWith({
      where: { open: false, changedAt: { lt: new Date('2026-05-04T12:00:00Z') } },
      select: { list: true },
    });
  });

  it('deletes a long-closed list’s confirmed entries — not joined, removed, unconfirmed or recently invited', async () => {
    mockPrisma.waitlistListState.findMany.mockResolvedValue([{ list: 'beta' }, { list: 'wave1' }]);
    mockPrisma.waitlistEntry.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }]);

    const result = await pruneWaitlistEntries(CONFIG, NOW);

    // Closed 12 calendar months ago or more.
    const cutoff = new Date('2025-11-04T12:00:00Z');
    expect(mockPrisma.waitlistListState.findMany).toHaveBeenCalledWith({
      where: { open: false, changedAt: { lt: cutoff } },
      select: { list: true },
    });
    expect(wheres()[1]).toEqual({
      list: { in: ['beta', 'wave1'] },
      confirmedAt: { not: null },
      joinedAt: null,
      removedAt: null,
      // Invites go on after a close; one sent since the cut-off may be live.
      OR: [{ invitedAt: null }, { invitedAt: { lt: cutoff } }],
    });
    expect(result).toEqual({ removedDeleted: 0, closedListDeleted: 3 });
  });

  it('reads no entries for the closed-list prune when no list has been closed that long', async () => {
    await pruneWaitlistEntries(CONFIG, NOW);

    expect(mockPrisma.waitlistEntry.findMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.waitlistEntry.deleteMany).not.toHaveBeenCalled();
  });
});

describe('runWaitlistRetention', () => {
  it('reads nothing while the app has no waitlist', async () => {
    await expect(runWaitlistRetention(NOW)).resolves.toEqual({
      removedDeleted: 0,
      closedListDeleted: 0,
    });
    expect(mockPrisma.waitlistEntry.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.waitlistListState.findMany).not.toHaveBeenCalled();
  });

  it('prunes with the app’s config when it has one', async () => {
    mockConfig.current = { ...CONFIG, retention: { removedDays: 1, closedListMonths: 12 } };

    await runWaitlistRetention(NOW);

    expect(wheres()[0]).toMatchObject({ removedAt: { lt: new Date('2026-11-03T12:00:00Z') } });
  });
});
