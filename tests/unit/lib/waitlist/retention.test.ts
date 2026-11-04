/**
 * Unit tests: waitlist retention (§125 t-976, t-977)
 *
 * The cut-offs, the population each prune asks for, the batch cap, and that
 * a deleted entry's confirmation token goes with it. That
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
      verification: { deleteMany: vi.fn() },
      $transaction: vi.fn(),
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
  WAITLIST_RETENTION_BUDGET_MS,
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

type Where = Record<string, unknown>;

/**
 * What the entry reads return. A read whose where is only `{ id: { in } }` is
 * the in-transaction check of which batch rows survived the delete; every
 * other read is a prune's, answered from `queue` and then `fallback`.
 */
const db: {
  queue: Array<Array<{ id: string }>>;
  fallback: Array<{ id: string }>;
  survivors: string[];
  onPruneRead: (() => void) | null;
} = { queue: [], fallback: [], survivors: [], onPruneRead: null };

function isSurvivorCheck(where: Where): boolean {
  return Object.keys(where).length === 1 && 'id' in where;
}

/** The `where` each prune's read asked with, in call order. */
function wheres(): Where[] {
  return mockPrisma.waitlistEntry.findMany.mock.calls
    .map((c) => (c[0] as { where: Where }).where)
    .filter((w) => !isSurvivorCheck(w));
}

/** The identifiers each token delete named, in call order. */
function tokenDeletes(): string[][] {
  return mockPrisma.verification.deleteMany.mock.calls.map(
    (c) => (c[0] as { where: { identifier: { in: string[] } } }).where.identifier.in
  );
}

const full = () => Array.from({ length: WAITLIST_RETENTION_BATCH }, (_, i) => ({ id: `r${i}` }));

beforeEach(() => {
  vi.clearAllMocks();
  mockConfig.current = null;
  db.queue = [];
  db.fallback = [];
  db.survivors = [];
  db.onPruneRead = null;
  mockPrisma.waitlistEntry.findMany.mockImplementation(async (args: { where: Where }) => {
    if (isSurvivorCheck(args.where)) {
      const ids = (args.where.id as { in: string[] }).in;
      return ids.filter((id) => db.survivors.includes(id)).map((id) => ({ id }));
    }
    db.onPruneRead?.();
    return db.queue.shift() ?? db.fallback;
  });
  // Deletes every row in the batch except the survivors.
  mockPrisma.waitlistEntry.deleteMany.mockImplementation(
    async (args: { where: { AND: [unknown, { id: { in: string[] } }] } }) => ({
      count: args.where.AND[1].id.in.filter((id) => !db.survivors.includes(id)).length,
    })
  );
  mockPrisma.waitlistListState.findMany.mockResolvedValue([]);
  mockPrisma.verification.deleteMany.mockResolvedValue({ count: 0 });
  mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => unknown) =>
    fn(mockPrisma)
  );
});

const IDLE = { unconfirmedDeleted: 0, removedDeleted: 0, closedListDeleted: 0 };

describe('pruneWaitlistEntries', () => {
  it('deletes unconfirmed entries 30 days after they joined by default, never a linked one', async () => {
    db.queue = [[{ id: 'u1' }, { id: 'u2' }]];

    const result = await pruneWaitlistEntries(CONFIG, NOW);

    const unconfirmedWhere = {
      confirmedAt: null,
      // Linked to an account: erased with it, not here.
      userId: null,
      createdAt: { lt: new Date('2026-10-05T12:00:00Z') },
    };
    expect(wheres()[0]).toEqual(unconfirmedWhere);
    expect(mockPrisma.waitlistEntry.deleteMany).toHaveBeenCalledWith({
      where: { AND: [unconfirmedWhere, { id: { in: ['u1', 'u2'] } }] },
    });
    expect(result).toEqual({ ...IDLE, unconfirmedDeleted: 2 });
  });

  it('deletes a deleted entry’s confirmation token with it, in the same transaction', async () => {
    db.queue = [[{ id: 'u1' }, { id: 'u2' }]];

    await pruneWaitlistEntries(CONFIG, NOW);

    expect(tokenDeletes()).toEqual([['waitlist-confirm:u1', 'waitlist-confirm:u2']]);
    expect(mockPrisma.$transaction).toHaveBeenCalledOnce();
  });

  it('keeps the token of an entry the delete’s re-check kept (confirmed since the read)', async () => {
    db.queue = [[{ id: 'u1' }, { id: 'u2' }]];
    db.survivors = ['u2'];

    const result = await pruneWaitlistEntries(CONFIG, NOW);

    expect(result.unconfirmedDeleted).toBe(1);
    expect(tokenDeletes()).toEqual([['waitlist-confirm:u1']]);
  });

  it('deletes no tokens when the batch deleted nothing', async () => {
    db.queue = [[{ id: 'u1' }]];
    db.survivors = ['u1'];

    await pruneWaitlistEntries(CONFIG, NOW);

    expect(mockPrisma.verification.deleteMany).not.toHaveBeenCalled();
  });

  it('deletes removed entries 90 days after removal by default, never a joined one', async () => {
    db.queue = [[], [{ id: 'a' }, { id: 'b' }]];

    const result = await pruneWaitlistEntries(CONFIG, NOW);

    const removedWhere = {
      removedAt: { lt: new Date('2026-08-06T12:00:00Z') },
      // An admin may remove a signed-up entry; it is still the account's.
      joinedAt: null,
    };
    expect(wheres()[1]).toEqual(removedWhere);
    // The delete repeats the where, so a row that changed since the read stays.
    expect(mockPrisma.waitlistEntry.deleteMany).toHaveBeenCalledWith({
      where: { AND: [removedWhere, { id: { in: ['a', 'b'] } }] },
    });
    expect(tokenDeletes()).toEqual([['waitlist-confirm:a', 'waitlist-confirm:b']]);
    expect(result).toEqual({ ...IDLE, removedDeleted: 2 });
  });

  it('deletes a backlog batch by batch in the run that finds it, unordered', async () => {
    db.queue = [full(), full(), [{ id: 'last' }]];

    const result = await pruneWaitlistEntries(CONFIG, NOW);

    // Two full batches and a short one, then the unconfirmed prune stops.
    expect(result.unconfirmedDeleted).toBe(2 * WAITLIST_RETENTION_BATCH + 1);
    expect(mockPrisma.waitlistEntry.deleteMany).toHaveBeenCalledTimes(3);
    const [args] = mockPrisma.waitlistEntry.findMany.mock.calls[0] as [
      { take: number; orderBy?: unknown },
    ];
    expect(args.take).toBe(WAITLIST_RETENTION_BATCH);
    // Any expired row will do; an order would sort every match first.
    expect(args.orderBy).toBeUndefined();
  });

  it('stops when a full batch deletes nothing, rather than reading the same rows again', async () => {
    const batch = full();
    db.fallback = batch;
    db.survivors = batch.map((r) => r.id);

    await pruneWaitlistEntries(CONFIG, NOW);

    // One read and one delete each for the unconfirmed and removed prunes;
    // the closed prune has no lists.
    expect(wheres()).toHaveLength(2);
    expect(mockPrisma.waitlistEntry.deleteMany).toHaveBeenCalledTimes(2);
  });

  it('stops when the run’s time budget is spent, leaving the rest for the next run', async () => {
    let clock = 1_000_000;
    const now = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    db.fallback = full();
    // Each batch takes a third of the budget.
    db.onPruneRead = () => {
      clock += Math.ceil(WAITLIST_RETENTION_BUDGET_MS / 3);
    };

    const result = await pruneWaitlistEntries(CONFIG, NOW);

    // The budget is shared: the unconfirmed prune spends it, the others get none.
    expect(result).toEqual({ ...IDLE, unconfirmedDeleted: 3 * WAITLIST_RETENTION_BATCH });
    now.mockRestore();
  });

  it('stops at the run’s batch cap, leaving the rest for the next run', async () => {
    db.fallback = full();

    const result = await pruneWaitlistEntries(CONFIG, NOW);

    expect(result.unconfirmedDeleted).toBe(
      WAITLIST_RETENTION_MAX_BATCHES * WAITLIST_RETENTION_BATCH
    );
  });

  it('uses the windows the config sets', async () => {
    await pruneWaitlistEntries(
      { ...CONFIG, retention: { unconfirmedDays: 7, removedDays: 30, closedListMonths: 6 } },
      NOW
    );

    expect(wheres()[0]).toMatchObject({ createdAt: { lt: new Date('2026-10-28T12:00:00Z') } });
    expect(wheres()[1]).toMatchObject({ removedAt: { lt: new Date('2026-10-05T12:00:00Z') } });
    expect(mockPrisma.waitlistListState.findMany).toHaveBeenCalledWith({
      where: { open: false, changedAt: { lt: new Date('2026-05-04T12:00:00Z') } },
      select: { list: true },
    });
  });

  it('deletes a long-closed list’s confirmed entries — not joined, removed, unconfirmed or recently invited', async () => {
    mockPrisma.waitlistListState.findMany.mockResolvedValue([{ list: 'beta' }, { list: 'wave1' }]);
    db.queue = [[], [], [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }]];

    const result = await pruneWaitlistEntries(CONFIG, NOW);

    // Closed 12 calendar months ago or more.
    const cutoff = new Date('2025-11-04T12:00:00Z');
    expect(mockPrisma.waitlistListState.findMany).toHaveBeenCalledWith({
      where: { open: false, changedAt: { lt: cutoff } },
      select: { list: true },
    });
    expect(wheres()[2]).toEqual({
      list: { in: ['beta', 'wave1'] },
      confirmedAt: { not: null },
      joinedAt: null,
      removedAt: null,
      // Invites go on after a close; one sent since the cut-off may be live.
      OR: [{ invitedAt: null }, { invitedAt: { lt: cutoff } }],
    });
    expect(result).toEqual({ ...IDLE, closedListDeleted: 3 });
  });

  it('reads no entries for the closed-list prune when no list has been closed that long', async () => {
    await pruneWaitlistEntries(CONFIG, NOW);

    expect(wheres()).toHaveLength(2);
    expect(mockPrisma.waitlistEntry.deleteMany).not.toHaveBeenCalled();
  });
});

describe('runWaitlistRetention', () => {
  it('reads nothing while the app has no waitlist', async () => {
    await expect(runWaitlistRetention(NOW)).resolves.toEqual(IDLE);
    expect(mockPrisma.waitlistEntry.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.waitlistListState.findMany).not.toHaveBeenCalled();
  });

  it('prunes with the app’s config when it has one', async () => {
    mockConfig.current = {
      ...CONFIG,
      retention: { unconfirmedDays: 30, removedDays: 1, closedListMonths: 12 },
    };

    await runWaitlistRetention(NOW);

    expect(wheres()[1]).toMatchObject({ removedAt: { lt: new Date('2026-11-03T12:00:00Z') } });
  });
});
