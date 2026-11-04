/**
 * Unit tests: waitlist retention (§125 t-977) — the unconfirmed window.
 *
 * Prisma is a small in-memory table that applies the `where` the module
 * sends, so the test proves which rows the query would delete, and that rows
 * inside the window survive, against a population shown non-empty first.
 *
 * @see lib/waitlist/retention.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { WaitlistConfig } from '@/lib/waitlist/config';

interface Row {
  id: string;
  createdAt: Date;
  confirmedAt: Date | null;
  userId: string | null;
}

const { table, tokens, mockPrisma } = vi.hoisted(() => {
  const table: { rows: Row[] } = { rows: [] };
  const tokens: { identifiers: string[] } = { identifiers: [] };

  type Where = {
    id?: { in: string[] };
    confirmedAt?: null;
    userId?: null;
    createdAt?: { lt: Date };
  };
  const matches = (r: Row, w: Where) =>
    (w.id === undefined || w.id.in.includes(r.id)) &&
    (!('confirmedAt' in w) || r.confirmedAt === null) &&
    (!('userId' in w) || r.userId === null) &&
    (w.createdAt === undefined || r.createdAt < w.createdAt.lt);

  const waitlistEntry = {
    findMany: vi.fn(async ({ where, take }: { where: Where; take: number }) =>
      table.rows
        .filter((r) => matches(r, where))
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .slice(0, take)
        .map((r) => ({ id: r.id }))
    ),
    deleteMany: vi.fn(async ({ where }: { where: Where }) => {
      const before = table.rows.length;
      table.rows = table.rows.filter((r) => !matches(r, where));
      return { count: before - table.rows.length };
    }),
  };
  const verification = {
    deleteMany: vi.fn(async ({ where }: { where: { identifier: { in: string[] } } }) => {
      tokens.identifiers = tokens.identifiers.filter((i) => !where.identifier.in.includes(i));
      return { count: 0 };
    }),
  };
  return {
    table,
    tokens,
    mockPrisma: {
      waitlistEntry,
      verification,
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({ waitlistEntry, verification })
      ),
    },
  };
});

vi.mock('@/lib/db/client', () => ({ prisma: mockPrisma }));

const NOW = new Date('2026-11-04T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 24 * 60 * 60 * 1000);

async function loadRetention(config: WaitlistConfig | null) {
  vi.resetModules();
  vi.doMock('@/lib/app/waitlist-config', () => ({ waitlistConfig: config }));
  const mod = await import('@/lib/waitlist/retention');
  const { __resetWaitlistConfigForTests } = await import('@/lib/waitlist/config');
  __resetWaitlistConfigForTests();
  return mod;
}

beforeEach(() => {
  vi.clearAllMocks();
  table.rows = [
    { id: 'old-unconfirmed', createdAt: daysAgo(31), confirmedAt: null, userId: null },
    { id: 'recent-unconfirmed', createdAt: daysAgo(29), confirmedAt: null, userId: null },
    { id: 'old-confirmed', createdAt: daysAgo(200), confirmedAt: daysAgo(199), userId: null },
    { id: 'old-linked', createdAt: daysAgo(200), confirmedAt: null, userId: 'u1' },
  ];
  tokens.identifiers = ['waitlist-confirm:old-unconfirmed', 'waitlist-confirm:recent-unconfirmed'];
});

describe('pruneWaitlistEntries', () => {
  it('deletes unconfirmed entries past 30 days and their tokens, and keeps everything else', async () => {
    // Arrange
    const { pruneWaitlistEntries } = await loadRetention({ consentVersion: 'v1' });
    expect(table.rows).toHaveLength(4);

    // Act
    const result = await pruneWaitlistEntries(NOW);

    // Assert
    expect(result).toEqual({ unconfirmedDeleted: 1 });
    expect(table.rows.map((r) => r.id).sort()).toEqual([
      'old-confirmed',
      'old-linked',
      'recent-unconfirmed',
    ]);
    expect(tokens.identifiers).toEqual(['waitlist-confirm:recent-unconfirmed']);
  });

  it('follows the window the config sets', async () => {
    const { pruneWaitlistEntries } = await loadRetention({
      consentVersion: 'v1',
      retention: { unconfirmedDays: 7 },
    });

    const result = await pruneWaitlistEntries(NOW);

    expect(result).toEqual({ unconfirmedDeleted: 2 });
    expect(table.rows.map((r) => r.id).sort()).toEqual(['old-confirmed', 'old-linked']);
  });

  it('does nothing, and reads nothing, when the app has no waitlist', async () => {
    const { pruneWaitlistEntries } = await loadRetention(null);

    const result = await pruneWaitlistEntries(NOW);

    expect(result).toEqual({ unconfirmedDeleted: 0 });
    expect(mockPrisma.waitlistEntry.findMany).not.toHaveBeenCalled();
    expect(table.rows).toHaveLength(4);
  });

  it('keeps an entry confirmed between the read and the delete', async () => {
    // Arrange — the owner confirms while the job is between its two queries
    const { pruneWaitlistEntries } = await loadRetention({ consentVersion: 'v1' });
    mockPrisma.waitlistEntry.findMany.mockImplementationOnce(async () => {
      table.rows[0].confirmedAt = NOW;
      return [{ id: 'old-unconfirmed' }];
    });

    // Act
    const result = await pruneWaitlistEntries(NOW);

    // Assert
    expect(result).toEqual({ unconfirmedDeleted: 0 });
    expect(table.rows.map((r) => r.id)).toContain('old-unconfirmed');
  });
});
