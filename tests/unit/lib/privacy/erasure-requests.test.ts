/**
 * Tests: `lib/privacy/erasure-requests.ts` — durable account deletion (t-842)
 *
 * `requestUserErasure()` records the intent and disables the account in one
 * claim transaction, then erases. `processPendingErasures()` is the retrier the
 * maintenance tick runs. What these tests pin is the claim protocol, because
 * that is what keeps two attempts from erasing one person at once and keeps a
 * half-finished deletion from leaving a usable account:
 *
 * - the claim is a write conditional on the values it read (the lease), and a
 *   caller that loses it, or finds the lease held, does no erasure work and
 *   disables nothing;
 * - sessions are deleted and API keys revoked BEFORE `eraseUser()` starts;
 * - a repeat request keeps the first request's actor, reason and time;
 * - a failed attempt sets the backoff, wakes the idle gate, and rethrows,
 *   unless another attempt already finished the erasure;
 * - the retrier erases with the STORED actor and reason, never throws for one
 *   person's failure, and stops at `ERASURES_PER_RUN`.
 *
 * Prisma, `eraseUser()`, the idle gate and the tenancy scope are mocked at the
 * module edge. The claim transaction gets its own `tx` client, distinct from
 * the top-level `prisma`, so a read made outside the transaction cannot be
 * mistaken for one made inside it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const NOW = new Date('2026-10-19T12:00:00.000Z');
const MINUTE = 60 * 1000;

const mocks = vi.hoisted(() => {
  const tx = {
    user: { findUnique: vi.fn(), updateMany: vi.fn() },
    session: { deleteMany: vi.fn() },
    aiApiKey: { updateMany: vi.fn() },
  };
  const prisma = {
    $transaction: vi.fn(),
    user: {
      findUnique: vi.fn(),
      updateMany: vi.fn(),
      findFirst: vi.fn(),
      count: vi.fn(),
    },
    dataErasureReceipt: { findFirst: vi.fn() },
  };
  return {
    tx,
    prisma,
    eraseUser: vi.fn(),
    noteMaintenanceWork: vi.fn(),
    isMultiTenant: vi.fn(),
    runAsSystem: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
});

vi.mock('@/lib/db/client', () => ({ prisma: mocks.prisma }));
vi.mock('@/lib/logging', () => ({ logger: mocks.logger }));
vi.mock('@/lib/privacy/erase-user', async () => {
  // The real error class: the code under test branches on `instanceof`.
  const { ErasureDeferredError } = await import('@/lib/privacy/erasure-deadline');
  return {
    eraseUser: mocks.eraseUser,
    ErasureDeferredError,
    ERASURE_TRANSACTION_TIMEOUT_MS: 60_000,
  };
});
vi.mock('@/lib/orchestration/maintenance/idle-gate', () => ({
  noteMaintenanceWork: mocks.noteMaintenanceWork,
}));
vi.mock('@/lib/tenancy/context', () => ({
  isMultiTenant: mocks.isMultiTenant,
  runAsSystem: mocks.runAsSystem,
}));

import { ErasureDeferredError } from '@/lib/privacy/erasure-deadline';
import {
  ERASURE_LEASE_MS,
  ERASURE_MAX_BACKOFF_MS,
  ERASURE_REQUEST_BUDGET_MS,
  erasureRequestBudgetMs,
  ERASURES_PER_RUN,
  erasureBackoffMs,
  processPendingErasures,
  requestUserErasure,
} from '@/lib/privacy/erasure-requests';

const { tx, prisma } = mocks;

const USER_ID = 'cmuser00000000000000user1';
const ADMIN_ID = 'cmadmin0000000000000admin1';
const RECEIPT = { receiptId: 'receipt-1', erasedAt: new Date('2026-10-19T12:00:05.000Z') };
const LEASE_UNTIL = new Date(NOW.getTime() + ERASURE_LEASE_MS);
/** What a request, and a retrier attempt, hand `eraseUser()` as its deadline (t-845). */
const REQUEST_DEADLINE = new Date(NOW.getTime() + ERASURE_REQUEST_BUDGET_MS);

/** A user with no erasure pending: what the first request reads. */
const NO_ERASURE_PENDING = {
  erasureRequestedAt: null,
  erasureRequestedBy: null,
  erasureReason: null,
  erasureAttempts: 0,
  erasureNextAttemptAt: null,
};

/**
 * `tx.user.findUnique` is called twice by a claim: for the row's erasure
 * columns, and (when the actor is not the subject) for the actor's existence.
 * Answer each by its select.
 */
let claimRow: Record<string, unknown> | null = null;
let existingUsers = new Set<string>();
function setClaimRow(row: Record<string, unknown> | null): void {
  claimRow = row === null ? null : { erasureAttempts: 0, ...row };
}

/** The order `fn` was first called in, for before/after assertions. */
function firstCallOrder(fn: unknown): number {
  const order = vi.mocked(fn as () => unknown).mock.invocationCallOrder[0];
  if (order === undefined) throw new Error('expected the function to have been called');
  return order;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);

  prisma.$transaction.mockImplementation(async (cb: (client: typeof tx) => Promise<unknown>) =>
    cb(tx)
  );
  mocks.isMultiTenant.mockReturnValue(false);
  mocks.runAsSystem.mockImplementation(async (_reason: string, fn: () => Promise<unknown>) => fn());

  setClaimRow(NO_ERASURE_PENDING);
  existingUsers = new Set([ADMIN_ID]);
  tx.user.findUnique.mockImplementation(
    async (args: { where: { id: string }; select: Record<string, boolean> }) =>
      args.select.erasureRequestedAt
        ? claimRow
        : existingUsers.has(args.where.id)
          ? { id: args.where.id }
          : null
  );
  tx.user.updateMany.mockResolvedValue({ count: 1 });
  tx.session.deleteMany.mockResolvedValue({ count: 2 });
  tx.aiApiKey.updateMany.mockResolvedValue({ count: 1 });

  // Outside the claim: the row still exists (a failure to erase is a failure).
  prisma.user.findUnique.mockResolvedValue({ id: USER_ID });
  prisma.user.updateMany.mockResolvedValue({ count: 1 });
  prisma.user.count.mockResolvedValue(0);
  prisma.dataErasureReceipt.findFirst.mockResolvedValue(null);

  mocks.eraseUser.mockResolvedValue(RECEIPT);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('erasureBackoffMs', () => {
  it.each([
    [1, 1 * MINUTE],
    [2, 2 * MINUTE],
    [3, 4 * MINUTE],
    [6, 32 * MINUTE],
  ])('waits %i attempt(s) -> %i ms, doubling from one minute', (attempts, expected) => {
    expect(erasureBackoffMs(attempts)).toBe(expected);
  });

  it.each([7, 8, 11, 50, 1000])('caps at the maximum after %i attempts', (attempts) => {
    expect(erasureBackoffMs(attempts)).toBe(ERASURE_MAX_BACKOFF_MS);
    expect(ERASURE_MAX_BACKOFF_MS).toBe(60 * MINUTE);
  });

  it('never waits less than a minute, even for a count below one', () => {
    expect(erasureBackoffMs(0)).toBe(MINUTE);
    expect(erasureBackoffMs(-3)).toBe(MINUTE);
  });
});

describe('requestUserErasure — the claim', () => {
  it('records the intent conditional on the values it read, then returns the erasure receipt', async () => {
    const result = await requestUserErasure({
      userId: USER_ID,
      actorUserId: ADMIN_ID,
      reason: 'admin_action',
    });

    expect(tx.user.findUnique).toHaveBeenCalledWith({
      where: { id: USER_ID },
      select: {
        erasureRequestedAt: true,
        erasureRequestedBy: true,
        erasureReason: true,
        erasureAttempts: true,
        erasureNextAttemptAt: true,
      },
    });
    // The where carries the read values: that is the lease, and it is why a
    // second caller that read the same row matches nothing.
    expect(tx.user.updateMany).toHaveBeenCalledWith({
      where: { id: USER_ID, erasureRequestedAt: null, erasureNextAttemptAt: null },
      data: {
        erasureRequestedAt: NOW,
        erasureRequestedBy: ADMIN_ID,
        erasureReason: 'admin_action',
        erasureAttempts: { increment: 1 },
        erasureNextAttemptAt: LEASE_UNTIL,
      },
    });
    expect(result).toEqual({ status: 'erased', ...RECEIPT });
  });

  it('deletes the sessions and revokes only the unrevoked API keys, before eraseUser starts', async () => {
    await requestUserErasure({ userId: USER_ID, actorUserId: USER_ID, reason: 'self_service' });

    expect(tx.session.deleteMany).toHaveBeenCalledWith({ where: { userId: USER_ID } });
    expect(tx.aiApiKey.updateMany).toHaveBeenCalledWith({
      where: { userId: USER_ID, revokedAt: null },
      data: { revokedAt: NOW },
    });

    const erase = firstCallOrder(mocks.eraseUser);
    expect(firstCallOrder(tx.user.updateMany)).toBeLessThan(firstCallOrder(tx.session.deleteMany));
    expect(firstCallOrder(tx.session.deleteMany)).toBeLessThan(
      firstCallOrder(tx.aiApiKey.updateMany)
    );
    expect(firstCallOrder(tx.aiApiKey.updateMany)).toBeLessThan(erase);
  });

  it('erases with the actor and reason the claim stored, in the system scope only at multi', async () => {
    await requestUserErasure({ userId: USER_ID, actorUserId: ADMIN_ID, reason: 'admin_action' });

    expect(mocks.eraseUser).toHaveBeenCalledTimes(1);
    expect(mocks.eraseUser).toHaveBeenCalledWith({
      userId: USER_ID,
      actorUserId: ADMIN_ID,
      reason: 'admin_action',
      deadline: REQUEST_DEADLINE,
    });
    expect(mocks.runAsSystem).not.toHaveBeenCalled();
  });

  it('runs the claim inside the audited system scope at multi', async () => {
    mocks.isMultiTenant.mockReturnValue(true);
    let depth = 0;
    mocks.runAsSystem.mockImplementation(async (_reason: string, fn: () => Promise<unknown>) => {
      depth += 1;
      try {
        return await fn();
      } finally {
        depth -= 1;
      }
    });
    let depthAtClaim = -1;
    prisma.$transaction.mockImplementation(async (cb: (client: typeof tx) => Promise<unknown>) => {
      depthAtClaim = depth;
      return cb(tx);
    });

    await requestUserErasure({ userId: USER_ID, actorUserId: USER_ID, reason: 'self_service' });

    expect(mocks.runAsSystem).toHaveBeenCalledTimes(1);
    expect(mocks.runAsSystem).toHaveBeenCalledWith(
      expect.stringContaining(USER_ID),
      expect.any(Function)
    );
    expect(depthAtClaim).toBe(1);
  });

  it('answers in_progress, disabling nothing and erasing nothing, while another attempt holds the lease', async () => {
    const requestedAt = new Date(NOW.getTime() - 2 * MINUTE);
    setClaimRow({
      erasureRequestedAt: requestedAt,
      erasureRequestedBy: ADMIN_ID,
      erasureReason: 'admin_action',
      erasureNextAttemptAt: new Date(NOW.getTime() + 5 * MINUTE),
    });

    const result = await requestUserErasure({
      userId: USER_ID,
      actorUserId: USER_ID,
      reason: 'self_service',
    });

    expect(result).toEqual({ status: 'in_progress', requestedAt });
    expect(tx.user.updateMany).not.toHaveBeenCalled();
    expect(tx.session.deleteMany).not.toHaveBeenCalled();
    expect(tx.aiApiKey.updateMany).not.toHaveBeenCalled();
    expect(mocks.eraseUser).not.toHaveBeenCalled();
  });

  it('answers in_progress and erases nothing when it loses the race for the claim', async () => {
    // Another caller's conditional write landed between this read and this write.
    tx.user.updateMany.mockResolvedValue({ count: 0 });

    const result = await requestUserErasure({
      userId: USER_ID,
      actorUserId: USER_ID,
      reason: 'self_service',
    });

    // Nothing was pending when it read, so the request time it reports is now.
    expect(result).toEqual({ status: 'in_progress', requestedAt: NOW });
    expect(tx.user.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.session.deleteMany).not.toHaveBeenCalled();
    expect(tx.aiApiKey.updateMany).not.toHaveBeenCalled();
    expect(mocks.eraseUser).not.toHaveBeenCalled();
  });

  it('keeps the first request when a repeat arrives after the lease ran out, and erases on its behalf', async () => {
    const firstRequestedAt = new Date(NOW.getTime() - 30 * MINUTE);
    const expiredLease = new Date(NOW.getTime() - 10 * MINUTE);
    setClaimRow({
      erasureRequestedAt: firstRequestedAt,
      erasureRequestedBy: USER_ID,
      erasureReason: 'self_service',
      erasureAttempts: 2,
      erasureNextAttemptAt: expiredLease,
    });

    await requestUserErasure({ userId: USER_ID, actorUserId: ADMIN_ID, reason: 'admin_action' });

    // The data carries no requestedAt/by/reason: the first request is the one
    // recorded. The where holds the values read, so the expired lease is what
    // is taken over.
    expect(tx.user.updateMany).toHaveBeenCalledWith({
      where: {
        id: USER_ID,
        erasureRequestedAt: firstRequestedAt,
        erasureNextAttemptAt: expiredLease,
      },
      data: { erasureAttempts: { increment: 1 }, erasureNextAttemptAt: LEASE_UNTIL },
    });
    // And the erasure is attributed to the stored request, not the repeat's.
    expect(mocks.eraseUser).toHaveBeenCalledWith({
      userId: USER_ID,
      actorUserId: USER_ID,
      reason: 'self_service',
      deadline: REQUEST_DEADLINE,
    });
  });

  it('takes a pending erasure that has no lease recorded (a null next attempt)', async () => {
    const requestedAt = new Date(NOW.getTime() - 5 * MINUTE);
    setClaimRow({
      erasureRequestedAt: requestedAt,
      erasureRequestedBy: ADMIN_ID,
      erasureReason: 'admin_action',
      erasureNextAttemptAt: null,
    });

    const result = await requestUserErasure({
      userId: USER_ID,
      actorUserId: ADMIN_ID,
      reason: 'admin_action',
    });

    expect(result.status).toBe('erased');
    expect(tx.user.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: USER_ID, erasureRequestedAt: requestedAt, erasureNextAttemptAt: null },
      })
    );
    expect(mocks.eraseUser).toHaveBeenCalledTimes(1);
  });

  it('names the person as the actor, as a self-service erasure, when a pending row carries no actor', async () => {
    setClaimRow({
      erasureRequestedAt: new Date(NOW.getTime() - 5 * MINUTE),
      erasureRequestedBy: null,
      erasureReason: null,
      erasureNextAttemptAt: null,
    });

    await requestUserErasure({ userId: USER_ID, actorUserId: ADMIN_ID, reason: 'admin_action' });

    expect(mocks.eraseUser).toHaveBeenCalledWith({
      userId: USER_ID,
      actorUserId: USER_ID,
      reason: 'self_service',
      deadline: REQUEST_DEADLINE,
    });
  });

  it('returns the receipt when the row is gone because another attempt just finished', async () => {
    setClaimRow(null);
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.dataErasureReceipt.findFirst.mockResolvedValue({ id: 'receipt-9', erasedAt: NOW });

    const result = await requestUserErasure({
      userId: USER_ID,
      actorUserId: USER_ID,
      reason: 'self_service',
    });

    expect(result).toEqual({ status: 'erased', receiptId: 'receipt-9', erasedAt: NOW });
    expect(prisma.dataErasureReceipt.findFirst).toHaveBeenCalledWith({
      where: { subjectUserId: USER_ID },
      orderBy: { erasedAt: 'desc' },
      select: { id: true, erasedAt: true },
    });
    expect(mocks.eraseUser).not.toHaveBeenCalled();
  });

  it('throws not-found when the row is gone and no receipt names it', async () => {
    setClaimRow(null);
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.dataErasureReceipt.findFirst.mockResolvedValue(null);

    await expect(
      requestUserErasure({ userId: USER_ID, actorUserId: USER_ID, reason: 'self_service' })
    ).rejects.toThrow(`User ${USER_ID} not found`);

    expect(mocks.logger.warn).toHaveBeenCalledWith(expect.stringContaining('no erasure receipt'), {
      userId: USER_ID,
    });
    expect(mocks.eraseUser).not.toHaveBeenCalled();
  });
});

describe('requestUserErasure — when the erasure fails', () => {
  it('sets the backoff for the attempt count, wakes the idle gate, and rethrows the same error', async () => {
    const failure = new Error('erasure transaction timed out');
    mocks.eraseUser.mockRejectedValue(failure);
    // Two attempts already made; this claim is the third.
    setClaimRow({
      erasureRequestedAt: new Date(NOW.getTime() - 30 * MINUTE),
      erasureRequestedBy: ADMIN_ID,
      erasureReason: 'admin_action',
      erasureAttempts: 2,
      erasureNextAttemptAt: new Date(NOW.getTime() - MINUTE),
    });

    await expect(
      requestUserErasure({ userId: USER_ID, actorUserId: ADMIN_ID, reason: 'admin_action' })
    ).rejects.toBe(failure);

    // Third failed attempt: 4 minutes, from now.
    expect(erasureBackoffMs(3)).toBe(4 * MINUTE);
    // Conditional on the exact lease this attempt's claim wrote, so a lease
    // another attempt has since taken over is not cut short.
    expect(tx.user.updateMany.mock.calls[0]?.[0].data.erasureNextAttemptAt).toEqual(LEASE_UNTIL);
    expect(prisma.user.updateMany).toHaveBeenCalledWith({
      where: { id: USER_ID, erasureNextAttemptAt: LEASE_UNTIL },
      data: { erasureNextAttemptAt: new Date(NOW.getTime() + 4 * MINUTE) },
    });
    expect(mocks.noteMaintenanceWork).toHaveBeenCalledWith('pending-erasure');
    expect(mocks.logger.error).toHaveBeenCalledWith(
      'Erasure attempt failed; the maintenance tick retries it',
      expect.objectContaining({
        userId: USER_ID,
        attempts: 3,
        nextAttemptAt: new Date(NOW.getTime() + 4 * MINUTE).toISOString(),
        error: 'erasure transaction timed out',
      })
    );
    // The account stays disabled: the claim's writes are not undone.
    expect(tx.session.deleteMany).toHaveBeenCalledTimes(1);
  });

  it('returns the receipt, without a backoff or a rethrow, when the row is gone and a receipt exists', async () => {
    // eraseUser tripped on a delete another attempt (an expired lease taken
    // over) had already made.
    mocks.eraseUser.mockRejectedValue(new Error('Record to delete does not exist'));
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.dataErasureReceipt.findFirst.mockResolvedValue({ id: 'receipt-7', erasedAt: NOW });

    const result = await requestUserErasure({
      userId: USER_ID,
      actorUserId: USER_ID,
      reason: 'self_service',
    });

    expect(result).toEqual({ status: 'erased', receiptId: 'receipt-7', erasedAt: NOW });
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
    // Only the claim's own wake-up; the failure path added none.
    expect(mocks.noteMaintenanceWork).toHaveBeenCalledTimes(1);
    expect(mocks.logger.error).not.toHaveBeenCalled();
  });

  it('treats a gone row with no receipt as the failure it is, and still rethrows', async () => {
    const failure = new Error('boom');
    mocks.eraseUser.mockRejectedValue(failure);
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.dataErasureReceipt.findFirst.mockResolvedValue(null);

    await expect(
      requestUserErasure({ userId: USER_ID, actorUserId: USER_ID, reason: 'self_service' })
    ).rejects.toBe(failure);

    expect(mocks.noteMaintenanceWork).toHaveBeenCalledWith('pending-erasure');
  });

  it('treats a fault while checking for a finished erasure as a failure, and still rethrows the original error', async () => {
    const failure = new Error('boom');
    mocks.eraseUser.mockRejectedValue(failure);
    prisma.user.findUnique.mockRejectedValue(new Error('db down'));

    await expect(
      requestUserErasure({ userId: USER_ID, actorUserId: USER_ID, reason: 'self_service' })
    ).rejects.toBe(failure);

    expect(prisma.user.updateMany).toHaveBeenCalledTimes(1);
    expect(mocks.noteMaintenanceWork).toHaveBeenCalledWith('pending-erasure');
  });

  it('still wakes the idle gate and rethrows the erasure error when the backoff cannot be written', async () => {
    const failure = new Error('boom');
    mocks.eraseUser.mockRejectedValue(failure);
    prisma.user.updateMany.mockRejectedValue(new Error('db down'));

    await expect(
      requestUserErasure({ userId: USER_ID, actorUserId: USER_ID, reason: 'self_service' })
    ).rejects.toBe(failure);

    expect(mocks.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('could not set the next attempt'),
      { userId: USER_ID, error: 'db down' }
    );
    expect(mocks.noteMaintenanceWork).toHaveBeenCalledWith('pending-erasure');
  });
});

describe('requestUserErasure — the erased actor', () => {
  const requestedAt = new Date(NOW.getTime() - 30 * MINUTE);
  const pendingBy = (by: string | null) => ({
    erasureRequestedAt: requestedAt,
    erasureRequestedBy: by,
    erasureReason: 'admin_action',
    erasureAttempts: 1,
    erasureNextAttemptAt: new Date(NOW.getTime() - MINUTE),
  });

  it('names the stored actor when that admin still exists, after looking them up', async () => {
    setClaimRow(pendingBy(ADMIN_ID));

    await requestUserErasure({ userId: USER_ID, actorUserId: USER_ID, reason: 'self_service' });

    expect(tx.user.findUnique).toHaveBeenCalledWith({
      where: { id: ADMIN_ID },
      select: { id: true },
    });
    expect(mocks.eraseUser).toHaveBeenCalledWith({
      userId: USER_ID,
      actorUserId: ADMIN_ID,
      reason: 'admin_action',
      deadline: REQUEST_DEADLINE,
    });
    expect(mocks.logger.warn).not.toHaveBeenCalled();
  });

  it('names the subject instead, and logs who asked, when the stored admin has been erased', async () => {
    setClaimRow(pendingBy('cmgoneadmin0000000000000'));

    await requestUserErasure({ userId: USER_ID, actorUserId: USER_ID, reason: 'self_service' });

    expect(tx.user.findUnique).toHaveBeenCalledWith({
      where: { id: 'cmgoneadmin0000000000000' },
      select: { id: true },
    });
    expect(mocks.eraseUser).toHaveBeenCalledWith({
      userId: USER_ID,
      actorUserId: USER_ID,
      reason: 'admin_action',
      deadline: REQUEST_DEADLINE,
    });
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('admin who asked has been erased'),
      { userId: USER_ID, requestedBy: 'cmgoneadmin0000000000000' }
    );
  });

  it('looks up the first request’s admin (not the stored one) on a first claim, and falls back the same way', async () => {
    existingUsers = new Set();

    await requestUserErasure({ userId: USER_ID, actorUserId: ADMIN_ID, reason: 'admin_action' });

    expect(tx.user.findUnique).toHaveBeenCalledWith({
      where: { id: ADMIN_ID },
      select: { id: true },
    });
    expect(mocks.eraseUser).toHaveBeenCalledWith({
      userId: USER_ID,
      actorUserId: USER_ID,
      reason: 'admin_action',
      deadline: REQUEST_DEADLINE,
    });
  });

  it('does no actor lookup for a self-service erasure', async () => {
    await requestUserErasure({ userId: USER_ID, actorUserId: USER_ID, reason: 'self_service' });

    // Only the claim's own read of the row.
    expect(tx.user.findUnique).toHaveBeenCalledTimes(1);
    expect(mocks.eraseUser).toHaveBeenCalledWith({
      userId: USER_ID,
      actorUserId: USER_ID,
      reason: 'self_service',
      deadline: REQUEST_DEADLINE,
    });
  });
});

describe('requestUserErasure — the lease clock and the idle gate', () => {
  it('wakes the idle gate right after the claim, before eraseUser runs', async () => {
    await requestUserErasure({ userId: USER_ID, actorUserId: USER_ID, reason: 'self_service' });

    expect(mocks.noteMaintenanceWork).toHaveBeenCalledWith('pending-erasure');
    expect(firstCallOrder(tx.aiApiKey.updateMany)).toBeLessThan(
      firstCallOrder(mocks.noteMaintenanceWork)
    );
    expect(firstCallOrder(mocks.noteMaintenanceWork)).toBeLessThan(firstCallOrder(mocks.eraseUser));
  });

  it('does not wake the idle gate when the claim is not won', async () => {
    tx.user.updateMany.mockResolvedValue({ count: 0 });

    await requestUserErasure({ userId: USER_ID, actorUserId: USER_ID, reason: 'self_service' });

    expect(mocks.noteMaintenanceWork).not.toHaveBeenCalled();
  });
});

describe('processPendingErasures', () => {
  interface PendingRow {
    id: string;
    by?: string | null;
    reason?: string | null;
    attempts?: number;
    /** What the claim's read sees; defaults to a pending erasure whose lease ran out. */
    read?: Record<string, unknown>;
  }

  /**
   * Make `rows` the due queue. `findFirst` honours the `id: { notIn }` exclusion
   * the retrier passes, as the real query does, so a row that is skipped is not
   * handed back forever.
   */
  function queue(rows: PendingRow[]): void {
    prisma.user.findFirst.mockImplementation(
      async (args: { where: { id: { notIn: string[] } } }) =>
        rows.find((row) => !args.where.id.notIn.includes(row.id)) ?? null
    );
    tx.user.findUnique.mockImplementation(
      async (args: { where: { id: string }; select: Record<string, boolean> }) => {
        if (!args.select.erasureRequestedAt) {
          return existingUsers.has(args.where.id) ? { id: args.where.id } : null;
        }
        const row = rows.find((r) => r.id === args.where.id);
        return (
          row?.read ?? {
            erasureRequestedAt: new Date(NOW.getTime() - 30 * MINUTE),
            erasureRequestedBy: row?.by ?? null,
            erasureReason: row?.reason ?? null,
            erasureAttempts: row?.attempts ?? 0,
            erasureNextAttemptAt: new Date(NOW.getTime() - MINUTE),
          }
        );
      }
    );
  }

  const ids = (): string[] => mocks.eraseUser.mock.calls.map(([args]) => args.userId);

  it('claims and erases the due person with the stored actor and reason, and reports the counts', async () => {
    queue([{ id: 'user-a', by: ADMIN_ID, reason: 'admin_action' }]);
    prisma.user.count.mockResolvedValue(0);

    const result = await processPendingErasures();

    expect(mocks.eraseUser.mock.calls).toEqual([
      [
        {
          userId: 'user-a',
          actorUserId: ADMIN_ID,
          reason: 'admin_action',
          // No deadline: the retrier runs an attempt to the end.
          deadline: undefined,
        },
      ],
    ]);
    expect(result).toEqual({ claimed: 1, erased: 1, failed: 0, pending: 0 });
    // Disabled again on this claim, not only on the first request.
    expect(tx.session.deleteMany).toHaveBeenCalledWith({ where: { userId: 'user-a' } });
  });

  it('takes on only one person per run, however many are due', async () => {
    expect(ERASURES_PER_RUN).toBe(1);
    queue([
      { id: 'user-a', by: 'user-a', reason: 'self_service' },
      { id: 'user-b', by: 'user-b', reason: 'self_service' },
      { id: 'user-c', by: 'user-c', reason: 'self_service' },
    ]);
    prisma.user.count.mockResolvedValue(2);

    const result = await processPendingErasures();

    expect(result).toEqual({ claimed: 1, erased: 1, failed: 0, pending: 2 });
    expect(ids()).toEqual(['user-a']);
    expect(prisma.user.findFirst).toHaveBeenCalledTimes(1);
  });

  it('asks only for pending rows that are due or have no next attempt, nulls first, excluding those already tried', async () => {
    queue([
      { id: 'user-a', by: 'user-a', reason: 'self_service' },
      { id: 'user-b', by: 'user-b', reason: 'self_service' },
    ]);
    // a was taken by another instance, so the loop goes on to ask again.
    tx.user.updateMany.mockImplementation(async (args: { where: { id: string } }) => ({
      count: args.where.id === 'user-a' ? 0 : 1,
    }));

    await processPendingErasures();

    expect(prisma.user.findFirst.mock.calls).toEqual([
      [
        {
          where: {
            erasureRequestedAt: { not: null },
            OR: [{ erasureNextAttemptAt: { lte: NOW } }, { erasureNextAttemptAt: null }],
            id: { notIn: [] },
          },
          orderBy: { erasureNextAttemptAt: { sort: 'asc', nulls: 'first' } },
          select: { id: true },
        },
      ],
      [expect.objectContaining({ where: expect.objectContaining({ id: { notIn: ['user-a'] } }) })],
    ]);
  });

  it('uses the time it is given for what is due', async () => {
    queue([]);
    const at = new Date('2026-10-20T00:00:00.000Z');

    await processPendingErasures(at);

    expect(prisma.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ erasureNextAttemptAt: { lte: at } }, { erasureNextAttemptAt: null }],
        }),
      })
    );
  });

  it.each([
    ['far in the past', new Date('2020-01-01T00:00:00.000Z')],
    ['far in the future', new Date('2040-01-01T00:00:00.000Z')],
  ])(
    'runs the lease from the claim’s own clock, not the due time given (%s)',
    async (_label, dueBy) => {
      queue([{ id: 'user-a', by: 'user-a', reason: 'self_service' }]);
      // Due by a time far in the future, the row's lease (NOW - 1min) is due; far
      // in the past it would not be, so make the row due under both.
      tx.user.findUnique.mockImplementation(async (args: { select: Record<string, boolean> }) =>
        args.select.erasureRequestedAt
          ? {
              erasureRequestedAt: new Date('2019-01-01T00:00:00.000Z'),
              erasureRequestedBy: 'user-a',
              erasureReason: 'self_service',
              erasureAttempts: 0,
              erasureNextAttemptAt: new Date('2019-06-01T00:00:00.000Z'),
            }
          : null
      );

      await processPendingErasures(dueBy);

      expect(tx.user.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ erasureNextAttemptAt: LEASE_UNTIL }),
        })
      );
      expect(tx.aiApiKey.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: { revokedAt: NOW } })
      );
    }
  );

  it('judges whether a lease is held against the due time given, not the clock', async () => {
    // Lease ends 10 minutes from the clock: held now, but due by an hour from now.
    const lease = new Date(NOW.getTime() + 10 * MINUTE);
    queue([
      {
        id: 'user-a',
        read: {
          erasureRequestedAt: new Date(NOW.getTime() - 5 * MINUTE),
          erasureRequestedBy: 'user-a',
          erasureReason: 'self_service',
          erasureAttempts: 1,
          erasureNextAttemptAt: lease,
        },
      },
    ]);

    const early = await processPendingErasures(NOW);
    expect(early.claimed).toBe(0);

    const later = await processPendingErasures(new Date(NOW.getTime() + 60 * MINUTE));
    expect(later.claimed).toBe(1);
  });

  it('does nothing, and opens no claim, when nothing is due', async () => {
    queue([]);
    prisma.user.count.mockResolvedValue(0);

    const result = await processPendingErasures();

    expect(result).toEqual({ claimed: 0, erased: 0, failed: 0, pending: 0 });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(mocks.eraseUser).not.toHaveBeenCalled();
  });

  it('wakes the idle gate at the end of the run only when erasures are still pending', async () => {
    queue([]);
    prisma.user.count.mockResolvedValue(0);
    await processPendingErasures();
    expect(mocks.noteMaintenanceWork).not.toHaveBeenCalled();

    prisma.user.count.mockResolvedValue(2);
    await processPendingErasures();
    expect(mocks.noteMaintenanceWork).toHaveBeenCalledTimes(1);
    expect(mocks.noteMaintenanceWork).toHaveBeenCalledWith('pending-erasure');
  });

  it('counts a person whose erasure fails, backs them off conditional on their own lease, and does not throw', async () => {
    queue([{ id: 'user-a', by: 'user-a', reason: 'self_service', attempts: 1 }]);
    mocks.eraseUser.mockRejectedValue(new Error('a is stuck behind a writer'));
    prisma.user.findUnique.mockResolvedValue({ id: 'user-a' });
    prisma.user.count.mockResolvedValue(1);

    const result = await processPendingErasures();

    expect(result).toEqual({ claimed: 1, erased: 0, failed: 1, pending: 1 });
    // Second attempt (one already made): two minutes, from now.
    expect(prisma.user.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.user.updateMany).toHaveBeenCalledWith({
      where: { id: 'user-a', erasureNextAttemptAt: LEASE_UNTIL },
      data: { erasureNextAttemptAt: new Date(NOW.getTime() + 2 * MINUTE) },
    });
  });

  it('skips a person another instance claimed between the read and the claim, and moves on', async () => {
    queue([
      { id: 'user-a', by: 'user-a', reason: 'self_service' },
      { id: 'user-b', by: 'user-b', reason: 'self_service' },
    ]);
    tx.user.updateMany.mockImplementation(async (args: { where: { id: string } }) => ({
      count: args.where.id === 'user-a' ? 0 : 1,
    }));

    const result = await processPendingErasures();

    expect(result).toEqual({ claimed: 1, erased: 1, failed: 0, pending: 0 });
    expect(ids()).toEqual(['user-b']);
    // a was not disabled by a claim it did not win.
    expect(tx.session.deleteMany).not.toHaveBeenCalledWith({ where: { userId: 'user-a' } });
  });

  it('skips a person whose lease is held again by the time it claims, and a person no longer pending', async () => {
    queue([
      {
        id: 'user-held',
        read: {
          erasureRequestedAt: new Date(NOW.getTime() - 5 * MINUTE),
          erasureRequestedBy: 'user-held',
          erasureReason: 'self_service',
          erasureAttempts: 1,
          erasureNextAttemptAt: new Date(NOW.getTime() + 10 * MINUTE),
        },
      },
      { id: 'user-cleared', read: NO_ERASURE_PENDING },
      { id: 'user-due', by: 'user-due', reason: 'self_service' },
    ]);

    const result = await processPendingErasures();

    expect(result.claimed).toBe(1);
    expect(ids()).toEqual(['user-due']);
    // The retrier never starts a deletion nobody requested.
    expect(tx.user.updateMany).toHaveBeenCalledTimes(1);
  });

  it('falls back to a self-service erasure by the person when the stored reason and actor are unusable', async () => {
    queue([{ id: 'user-a', by: null, reason: 'not_a_reason' }]);

    await processPendingErasures();

    expect(mocks.eraseUser).toHaveBeenCalledWith({
      userId: 'user-a',
      actorUserId: 'user-a',
      reason: 'self_service',
      deadline: undefined,
    });
  });

  it('reports every pending erasure still waiting, due or not', async () => {
    queue([{ id: 'user-a', by: 'user-a', reason: 'self_service' }]);
    prisma.user.count.mockResolvedValue(4);

    const result = await processPendingErasures();

    expect(prisma.user.count).toHaveBeenCalledWith({
      where: { erasureRequestedAt: { not: null } },
    });
    expect(result.pending).toBe(4);
  });
});

describe('the request budget (t-845)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is eight seconds by default', () => {
    expect(ERASURE_REQUEST_BUDGET_MS).toBe(8_000);
  });

  describe('erasureRequestBudgetMs', () => {
    it('returns the default when the variable is unset', () => {
      vi.stubEnv('ERASURE_REQUEST_BUDGET_MS', '');

      expect(erasureRequestBudgetMs()).toBe(ERASURE_REQUEST_BUDGET_MS);
      expect(mocks.logger.warn).not.toHaveBeenCalled();
    });

    it('returns a positive integer from the variable', () => {
      vi.stubEnv('ERASURE_REQUEST_BUDGET_MS', '25000');

      expect(erasureRequestBudgetMs()).toBe(25_000);
      expect(mocks.logger.warn).not.toHaveBeenCalled();
    });

    it('reads the variable on each call, so a value set after load applies', () => {
      expect(erasureRequestBudgetMs()).toBe(ERASURE_REQUEST_BUDGET_MS);
      vi.stubEnv('ERASURE_REQUEST_BUDGET_MS', '1500');
      expect(erasureRequestBudgetMs()).toBe(1_500);
    });

    it.each(['abc', '0', '-5', '1.5', '8s', 'NaN', 'Infinity'])(
      'falls back to the default, and warns with the value, for %j',
      (value) => {
        vi.stubEnv('ERASURE_REQUEST_BUDGET_MS', value);

        expect(erasureRequestBudgetMs()).toBe(ERASURE_REQUEST_BUDGET_MS);
        expect(mocks.logger.warn).toHaveBeenCalledWith(
          'ERASURE_REQUEST_BUDGET_MS is not a positive integer; using the default',
          { value, defaultMs: ERASURE_REQUEST_BUDGET_MS }
        );
      }
    );
  });

  it('gives eraseUser a deadline of the request’s start plus the configured budget', async () => {
    vi.stubEnv('ERASURE_REQUEST_BUDGET_MS', '30000');

    await requestUserErasure({ userId: USER_ID, actorUserId: ADMIN_ID, reason: 'admin_action' });

    expect(mocks.eraseUser).toHaveBeenCalledWith(
      expect.objectContaining({ deadline: new Date(NOW.getTime() + 30_000) })
    );
  });

  it('counts the claim against the budget: the deadline is fixed before the claim runs', async () => {
    // The clock moves while the claim transaction runs; the deadline does not.
    prisma.$transaction.mockImplementation(async (cb: (client: typeof tx) => Promise<unknown>) => {
      vi.setSystemTime(new Date(NOW.getTime() + 3_000));
      return cb(tx);
    });

    await requestUserErasure({ userId: USER_ID, actorUserId: ADMIN_ID, reason: 'admin_action' });

    expect(mocks.eraseUser).toHaveBeenCalledWith(
      expect.objectContaining({ deadline: REQUEST_DEADLINE })
    );
  });
});

describe('requestUserErasure — when the budget runs out (t-845)', () => {
  const REQUESTED_AT = new Date(NOW.getTime() - 30 * MINUTE);

  function deferErasure(stage = 'the hook delivery pre-pass'): void {
    mocks.eraseUser.mockRejectedValue(new ErasureDeferredError(stage));
  }

  it('answers pending with the time the deletion was first asked for, rather than throwing', async () => {
    deferErasure();
    setClaimRow({
      erasureRequestedAt: REQUESTED_AT,
      erasureRequestedBy: ADMIN_ID,
      erasureReason: 'admin_action',
      erasureAttempts: 1,
      erasureNextAttemptAt: new Date(NOW.getTime() - MINUTE),
    });

    const result = await requestUserErasure({
      userId: USER_ID,
      actorUserId: ADMIN_ID,
      reason: 'admin_action',
    });

    expect(result).toEqual({ status: 'pending', requestedAt: REQUESTED_AT });
  });

  it('reports a first request’s own time as when it was asked for', async () => {
    deferErasure();

    const result = await requestUserErasure({
      userId: USER_ID,
      actorUserId: ADMIN_ID,
      reason: 'admin_action',
    });

    expect(result).toEqual({ status: 'pending', requestedAt: NOW });
  });

  it('makes the next attempt due now, conditional on this attempt’s lease, with no backoff, and uncounts it', async () => {
    deferErasure();

    await requestUserErasure({ userId: USER_ID, actorUserId: ADMIN_ID, reason: 'admin_action' });

    expect(prisma.user.updateMany).toHaveBeenCalledTimes(1);
    // The claim counted this attempt; a deferral is not a failure, so a later
    // failure's backoff must not start from it.
    expect(prisma.user.updateMany).toHaveBeenCalledWith({
      where: { id: USER_ID, erasureNextAttemptAt: LEASE_UNTIL },
      data: { erasureNextAttemptAt: NOW, erasureAttempts: { decrement: 1 } },
    });
  });

  it('wakes the idle gate so the tick finishes it, and logs where it stopped as info, not an error', async () => {
    deferErasure('the run pre-pass');

    await requestUserErasure({ userId: USER_ID, actorUserId: ADMIN_ID, reason: 'admin_action' });

    expect(mocks.noteMaintenanceWork).toHaveBeenCalledWith('pending-erasure');
    expect(mocks.logger.info).toHaveBeenCalledWith(
      'Erasure attempt ran out of time; the maintenance tick continues it',
      { userId: USER_ID, attempts: 1, stoppedBefore: 'the run pre-pass' }
    );
    expect(mocks.logger.error).not.toHaveBeenCalled();
  });

  it('does not treat it as a failure while the account still exists', async () => {
    deferErasure();

    await requestUserErasure({ userId: USER_ID, actorUserId: ADMIN_ID, reason: 'admin_action' });

    // Looked for a finished erasure first, and found the row still there.
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: USER_ID },
      select: { id: true },
    });
    expect(mocks.logger.error).not.toHaveBeenCalled();
  });

  it('answers erased, not pending, when the account is already erased', async () => {
    // An error that surfaced after the commit, or another attempt's delete
    // this one tripped on: the row is gone and a receipt names the person.
    deferErasure('the erasure transaction');
    const erasedAt = new Date(NOW.getTime() - 1_000);
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.dataErasureReceipt.findFirst.mockResolvedValue({ id: 'receipt-1', erasedAt });

    const result = await requestUserErasure({
      userId: USER_ID,
      actorUserId: ADMIN_ID,
      reason: 'admin_action',
    });

    expect(result).toEqual({ status: 'erased', receiptId: 'receipt-1', erasedAt });
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
  });

  it('keeps the account disabled: the claim’s session delete is not undone', async () => {
    deferErasure();

    await requestUserErasure({ userId: USER_ID, actorUserId: ADMIN_ID, reason: 'admin_action' });

    expect(tx.session.deleteMany).toHaveBeenCalledTimes(1);
  });

  it('still answers pending, and logs it, when the next attempt cannot be made due', async () => {
    deferErasure();
    prisma.user.updateMany.mockRejectedValue(new Error('connection reset'));

    const result = await requestUserErasure({
      userId: USER_ID,
      actorUserId: ADMIN_ID,
      reason: 'admin_action',
    });

    expect(result.status).toBe('pending');
    expect(mocks.logger.error).toHaveBeenCalledWith(
      'Pending erasure: could not make the next attempt due; the lease will expire',
      { userId: USER_ID, error: 'connection reset' }
    );
    expect(mocks.noteMaintenanceWork).toHaveBeenCalledWith('pending-erasure');
  });

  it('still rethrows any other failure with a backoff, not a pending answer', async () => {
    const failure = new Error('constraint violated');
    mocks.eraseUser.mockRejectedValue(failure);

    await expect(
      requestUserErasure({ userId: USER_ID, actorUserId: ADMIN_ID, reason: 'admin_action' })
    ).rejects.toBe(failure);

    expect(prisma.user.updateMany).toHaveBeenCalledWith({
      where: { id: USER_ID, erasureNextAttemptAt: LEASE_UNTIL },
      data: { erasureNextAttemptAt: new Date(NOW.getTime() + MINUTE) },
    });
  });
});
