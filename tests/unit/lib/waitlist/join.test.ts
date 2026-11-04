/**
 * Unit tests: joinWaitlist() (§125 t-974)
 *
 * Each rule in the module header, asserted on what reaches the database. The
 * route test covers the answer the joiner gets; this file covers what the
 * join does to the row behind it.
 *
 * @see lib/waitlist/join.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import type { ResolvedWaitlistConfig } from '@/lib/waitlist/config';
import type { WaitlistJoin } from '@/lib/waitlist/join';

const { mockPrisma, mockLogger } = vi.hoisted(() => ({
  mockPrisma: {
    waitlistEntry: { findFirst: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
  },
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/db/client', () => ({ prisma: mockPrisma }));
vi.mock('@/lib/logging', () => ({ logger: mockLogger }));

import { joinWaitlist } from '@/lib/waitlist/join';

const NOW = new Date('2026-11-03T12:00:00Z');
const EARLIER = new Date('2026-11-01T09:00:00Z');

const CONFIG: ResolvedWaitlistConfig = {
  consentVersion: 'v2',
  fields: [],
  lists: [{ key: 'default' }],
  screen: null,
  retention: { unconfirmedDays: 30 },
};

const JOIN: WaitlistJoin = {
  email: 'ada@example.com',
  name: 'Ada',
  list: 'default',
  details: { role: 'producer' },
  source: 'form',
  locale: 'en-GB',
  utmSource: null,
  utmMedium: null,
  utmCampaign: null,
  referrerHost: null,
  ip: '203.0.113.7',
};

function existing(over: Record<string, unknown> = {}) {
  return {
    id: 'entry-1',
    name: 'Ada',
    details: { role: 'producer' },
    confirmedAt: null,
    removedAt: null,
    flaggedReason: null,
    updatedAt: EARLIER,
    ...over,
  };
}

function uniqueCollision() {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta: {
      modelName: 'WaitlistEntry',
      driverAdapterError: {
        cause: { constraint: { index: 'waitlist_entry_orgId_list_email_key' } },
      },
    },
  });
}

/** The `data` of the only updateMany call. */
function updateData(): Record<string, unknown> {
  expect(mockPrisma.waitlistEntry.updateMany).toHaveBeenCalledTimes(1);
  return (
    mockPrisma.waitlistEntry.updateMany.mock.calls[0] as [{ data: Record<string, unknown> }]
  )[0].data;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.waitlistEntry.findFirst.mockResolvedValue(null);
  mockPrisma.waitlistEntry.create.mockResolvedValue({ id: 'entry-new' });
  mockPrisma.waitlistEntry.updateMany.mockResolvedValue({ count: 1 });
});

describe('a first join', () => {
  it('creates an unconfirmed entry, consented now under the config’s version', async () => {
    // Act
    const { outcome, entryId } = await joinWaitlist(CONFIG, JOIN, NOW);

    // Assert — looked up by list and address only (the org comes from the context)
    expect(outcome).toBe('created');
    // The new entry's id, for the email sent after the response (t-977).
    expect(entryId).toBe('entry-new');
    expect(mockPrisma.waitlistEntry.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { list: 'default', email: 'ada@example.com' } })
    );
    const [{ data }] = mockPrisma.waitlistEntry.create.mock.calls[0] as [
      { data: Record<string, unknown> },
    ];
    expect(data).toMatchObject({ consentedAt: NOW, consentVersion: 'v2', flaggedReason: null });
    expect(data).not.toHaveProperty('confirmedAt');
    // the IP is shown to screen() and never stored
    expect(JSON.stringify(data)).not.toContain('203.0.113.7');
  });
});

describe('screen()', () => {
  it('stores a flag with its reason, and still creates the entry', async () => {
    // Arrange
    const screen = vi.fn().mockResolvedValue({ action: 'flag', reason: '  disposable-domain ' });

    // Act
    const { outcome } = await joinWaitlist({ ...CONFIG, screen }, JOIN, NOW);

    // Assert — the fork saw the join, including the IP it may check against
    expect(outcome).toBe('created');
    expect(screen).toHaveBeenCalledWith({
      email: 'ada@example.com',
      name: 'Ada',
      list: 'default',
      details: { role: 'producer' },
      ip: '203.0.113.7',
    });
    expect(mockPrisma.waitlistEntry.create).toHaveBeenCalledWith({
      select: { id: true },
      data: expect.objectContaining({ flaggedReason: 'disposable-domain' }),
    });
  });

  it.each([
    ['undefined', undefined],
    ['a flag with no reason', { action: 'flag' }],
    ['an unknown action', { action: 'reject' }],
  ])('a screen that returns %s flags rather than losing the join', async (_name, verdict) => {
    // A JS fork, or a cast, can return anything
    const screen = vi.fn().mockReturnValue(verdict);

    const { outcome } = await joinWaitlist({ ...CONFIG, screen }, JOIN, NOW);

    expect(outcome).toBe('created');
    const [{ data }] = mockPrisma.waitlistEntry.create.mock.calls[0] as [
      { data: { flaggedReason: string } },
    ];
    expect(['screen-error', 'flagged']).toContain(data.flaggedReason);
  });

  it('a screen that throws flags the entry as screen-error rather than accepting or losing it', async () => {
    // Arrange
    const screen = vi.fn().mockRejectedValue(new Error('blocklist service down'));

    // Act
    await joinWaitlist({ ...CONFIG, screen }, JOIN, NOW);

    // Assert
    expect(mockPrisma.waitlistEntry.create).toHaveBeenCalledWith({
      select: { id: true },
      data: expect.objectContaining({ flaggedReason: 'screen-error' }),
    });
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'Waitlist screen() threw; the entry is flagged',
      expect.not.objectContaining({ email: expect.anything() })
    );
  });
});

describe('a repeat before confirmation', () => {
  it('replaces the answers, and never moves consentedAt or the consent version', async () => {
    // Arrange — a stranger's guesses should not outlive the owner's own answers
    mockPrisma.waitlistEntry.findFirst.mockResolvedValue(
      existing({ name: 'Wrong', details: { role: 'dj', useCase: 'stranger' } })
    );

    // Act
    const { outcome, entryId } = await joinWaitlist(
      CONFIG,
      { ...JOIN, details: { role: 'producer' } },
      NOW
    );

    // Assert — the whole answer set is the latest one (useCase is gone)
    expect(outcome).toBe('replaced');
    expect(entryId).toBe('entry-1');
    const data = updateData();
    expect(data).toEqual({ name: 'Ada', details: { role: 'producer' }, flaggedReason: null });
    // …conditional on the row still being unconfirmed and not removed
    expect(mockPrisma.waitlistEntry.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'entry-1', confirmedAt: null, removedAt: null } })
    );
    expect(mockPrisma.waitlistEntry.create).not.toHaveBeenCalled();
  });

  it('keeps an existing flag even when the repeat screens clean', async () => {
    // Arrange
    mockPrisma.waitlistEntry.findFirst.mockResolvedValue(
      existing({ flaggedReason: 'repeated-ip' })
    );
    const screen = vi.fn().mockReturnValue({ action: 'accept' });

    // Act
    await joinWaitlist({ ...CONFIG, screen }, JOIN, NOW);

    // Assert
    expect(updateData()).toMatchObject({ flaggedReason: 'repeated-ip' });
  });

  it('confirmed in the meantime: the replace finds no row and the join falls to fill-only', async () => {
    // Arrange — the owner confirmed between our read and our write
    mockPrisma.waitlistEntry.findFirst
      .mockResolvedValueOnce(existing())
      .mockResolvedValueOnce(existing({ confirmedAt: EARLIER, details: { role: 'dj' } }));
    mockPrisma.waitlistEntry.updateMany.mockResolvedValueOnce({ count: 0 });

    // Act
    const { outcome } = await joinWaitlist(CONFIG, JOIN, NOW);

    // Assert — the owner's confirmed answer survived; nothing was overwritten
    expect(outcome).toBe('unchanged');
    expect(mockPrisma.waitlistEntry.updateMany).toHaveBeenCalledTimes(1);
  });
});

describe('a repeat after confirmation', () => {
  it('fills only empty answers and never overwrites one', async () => {
    // Arrange
    mockPrisma.waitlistEntry.findFirst.mockResolvedValue(
      existing({ confirmedAt: EARLIER, name: null, details: { role: 'dj' } })
    );

    // Act
    const { outcome } = await joinWaitlist(
      CONFIG,
      { ...JOIN, name: 'Mallory', details: { role: 'producer', useCase: 'sampling' } },
      NOW
    );

    // Assert — role stays dj; useCase and the empty name are filled
    expect(outcome).toBe('filled');
    expect(updateData()).toEqual({
      name: 'Mallory',
      details: { role: 'dj', useCase: 'sampling' },
    });
    // conditional on the row being as read, so two repeats cannot both fill it
    expect(mockPrisma.waitlistEntry.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'entry-1', updatedAt: EARLIER, removedAt: null } })
    );
  });

  it('a flagged repeat does not flag a confirmed entry (a stranger cannot hold the owner out)', async () => {
    mockPrisma.waitlistEntry.findFirst.mockResolvedValue(
      existing({ confirmedAt: EARLIER, name: null, details: {} })
    );
    const screen = vi.fn().mockReturnValue({ action: 'flag', reason: 'repeated-ip' });

    await joinWaitlist({ ...CONFIG, screen }, JOIN, NOW);

    expect(updateData()).not.toHaveProperty('flaggedReason');
  });

  it('writes nothing when every answer is already there', async () => {
    mockPrisma.waitlistEntry.findFirst.mockResolvedValue(
      existing({ confirmedAt: EARLIER, details: { role: 'dj' } })
    );

    const { outcome } = await joinWaitlist(CONFIG, { ...JOIN, details: { role: 'producer' } }, NOW);

    expect(outcome).toBe('unchanged');
    expect(mockPrisma.waitlistEntry.updateMany).not.toHaveBeenCalled();
  });

  it('never touches consent, the flag or provenance', async () => {
    mockPrisma.waitlistEntry.findFirst.mockResolvedValue(
      existing({ confirmedAt: EARLIER, name: null, details: {} })
    );

    await joinWaitlist(CONFIG, { ...JOIN, utmSource: 'ads' }, NOW);

    const data = updateData();
    for (const key of ['consentedAt', 'consentVersion', 'flaggedReason', 'utmSource', 'source']) {
      expect(data, key).not.toHaveProperty(key);
    }
  });
});

describe('a removed entry', () => {
  it('stays removed: the attempt is counted and nothing else changes', async () => {
    // Arrange — otherwise anyone can undo someone else's removal by joining again
    mockPrisma.waitlistEntry.findFirst.mockResolvedValue(
      existing({ removedAt: EARLIER, name: 'Old' })
    );

    // Act
    const { outcome } = await joinWaitlist(CONFIG, { ...JOIN, name: 'New' }, NOW);

    // Assert
    expect(outcome).toBe('rejoin-counted');
    expect(mockPrisma.waitlistEntry.updateMany).toHaveBeenCalledWith({
      where: { id: 'entry-1', removedAt: { not: null } },
      data: { rejoinRequests: { increment: 1 }, rejoinRequestedAt: NOW },
    });
  });
});

describe('races', () => {
  it('a lost create re-reads and applies the join to the winner’s row', async () => {
    // Arrange
    mockPrisma.waitlistEntry.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(existing());
    mockPrisma.waitlistEntry.create.mockRejectedValueOnce(uniqueCollision());

    // Act
    const { outcome } = await joinWaitlist(CONFIG, JOIN, NOW);

    // Assert
    expect(outcome).toBe('replaced');
    expect(mockPrisma.waitlistEntry.findFirst).toHaveBeenCalledTimes(2);
  });

  it('a different database error is not swallowed', async () => {
    mockPrisma.waitlistEntry.create.mockRejectedValueOnce(new Error('connection reset'));

    await expect(joinWaitlist(CONFIG, JOIN, NOW)).rejects.toThrow('connection reset');
    expect(mockPrisma.waitlistEntry.findFirst).toHaveBeenCalledTimes(1);
  });

  it('gives up after three lost races instead of looping', async () => {
    // Arrange — every conditional update finds the row changed under it
    mockPrisma.waitlistEntry.findFirst.mockResolvedValue(
      existing({ confirmedAt: EARLIER, details: {} })
    );
    mockPrisma.waitlistEntry.updateMany.mockResolvedValue({ count: 0 });

    // Act + Assert
    await expect(joinWaitlist(CONFIG, JOIN, NOW)).rejects.toThrow('lost 3 races');
    expect(mockPrisma.waitlistEntry.findFirst).toHaveBeenCalledTimes(3);
  });
});
