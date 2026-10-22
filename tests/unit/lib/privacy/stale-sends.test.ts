/**
 * Unit tests: sending from a copy taken before an erasure (§122 t-886).
 *
 * The transaction is a mock: these prove what `sendHoldingSubjects` asks for —
 * which locks, shared; which receipts, since when; how long the transaction
 * may run — and that a send naming nobody opens no transaction. Whether the
 * locks really order a send against an erasure is a Postgres property, proved
 * by `scripts/smoke/erasure-in-flight-sends.ts`.
 *
 * @see lib/privacy/stale-sends.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const tx = vi.hoisted(() => ({
  $executeRaw: vi.fn(),
  dataErasureReceipt: { findMany: vi.fn() },
  user: { findMany: vi.fn() },
}));
const prismaMock = vi.hoisted(() => ({
  $transaction: vi.fn(),
}));
vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));

import { NOBODY_ERASED, sendHoldingSubjects } from '@/lib/privacy/stale-sends';
import {
  COPY_CLOCK_SKEW_MS,
  SUBJECT_LOCK_WAIT_MS,
  subjectEmailHash,
} from '@/lib/privacy/erased-subjects';

const takenAt = new Date('2026-10-22T12:00:00Z');

/** The SQL text of every `$executeRaw` call, in order. */
function statements(): string[] {
  return tx.$executeRaw.mock.calls.map((call: unknown[]) =>
    (call[0] as TemplateStringsArray).join('?')
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  tx.$executeRaw.mockResolvedValue(1);
  tx.dataErasureReceipt.findMany.mockResolvedValue([]);
  tx.user.findMany.mockResolvedValue([]);
  prismaMock.$transaction.mockImplementation((run: (client: typeof tx) => Promise<unknown>) =>
    run(tx)
  );
});

describe('sendHoldingSubjects', () => {
  it('sends with nobody erased, and opens no transaction, when the copy names nobody', async () => {
    const send = vi.fn().mockResolvedValue('sent');

    await expect(
      sendHoldingSubjects({ addresses: ['{{input.email}}'], userIds: [] }, takenAt, 5_000, send)
    ).resolves.toBe('sent');

    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(prismaMock, NOBODY_ERASED);
  });

  it('bounds the lock wait, then takes every lock shared, before it reads the receipts', async () => {
    const order: string[] = [];
    tx.$executeRaw.mockImplementation(async () => {
      order.push('sql');
      return 1;
    });
    tx.dataErasureReceipt.findMany.mockImplementation(async () => {
      order.push('receipts');
      return [];
    });

    await sendHoldingSubjects(
      { addresses: ['a@example.com'], userIds: ['u-1'] },
      takenAt,
      5_000,
      async () => {
        order.push('send');
      }
    );

    const sql = statements();
    expect(sql[0]).toContain("set_config('lock_timeout'");
    expect(tx.$executeRaw.mock.calls[0]).toContain(`${SUBJECT_LOCK_WAIT_MS}ms`);
    expect(sql.slice(1)).toEqual([
      expect.stringContaining('pg_advisory_xact_lock_shared'),
      expect.stringContaining('pg_advisory_xact_lock_shared'),
    ]);
    // The send runs last, inside the transaction that holds the locks.
    expect(order).toEqual(['sql', 'sql', 'sql', 'receipts', 'send']);
  });

  it('asks only for erasures since the copy was taken, less the margin', async () => {
    await sendHoldingSubjects({ userIds: ['u-1'] }, takenAt, 5_000, vi.fn());

    expect(tx.dataErasureReceipt.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          erasedAt: { gte: new Date(takenAt.getTime() - COPY_CLOCK_SKEW_MS) },
        }),
      })
    );
  });

  it('hands the send who was erased, and the transaction to record it in', async () => {
    tx.dataErasureReceipt.findMany.mockResolvedValue([
      {
        subjectUserId: 'gone',
        subjectEmailHash: subjectEmailHash('gone@example.com'),
        metadata: { addressVerified: true },
      },
    ]);
    const send = vi.fn().mockResolvedValue(null);

    await sendHoldingSubjects(
      { addresses: ['Gone@Example.com', 'kept@example.com'] },
      takenAt,
      5_000,
      send
    );

    expect(send).toHaveBeenCalledWith(tx, { addresses: ['gone@example.com'], userIds: [] });
  });

  it('gives the transaction the lock wait and the send, and a connection ten seconds', async () => {
    await sendHoldingSubjects({ userIds: ['u-1'] }, takenAt, 15_000, vi.fn());

    expect(prismaMock.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      timeout: SUBJECT_LOCK_WAIT_MS + 15_000 + 10_000,
      maxWait: 10_000,
    });
  });

  it('propagates a lock wait that timed out, so the caller retries', async () => {
    tx.$executeRaw
      .mockResolvedValueOnce(1)
      .mockRejectedValueOnce(new Error('canceling statement due to lock timeout'));
    const send = vi.fn();

    await expect(sendHoldingSubjects({ userIds: ['u-1'] }, takenAt, 5_000, send)).rejects.toThrow(
      'lock timeout'
    );
    expect(send).not.toHaveBeenCalled();
  });
});
