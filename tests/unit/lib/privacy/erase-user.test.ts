/**
 * Unit tests for lib/privacy/erase-user.ts
 *
 * Contract under test:
 *   eraseUser({ userId, userEmail, actorUserId, reason })
 *   1. best-effort avatar blob cleanup (outside the DB transaction)
 *   2. prisma.$transaction → scrub clientIp | write receipt | delete user
 *   3. returns { receiptId, erasedAt } from the created receipt row
 */

import { createHash } from 'node:crypto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  registerErasureCleanupHook,
  __resetErasureCleanupHooksForTests,
} from '@/lib/privacy/erasure-hooks';

// ---------------------------------------------------------------------------
// Mocks — use vi.hoisted() so variables exist before vi.mock() factories run
// ---------------------------------------------------------------------------

const { mockUpdateMany, mockReceiptCreate, mockUserDelete, mockPrisma, mockLogger } = vi.hoisted(
  () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const receiptCreate = vi.fn().mockResolvedValue({
      id: 'receipt-1',
      erasedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    const userDelete = vi.fn().mockResolvedValue({ id: 'user-1' });

    // Prisma mock — $transaction invokes its async callback with the same
    // prisma mock so tx.X === prisma.X; this is the pattern described in the
    // test plan's brittle-patterns note (a no-op mock makes downstream
    // assertions vacuous).
    const prismaObj = {
      $transaction: vi.fn(),
      aiAdminAuditLog: { updateMany },
      dataErasureReceipt: { create: receiptCreate },
      user: { delete: userDelete },
    };
    prismaObj.$transaction.mockImplementation(
      (callback: (tx: typeof prismaObj) => Promise<unknown>) => callback(prismaObj)
    );

    const log = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn(),
      withContext: vi.fn(),
    };

    return {
      mockUpdateMany: updateMany,
      mockReceiptCreate: receiptCreate,
      mockUserDelete: userDelete,
      mockPrisma: prismaObj,
      mockLogger: log,
    };
  }
);

vi.mock('@/lib/logging', () => ({
  logger: mockLogger,
}));

vi.mock('@/lib/db/client', () => ({
  prisma: mockPrisma,
}));

// Storage — dynamically imported by the source; mock the module so dynamic
// import picks up the mock at runtime.
const { mockIsStorageEnabled, mockDeleteByPrefix } = vi.hoisted(() => ({
  mockIsStorageEnabled: vi.fn().mockReturnValue(false),
  mockDeleteByPrefix: vi.fn().mockResolvedValue({ deleted: 1 }),
}));

vi.mock('@/lib/storage/upload', () => ({
  isStorageEnabled: mockIsStorageEnabled,
  deleteByPrefix: mockDeleteByPrefix,
}));

// ---------------------------------------------------------------------------
// Import under test (AFTER all vi.mock() calls)
// ---------------------------------------------------------------------------

import { eraseUser } from '@/lib/privacy/erase-user';

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

const BASE_PARAMS = {
  userId: 'user-42',
  userEmail: 'foo@bar.com',
  actorUserId: 'admin-99',
  reason: 'admin_action' as const,
};

// Independent sha256 computation — do NOT copy-paste from the impl.
function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('eraseUser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-apply default implementations after clearAllMocks() wiped call
    // history. Note: it is vi.restoreAllMocks() in afterEach that resets
    // spy implementations back to their originals; clearAllMocks() only
    // clears call history and return-value queues.
    mockIsStorageEnabled.mockReturnValue(false);
    mockDeleteByPrefix.mockResolvedValue({ deleted: 1 });
    mockUpdateMany.mockResolvedValue({ count: 1 });
    mockReceiptCreate.mockResolvedValue({
      id: 'receipt-1',
      erasedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    mockUserDelete.mockResolvedValue({ id: BASE_PARAMS.userId });
    mockPrisma.$transaction.mockImplementation(
      (callback: (tx: typeof mockPrisma) => Promise<unknown>) => callback(mockPrisma)
    );
    // Reset the hook registry so hook state never leaks between tests
    // (the module-level Map persists across tests in the same file)
    __resetErasureCleanupHooksForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Belt-and-suspenders: also clear hooks after each test
    __resetErasureCleanupHooksForTests();
  });

  // -------------------------------------------------------------------------
  // Case 1: Happy path — all three collaborators called; return shape correct
  // -------------------------------------------------------------------------

  it('happy path — calls all three transaction steps and returns { receiptId, erasedAt } matching the created receipt', async () => {
    // Arrange
    mockIsStorageEnabled.mockReturnValue(false); // storage off — not the focus here
    const receiptRow = { id: 'r-happy', erasedAt: new Date('2026-03-15T10:00:00.000Z') };
    mockReceiptCreate.mockResolvedValue(receiptRow);

    // Act
    const result = await eraseUser(BASE_PARAMS);

    // Assert — return value is derived from the created receipt row, not echo of inputs
    expect(result).toEqual({ receiptId: receiptRow.id, erasedAt: receiptRow.erasedAt });
    // All three transaction steps executed
    expect(mockUpdateMany).toHaveBeenCalledTimes(1);
    expect(mockReceiptCreate).toHaveBeenCalledTimes(1);
    expect(mockUserDelete).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Case 2: Scrub — exact args passed to aiAdminAuditLog.updateMany
  // -------------------------------------------------------------------------

  it('scrub — aiAdminAuditLog.updateMany called with { where: { userId }, data: { clientIp: null } }', async () => {
    // Arrange
    const { userId } = BASE_PARAMS;

    // Act
    await eraseUser(BASE_PARAMS);

    // Assert — the route COMPUTED these args from params; not just what the
    // mock returned
    expect(mockUpdateMany).toHaveBeenCalledWith({
      where: { userId },
      data: { clientIp: null },
    });
  });

  // -------------------------------------------------------------------------
  // Case 3: Receipt args — verified by independently-computed sha256
  // -------------------------------------------------------------------------

  it('receipt args — dataErasureReceipt.create called with correct subjectUserId, actorUserId, reason, and sha256 hash of email', async () => {
    // Arrange — compute the expected hash independently (not copied from impl)
    const expectedHash = sha256Hex('foo@bar.com'); // trim().toLowerCase() of 'foo@bar.com'

    // Act
    await eraseUser(BASE_PARAMS);

    // Assert — verify the TRANSFORMATION the source applied to each input
    expect(mockReceiptCreate).toHaveBeenCalledWith({
      data: {
        subjectUserId: BASE_PARAMS.userId,
        subjectEmailHash: expectedHash,
        actorUserId: BASE_PARAMS.actorUserId,
        reason: BASE_PARAMS.reason,
      },
    });
  });

  // -------------------------------------------------------------------------
  // Case 4: Email-hash normalization — padded + mixed-case treated as lowercase
  // -------------------------------------------------------------------------

  it('email-hash normalization — padded mixed-case email produces the same hash as lowercase trimmed form', async () => {
    // Arrange — two different email strings that should hash identically
    const normalizedHash = sha256Hex('foo@bar.com');
    const paddedMixedCase = '  Foo@BAR.com ';

    // Act — call with the untrimmed/mixed-case variant
    await eraseUser({ ...BASE_PARAMS, userEmail: paddedMixedCase });

    // Assert — the hash on the receipt matches what we computed for the
    // normalised string, proving the impl applied trim().toLowerCase()
    expect(mockReceiptCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ subjectEmailHash: normalizedHash }),
    });
  });

  // -------------------------------------------------------------------------
  // Case 5a: Transaction atomicity — all three steps run via $transaction
  // -------------------------------------------------------------------------

  it('transaction atomicity — scrub, receipt, and delete all execute inside the $transaction callback', async () => {
    // Arrange
    let txCallbackCaptured: ((tx: typeof mockPrisma) => Promise<unknown>) | null = null;
    mockPrisma.$transaction.mockImplementation(
      (callback: (tx: typeof mockPrisma) => Promise<unknown>) => {
        txCallbackCaptured = callback;
        return callback(mockPrisma);
      }
    );

    // Act
    await eraseUser(BASE_PARAMS);

    // Assert — the callback was passed to $transaction
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    expect(txCallbackCaptured).not.toBeNull();

    // All three steps ran through the tx object that was passed into the callback
    expect(mockUpdateMany).toHaveBeenCalledTimes(1);
    expect(mockReceiptCreate).toHaveBeenCalledTimes(1);
    expect(mockUserDelete).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Case 5b: Transaction atomicity — $transaction rejection propagates
  // -------------------------------------------------------------------------

  it('transaction atomicity — a $transaction rejection propagates out of eraseUser', async () => {
    // Arrange
    const dbError = new Error('deadlock detected');
    mockPrisma.$transaction.mockRejectedValue(dbError);

    // Act + Assert
    await expect(eraseUser(BASE_PARAMS)).rejects.toThrow('deadlock detected');
  });

  // -------------------------------------------------------------------------
  // Case 6: Storage enabled — deleteByPrefix called with correct prefix
  // -------------------------------------------------------------------------

  it('storage enabled — deleteByPrefix called once with avatars/{userId}/', async () => {
    // Arrange
    mockIsStorageEnabled.mockReturnValue(true);
    const { userId } = BASE_PARAMS;

    // Act
    await eraseUser(BASE_PARAMS);

    // Assert — the prefix is derived from userId (transformation, not echo)
    expect(mockDeleteByPrefix).toHaveBeenCalledTimes(1);
    expect(mockDeleteByPrefix).toHaveBeenCalledWith(`avatars/${userId}/`);
  });

  // -------------------------------------------------------------------------
  // Case 7: Storage disabled — deleteByPrefix NOT called
  // -------------------------------------------------------------------------

  it('storage disabled — deleteByPrefix not called when isStorageEnabled returns false', async () => {
    // Arrange — storage is already off from beforeEach default
    mockIsStorageEnabled.mockReturnValue(false);

    // Act
    await eraseUser(BASE_PARAMS);

    // Assert — explicit non-call assertion arranged cleanly (no mid-test
    // clearAllMocks, per brittle-patterns rule 4)
    expect(mockDeleteByPrefix).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Case 7b: Storage ordering — avatar cleanup runs BEFORE the DB delete.
  // Ported from route.delete.test.ts; locks the intentional structure that
  // avatar cleanup is best-effort and outside/ahead of the $transaction.
  // -------------------------------------------------------------------------

  it('storage ordering — deleteByPrefix is invoked before the user delete', async () => {
    // Arrange
    mockIsStorageEnabled.mockReturnValue(true);

    // Act
    await eraseUser(BASE_PARAMS);

    // Assert — both ran, and the avatar cleanup's invocation precedes the delete's
    expect(mockDeleteByPrefix).toHaveBeenCalledTimes(1);
    expect(mockUserDelete).toHaveBeenCalledTimes(1);
    expect(mockDeleteByPrefix.mock.invocationCallOrder[0]).toBeLessThan(
      mockUserDelete.mock.invocationCallOrder[0]
    );
  });

  // -------------------------------------------------------------------------
  // Case 7c: Storage error is fatal — a deleteByPrefix rejection propagates
  // and the user is NOT deleted (avatar cleanup precedes the transaction, so
  // its failure aborts erasure rather than orphaning the user). Ported from
  // route.delete.test.ts's "avatar cleanup errors" case.
  // -------------------------------------------------------------------------

  it('storage error is fatal — deleteByPrefix rejection propagates and user.delete is never reached', async () => {
    // Arrange
    mockIsStorageEnabled.mockReturnValue(true);
    mockDeleteByPrefix.mockRejectedValue(new Error('storage down'));

    // Act + Assert — eraseUser rejects, and the delete never runs
    await expect(eraseUser(BASE_PARAMS)).rejects.toThrow('storage down');
    expect(mockUserDelete).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Case 8: reason passthrough — 'admin_action' lands verbatim on receipt
  // -------------------------------------------------------------------------

  it('reason passthrough — admin_action lands verbatim on the receipt create call', async () => {
    // Arrange
    const params = { ...BASE_PARAMS, reason: 'admin_action' as const };

    // Act
    await eraseUser(params);

    // Assert — the source passed the reason through without mutation
    expect(mockReceiptCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ reason: 'admin_action' }),
    });
  });

  // =========================================================================
  // Erasure cleanup hooks — new tests added for the hook seam
  // =========================================================================

  // -------------------------------------------------------------------------
  // Hook Case 1: cleanupExternal best-effort — a throwing hook does NOT abort erasure
  // -------------------------------------------------------------------------

  it('cleanupExternal best-effort — a hook that rejects is swallowed; erasure still completes and logger.error is called', async () => {
    // Arrange — register a hook whose cleanupExternal rejects
    const failingHook = {
      name: 'failing-external',
      cleanupExternal: vi.fn().mockRejectedValue(new Error('upstream storage down')),
    };
    registerErasureCleanupHook(failingHook);

    // Act — erasure MUST NOT reject despite the hook failure
    const result = await eraseUser(BASE_PARAMS);

    // Assert: 1) eraseUser resolved (best-effort contract)
    expect(result).toMatchObject({ receiptId: expect.any(String), erasedAt: expect.any(Date) });

    // Assert: 2) the user was still deleted (erasure was NOT aborted)
    expect(mockUserDelete).toHaveBeenCalledTimes(1);

    // Assert: 3) the receipt was still created
    expect(mockReceiptCreate).toHaveBeenCalledTimes(1);

    // Assert: 4) the failure was logged with the hook's name — proving the
    // code did something with the error (not silently swallowed without trace)
    expect(mockLogger.error).toHaveBeenCalledWith(
      'Erasure cleanup hook (external) failed',
      expect.objectContaining({ hook: 'failing-external' })
    );
  });

  // -------------------------------------------------------------------------
  // Hook Case 1b: cleanupExternal best-effort with a NON-Error throw
  // -------------------------------------------------------------------------

  it('cleanupExternal best-effort — a hook that throws a non-Error value is coerced via String() and still does not abort erasure', async () => {
    // Arrange — throw a bare string (not an Error) to exercise the
    // `String(error)` arm of the catch's error-message ternary.
    const failingHook = {
      name: 'non-error-external',
      cleanupExternal: vi.fn().mockRejectedValue('storage exploded'),
    };
    registerErasureCleanupHook(failingHook);

    // Act — erasure still completes despite the non-Error throw
    const result = await eraseUser(BASE_PARAMS);

    // Assert — erasure was not aborted
    expect(result).toMatchObject({ receiptId: expect.any(String), erasedAt: expect.any(Date) });
    expect(mockUserDelete).toHaveBeenCalledTimes(1);
    expect(mockReceiptCreate).toHaveBeenCalledTimes(1);

    // Assert — the non-Error was coerced to a string and logged verbatim. Had
    // it gone through `error.message`, a string has no `.message` and the
    // logged value would be undefined — so this pins the non-Error branch.
    expect(mockLogger.error).toHaveBeenCalledWith(
      'Erasure cleanup hook (external) failed',
      expect.objectContaining({ hook: 'non-error-external', error: 'storage exploded' })
    );
  });

  // -------------------------------------------------------------------------
  // Hook Case 2: cleanupExternal ordering — runs BEFORE the $transaction begins
  // -------------------------------------------------------------------------

  it('cleanupExternal ordering — the external hook runs before the $transaction begins', async () => {
    // Arrange — record invocation order; cleanupExternal should precede $transaction
    const callOrder: string[] = [];

    const externalHook = {
      name: 'ordering-hook',
      cleanupExternal: vi.fn().mockImplementation(async () => {
        callOrder.push('cleanupExternal');
      }),
    };
    registerErasureCleanupHook(externalHook);

    // Wrap $transaction to record when it starts
    mockPrisma.$transaction.mockImplementation(
      async (callback: (tx: typeof mockPrisma) => Promise<unknown>) => {
        callOrder.push('$transaction');
        return callback(mockPrisma);
      }
    );

    // Act
    await eraseUser(BASE_PARAMS);

    // Assert — cleanupExternal was invoked and it came before $transaction
    expect(callOrder).toContain('cleanupExternal');
    expect(callOrder).toContain('$transaction');
    expect(callOrder.indexOf('cleanupExternal')).toBeLessThan(callOrder.indexOf('$transaction'));
  });

  // -------------------------------------------------------------------------
  // Hook Case 3: scrubInTransaction — called with the tx client and userId, before user.delete
  // -------------------------------------------------------------------------

  it('scrubInTransaction — called with the same tx object and { userId }, before tx.user.delete', async () => {
    // Arrange — capture what the hook receives and record call order
    let capturedCtx: { tx: unknown; userId: string } | null = null;
    const callOrder: string[] = [];

    const txHook = {
      name: 'scrub-hook',
      scrubInTransaction: vi
        .fn()
        .mockImplementation(async (ctx: { tx: unknown; userId: string }) => {
          capturedCtx = ctx;
          callOrder.push('scrubInTransaction');
        }),
    };
    registerErasureCleanupHook(txHook);

    // Wrap user.delete to record its call order
    mockUserDelete.mockImplementation(async () => {
      callOrder.push('user.delete');
      return { id: BASE_PARAMS.userId };
    });

    // Act
    await eraseUser(BASE_PARAMS);

    // Assert: 1) the hook was called with { tx, userId }
    expect(capturedCtx).not.toBeNull();
    expect(capturedCtx!.userId).toBe(BASE_PARAMS.userId);

    // Assert: 2) the tx object is the SAME object passed to the transaction callback
    // (mockPrisma IS the tx in this test setup)
    expect(capturedCtx!.tx).toBe(mockPrisma);

    // Assert: 3) scrubInTransaction ran BEFORE tx.user.delete (ordering contract)
    expect(callOrder.indexOf('scrubInTransaction')).toBeLessThan(callOrder.indexOf('user.delete'));
  });

  // -------------------------------------------------------------------------
  // Hook Case 4 (CRITICAL): scrubInTransaction throw ⇒ full rollback — user.delete
  // and dataErasureReceipt.create are NEVER called
  // -------------------------------------------------------------------------

  it('scrubInTransaction throw — eraseUser rejects; tx.user.delete and receipt.create are never called (atomicity)', async () => {
    // Arrange — register a hook whose scrubInTransaction rejects
    const atomicityHook = {
      name: 'atomicity-hook',
      scrubInTransaction: vi.fn().mockRejectedValue(new Error('scrub failure — tx must roll back')),
    };
    registerErasureCleanupHook(atomicityHook);

    // Act + Assert: 1) eraseUser REJECTS because the throw propagates
    await expect(eraseUser(BASE_PARAMS)).rejects.toThrow('scrub failure — tx must roll back');

    // Assert: 2) tx.user.delete was NEVER called (the throw aborted the callback
    // before reaching the delete — this is the atomicity contract)
    expect(mockUserDelete).not.toHaveBeenCalled();

    // Assert: 3) receipt.create was NEVER called (same reason — the callback
    // threw before reaching the receipt create, proving the entire erasure
    // rolls back atomically when a hook scrub fails)
    expect(mockReceiptCreate).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Hook Case 5: no-op phases — a hook with neither phase skips silently
  // -------------------------------------------------------------------------

  it('no-op hook — a hook with neither cleanupExternal nor scrubInTransaction does not error; erasure completes normally', async () => {
    // Arrange — a hook that defines no cleanup phases
    registerErasureCleanupHook({ name: 'noop-hook' });

    // Act
    const result = await eraseUser(BASE_PARAMS);

    // Assert — erasure completed normally (the no-op hook was skipped without error)
    expect(result).toMatchObject({ receiptId: expect.any(String), erasedAt: expect.any(Date) });
    expect(mockUserDelete).toHaveBeenCalledTimes(1);
    expect(mockReceiptCreate).toHaveBeenCalledTimes(1);
    // No error was logged for the no-op hook
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Hook Case 6: multiple hooks — all of each phase run
  // -------------------------------------------------------------------------

  it('multiple hooks — all cleanupExternal and all scrubInTransaction phases are invoked', async () => {
    // Arrange — register two hooks, each with both phases
    const externalA = vi.fn().mockResolvedValue(undefined);
    const externalB = vi.fn().mockResolvedValue(undefined);
    const scrubA = vi.fn().mockResolvedValue(undefined);
    const scrubB = vi.fn().mockResolvedValue(undefined);

    registerErasureCleanupHook({
      name: 'hook-a',
      cleanupExternal: externalA,
      scrubInTransaction: scrubA,
    });
    registerErasureCleanupHook({
      name: 'hook-b',
      cleanupExternal: externalB,
      scrubInTransaction: scrubB,
    });

    // Act
    await eraseUser(BASE_PARAMS);

    // Assert — all four phase functions were called; none was skipped
    expect(externalA).toHaveBeenCalledTimes(1);
    expect(externalB).toHaveBeenCalledTimes(1);
    expect(scrubA).toHaveBeenCalledTimes(1);
    expect(scrubB).toHaveBeenCalledTimes(1);

    // Each scrub received { tx, userId }
    expect(scrubA).toHaveBeenCalledWith(expect.objectContaining({ userId: BASE_PARAMS.userId }));
    expect(scrubB).toHaveBeenCalledWith(expect.objectContaining({ userId: BASE_PARAMS.userId }));
  });
});
