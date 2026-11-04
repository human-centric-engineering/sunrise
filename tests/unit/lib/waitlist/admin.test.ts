/**
 * Unit tests: the admin waitlist service (§125 t-976)
 *
 * What reaches the database for each admin act: the filter's `where`, the
 * page's order, the counts' groupings, the remove/restore guard, and the list
 * state's write. Postgres semantics (the JSON-path match, the per-org unique)
 * are `smoke:waitlist-admin`'s.
 *
 * @see lib/waitlist/admin.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DEFAULT_WAITLIST_RETENTION, type ResolvedWaitlistConfig } from '@/lib/waitlist/config';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    waitlistEntry: {
      findMany: vi.fn(),
      count: vi.fn(),
      groupBy: vi.fn(),
      updateMany: vi.fn(),
      findUnique: vi.fn(),
    },
    waitlistListState: { findMany: vi.fn(), findUnique: vi.fn(), upsert: vi.fn() },
  },
}));

vi.mock('@/lib/db/client', () => ({ prisma: mockPrisma }));

import {
  countWaitlistEntries,
  listWaitlistEntries,
  setWaitlistEntryRemoved,
  setWaitlistListOpen,
  waitlistEntryWhere,
} from '@/lib/waitlist/admin';

const CONFIG: ResolvedWaitlistConfig = {
  consentVersion: 'v1',
  fields: [
    { key: 'role', label: 'Role', kind: 'select', options: [{ value: 'dj', label: 'DJ' }] },
    { key: 'useCase', label: 'Use case', kind: 'textarea' },
  ],
  lists: [{ key: 'default' }, { key: 'beta', startsClosed: true }],
  screen: null,
  retention: DEFAULT_WAITLIST_RETENTION,
};

const NOW = new Date('2026-11-04T12:00:00Z');

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.waitlistEntry.findMany.mockResolvedValue([]);
  mockPrisma.waitlistEntry.count.mockResolvedValue(0);
  mockPrisma.waitlistEntry.groupBy.mockResolvedValue([]);
  mockPrisma.waitlistListState.findMany.mockResolvedValue([]);
});

describe('waitlistEntryWhere', () => {
  it('shows only confirmed entries still on a declared list by default', () => {
    expect(waitlistEntryWhere(CONFIG, {})).toEqual({
      AND: [
        { list: { in: ['default', 'beta'] } },
        { confirmedAt: { not: null } },
        { removedAt: null },
        { joinedAt: null },
      ],
    });
  });

  it('drops each default exclusion only when asked, and narrows to flagged on request', () => {
    expect(
      waitlistEntryWhere(CONFIG, {
        includeUnconfirmed: true,
        includeRemoved: true,
        includeJoined: true,
        flaggedOnly: true,
      })
    ).toEqual({
      AND: [{ list: { in: ['default', 'beta'] } }, { flaggedReason: { not: null } }],
    });
  });

  it('narrows to one declared list, and to none for a key the config does not declare', () => {
    expect(waitlistEntryWhere(CONFIG, { list: 'beta' }).AND).toContainEqual({
      list: { in: ['beta'] },
    });
    // An undeclared list is not the admin's to page, even by name.
    expect(waitlistEntryWhere(CONFIG, { list: 'retired' }).AND).toContainEqual({
      list: { in: [] },
    });
  });

  it('searches the stored address exactly as typed, the name loosely, and each declared answer', () => {
    const where = waitlistEntryWhere(CONFIG, { q: '  Ada_Lovelace ' });

    expect(where.AND).toContainEqual({
      OR: [
        // Lower-cased to the stored form; `contains`, never mode: 'insensitive' (#766).
        { email: { contains: 'ada_lovelace' } },
        { name: { contains: 'Ada_Lovelace', mode: 'insensitive' } },
        { details: { path: ['role'], string_contains: 'Ada_Lovelace' } },
        { details: { path: ['useCase'], string_contains: 'Ada_Lovelace' } },
      ],
    });
  });

  it('ignores a search of only spaces', () => {
    expect(waitlistEntryWhere(CONFIG, { q: '   ' }).AND).toHaveLength(4);
  });
});

describe('listWaitlistEntries', () => {
  it('pages with the sort the admin chose and id as the tiebreak', async () => {
    mockPrisma.waitlistEntry.findMany.mockResolvedValue([{ id: 'e1' }]);
    mockPrisma.waitlistEntry.count.mockResolvedValue(51);

    const result = await listWaitlistEntries(CONFIG, {
      page: 3,
      limit: 25,
      sortBy: 'email',
      sortOrder: 'asc',
    });

    expect(result).toEqual({ entries: [{ id: 'e1' }], total: 51 });
    const [args] = mockPrisma.waitlistEntry.findMany.mock.calls[0] as [Record<string, unknown>];
    expect(args.orderBy).toEqual([{ email: 'asc' }, { id: 'asc' }]);
    expect(args.skip).toBe(50);
    expect(args.take).toBe(25);
    // The count asks the same question as the page.
    const [countArgs] = mockPrisma.waitlistEntry.count.mock.calls[0] as [{ where: unknown }];
    expect(countArgs.where).toEqual(args.where);
  });

  it('never selects anything the join did not store for an admin, and no IP', async () => {
    await listWaitlistEntries(CONFIG, {
      page: 1,
      limit: 25,
      sortBy: 'createdAt',
      sortOrder: 'desc',
    });

    const [args] = mockPrisma.waitlistEntry.findMany.mock.calls[0] as [{ select: object }];
    expect(Object.keys(args.select)).not.toContain('ip');
    expect(Object.keys(args.select)).not.toContain('userId');
  });
});

describe('countWaitlistEntries', () => {
  it('counts each state per list, unconfirmed and flagged apart from confirmed', async () => {
    // Each groupCount call answers for the state its where names.
    mockPrisma.waitlistEntry.groupBy.mockImplementation(
      async (args: { by: string[]; where: Record<string, unknown> }) => {
        if (args.by.length === 3) {
          return [
            { list: 'default', utmSource: 'instagram', source: 'form', _count: { _all: 3 } },
            { list: 'default', utmSource: null, source: 'form', _count: { _all: 2 } },
            { list: 'default', utmSource: 'instagram', source: 'api', _count: { _all: 1 } },
            { list: 'beta', utmSource: null, source: 'form', _count: { _all: 9 } },
          ];
        }
        const w = args.where;
        const n = (count: number) => [{ list: 'default', _count: { _all: count } }];
        if ('flaggedReason' in w && w.flaggedReason === null) return n(6); // confirmed
        if (w.confirmedAt === null) return n(4); // unconfirmed
        if ('flaggedReason' in w) return n(2); // flagged
        if ('invitedAt' in w) return n(1);
        if (isNot(w.removedAt)) return n(7);
        if (isNot(w.joinedAt)) return n(5);
        return [];
      }
    );
    mockPrisma.waitlistListState.findMany.mockResolvedValue([{ list: 'beta', open: true }]);

    const [defaultList, beta] = await countWaitlistEntries(CONFIG);

    expect(defaultList).toEqual({
      key: 'default',
      open: true,
      confirmed: 6,
      unconfirmed: 4,
      flagged: 2,
      removed: 7,
      invited: 1,
      joined: 5,
      // utmSource where there is one, else source; summed, largest first.
      bySource: [
        { source: 'instagram', count: 4 },
        { source: 'form', count: 2 },
      ],
    });
    // A list with no rows in a state reads 0, and its stored state wins.
    expect(beta).toMatchObject({ key: 'beta', open: true, confirmed: 0 });
    expect(beta.bySource).toEqual([{ source: 'form', count: 9 }]);
  });

  it('counts confirmed as confirmed, not flagged, still on the list', async () => {
    await countWaitlistEntries(CONFIG);

    const wheres = mockPrisma.waitlistEntry.groupBy.mock.calls.map(
      (c) => (c[0] as { where: Record<string, unknown> }).where
    );
    expect(wheres[0]).toEqual({
      list: { in: ['default', 'beta'] },
      removedAt: null,
      joinedAt: null,
      confirmedAt: { not: null },
      flaggedReason: null,
    });
  });
});

function isNot(value: unknown): boolean {
  return typeof value === 'object' && value !== null && 'not' in value;
}

describe('setWaitlistEntryRemoved', () => {
  it('removes only an entry not already removed, so an earlier removal keeps its time', async () => {
    mockPrisma.waitlistEntry.findUnique.mockResolvedValue({ id: 'e1', removedAt: NOW });

    const entry = await setWaitlistEntryRemoved('e1', true, NOW);

    expect(mockPrisma.waitlistEntry.updateMany).toHaveBeenCalledWith({
      where: { id: 'e1', removedAt: null },
      data: { removedAt: NOW },
    });
    expect(entry).toEqual({ id: 'e1', removedAt: NOW });
  });

  it('restores only a removed entry, and leaves its re-join count alone', async () => {
    mockPrisma.waitlistEntry.findUnique.mockResolvedValue({ id: 'e1', removedAt: null });

    await setWaitlistEntryRemoved('e1', false, NOW);

    expect(mockPrisma.waitlistEntry.updateMany).toHaveBeenCalledWith({
      where: { id: 'e1', removedAt: { not: null } },
      data: { removedAt: null },
    });
  });

  it('answers null for an id this org has no entry for', async () => {
    mockPrisma.waitlistEntry.findUnique.mockResolvedValue(null);

    await expect(setWaitlistEntryRemoved('nope', true, NOW)).resolves.toBeNull();
  });
});

describe('setWaitlistListOpen', () => {
  it('writes the state with who and when, keyed on this org and list', async () => {
    mockPrisma.waitlistListState.findUnique.mockResolvedValue(null);
    mockPrisma.waitlistListState.upsert.mockResolvedValue({
      list: 'default',
      open: false,
      changedAt: NOW,
    });

    const state = await setWaitlistListOpen('default', false, 'admin-1', NOW);

    expect(state).toEqual({ key: 'default', open: false, changedAt: NOW });
    expect(mockPrisma.waitlistListState.upsert).toHaveBeenCalledWith({
      where: { orgId_list: { orgId: INSTALL_ORG_ID, list: 'default' } },
      create: { list: 'default', open: false, changedById: 'admin-1', changedAt: NOW },
      update: { open: false, changedById: 'admin-1', changedAt: NOW },
      select: { list: true, open: true, changedAt: true },
    });
  });

  it('does not move changedAt when the list is already in that state', async () => {
    // A closed list's retention window runs from changedAt: closing it again
    // must not keep its entries longer.
    const closedAt = new Date('2025-10-01T00:00:00Z');
    mockPrisma.waitlistListState.findUnique.mockResolvedValue({
      list: 'default',
      open: false,
      changedAt: closedAt,
    });

    const state = await setWaitlistListOpen('default', false, 'admin-2', NOW);

    expect(state).toEqual({ key: 'default', open: false, changedAt: closedAt });
    expect(mockPrisma.waitlistListState.upsert).not.toHaveBeenCalled();
  });
});
