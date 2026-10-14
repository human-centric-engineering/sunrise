/**
 * Unit tests for lib/privacy/erase-user.ts
 *
 * Contract under test:
 *   eraseUser({ userId, userEmail, actorUserId, reason })
 *   1. best-effort avatar blob cleanup (outside the DB transaction)
 *   2. prisma.$transaction → scrub clientIp | delete contact submissions |
 *      write receipt | delete user
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

const {
  mockUpdateMany,
  mockContactDeleteMany,
  mockContactCount,
  mockReceiptCreate,
  mockUserDelete,
  mockUserFind,
  mockDeliveryUpdateMany,
  mockDeliveryFindMany,
  mockDeliveryUpdate,
  mockSubFindMany,
  mockSubUpdateMany,
  mockAuditCreateMany,
  mockEraseDeliveries,
  mockPrisma,
  mockLogger,
} = vi.hoisted(() => {
  const updateMany = vi.fn().mockResolvedValue({ count: 1 });
  const contactDeleteMany = vi.fn().mockResolvedValue({ count: 1 });
  const contactCount = vi.fn().mockResolvedValue(0);
  const receiptCreate = vi.fn().mockResolvedValue({
    id: 'receipt-1',
    erasedAt: new Date('2026-01-01T00:00:00.000Z'),
  });
  const userDelete = vi.fn().mockResolvedValue({ id: 'user-1' });
  // The address as the user row holds it — what the contact delete matches on.
  const deliveryUpdateMany = vi.fn().mockResolvedValue({ count: 0 });
  const deliveryFindMany = vi.fn().mockResolvedValue([]);
  const deliveryUpdate = vi.fn().mockResolvedValue({});
  const subFindMany = vi.fn().mockResolvedValue([]);
  const subUpdateMany = vi.fn().mockResolvedValue({ count: 0 });
  const auditCreateMany = vi.fn().mockResolvedValue({ count: 0 });
  const eraseDeliveries = vi.fn().mockResolvedValue(0);
  const userFind = vi.fn().mockResolvedValue({ email: 'foo@bar.com', emailVerified: true });

  // Prisma mock — $transaction invokes its async callback with the same
  // prisma mock so tx.X === prisma.X; this is the pattern described in the
  // test plan's brittle-patterns note (a no-op mock makes downstream
  // assertions vacuous).
  const prismaObj = {
    $transaction: vi.fn(),
    aiAdminAuditLog: { updateMany, createMany: auditCreateMany },
    contactSubmission: { deleteMany: contactDeleteMany, count: contactCount },
    dataErasureReceipt: { create: receiptCreate },
    aiWebhookSubscription: { findMany: subFindMany, updateMany: subUpdateMany },
    aiWebhookDelivery: {
      updateMany: deliveryUpdateMany,
      findMany: deliveryFindMany,
      update: deliveryUpdate,
    },
    user: { delete: userDelete, findUniqueOrThrow: userFind },
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
    mockContactDeleteMany: contactDeleteMany,
    mockContactCount: contactCount,
    mockReceiptCreate: receiptCreate,
    mockUserDelete: userDelete,
    mockUserFind: userFind,
    mockDeliveryUpdateMany: deliveryUpdateMany,
    mockDeliveryFindMany: deliveryFindMany,
    mockDeliveryUpdate: deliveryUpdate,
    mockSubFindMany: subFindMany,
    mockSubUpdateMany: subUpdateMany,
    mockAuditCreateMany: auditCreateMany,
    mockEraseDeliveries: eraseDeliveries,
    mockPrisma: prismaObj,
    mockLogger: log,
  };
});

vi.mock('@/lib/logging', () => ({
  logger: mockLogger,
}));

const mockEnv = vi.hoisted(() => ({ TENANCY_MODE: 'single' }));
vi.mock('@/lib/env', () => ({ env: mockEnv }));

vi.mock('@/lib/db/client', () => ({
  prisma: mockPrisma,
}));

// The payload redaction has its own tests (delivery-payloads.test.ts); here
// only the call contract matters: which client, table and user, and when.
vi.mock('@/lib/privacy/delivery-payloads', () => ({
  eraseSubjectFromDeliveries: mockEraseDeliveries,
}));

// The config rewrite has its own tests (config-recipients.test.ts); here only
// the call contract matters: which client, whose id and address, and when.
const { mockEraseConfig, mockInvalidateSettings } = vi.hoisted(() => ({
  mockEraseConfig: vi.fn(),
  mockInvalidateSettings: vi.fn(),
}));
vi.mock('@/lib/privacy/config-recipients', () => ({
  eraseFromConfigRecipients: mockEraseConfig,
}));
vi.mock('@/lib/orchestration/settings', () => ({
  invalidateOrchestrationSettingsCache: mockInvalidateSettings,
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

import { eraseUser, ERASURE_TRANSACTION_TIMEOUT_MS } from '@/lib/privacy/erase-user';
import { getTenantContext, runAsOrg } from '@/lib/tenancy/context';

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
    mockEnv.TENANCY_MODE = 'single';
    // Re-apply default implementations after clearAllMocks() wiped call
    // history. Note: it is vi.restoreAllMocks() in afterEach that resets
    // spy implementations back to their originals; clearAllMocks() only
    // clears call history and return-value queues.
    mockIsStorageEnabled.mockReturnValue(false);
    mockDeleteByPrefix.mockResolvedValue({ deleted: 1 });
    mockUpdateMany.mockResolvedValue({ count: 1 });
    mockContactDeleteMany.mockResolvedValue({ count: 1 });
    mockContactCount.mockResolvedValue(0);
    mockDeliveryUpdateMany.mockResolvedValue({ count: 0 });
    mockDeliveryFindMany.mockResolvedValue([]);
    mockDeliveryUpdate.mockResolvedValue({});
    mockSubFindMany.mockResolvedValue([]);
    mockSubUpdateMany.mockResolvedValue({ count: 0 });
    mockAuditCreateMany.mockResolvedValue({ count: 0 });
    mockEraseDeliveries.mockResolvedValue(0);
    mockEraseConfig.mockResolvedValue({ escalationListsChanged: 0, workflowsChanged: 0 });
    mockUserFind.mockResolvedValue({ email: 'foo@bar.com', emailVerified: true });
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
    mockUserFind.mockResolvedValue({ email: '  Foo@BAR.com ', emailVerified: true });

    // Act — the stored address is the untrimmed/mixed-case variant
    await eraseUser(BASE_PARAMS);

    // Assert — the hash on the receipt matches what we computed for the
    // normalised string, proving the impl applied trim().toLowerCase()
    expect(mockReceiptCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ subjectEmailHash: normalizedHash }),
    });
  });

  describe('the receipt hashes the STORED address (t-797)', () => {
    it('ignores a stale caller address: the hash is of the address on the user row', async () => {
      // A cached session can still hold the address from before an email change
      mockUserFind.mockResolvedValue({ email: 'new@bar.com', emailVerified: true });

      await eraseUser({ ...BASE_PARAMS, userEmail: 'old@bar.com' });

      const { data } = mockReceiptCreate.mock.calls[0][0] as { data: { subjectEmailHash: string } };
      expect(data.subjectEmailHash).toBe(sha256Hex('new@bar.com'));
      expect(data.subjectEmailHash).not.toBe(sha256Hex('old@bar.com'));
    });

    it('needs no userEmail at all', async () => {
      mockUserFind.mockResolvedValue({ email: 'new@bar.com', emailVerified: true });
      const { userEmail: _ignored, ...withoutEmail } = BASE_PARAMS;

      await eraseUser(withoutEmail);

      expect(mockReceiptCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({ subjectEmailHash: sha256Hex('new@bar.com') }),
      });
    });

    it('hashes an unverified address too: the receipt correlates, it erases nothing', async () => {
      mockUserFind.mockResolvedValue({ email: 'new@bar.com', emailVerified: false });

      await eraseUser({ ...BASE_PARAMS, userEmail: 'old@bar.com' });

      expect(mockReceiptCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({ subjectEmailHash: sha256Hex('new@bar.com') }),
      });
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
  // Case 7d: Contact submissions — no FK to User, so the cascade never reaches
  // them; the service deletes them, matched exactly on the normalised address.
  // -------------------------------------------------------------------------

  it('contact submissions — matched on the address the user row holds, normalised, as an exact match', async () => {
    // Arrange — a stored address that is not already in the canonical form
    mockUserFind.mockResolvedValue({ email: '  Foo@BAR.com ', emailVerified: true });

    // Act
    await eraseUser(BASE_PARAMS);

    // Assert — the address was read for THIS user, and the filter is the
    // normalised string with no `mode`, so Prisma compiles it to `=`, not ILIKE
    expect(mockUserFind).toHaveBeenCalledWith({
      where: { id: BASE_PARAMS.userId },
      select: { email: true, emailVerified: true },
    });
    expect(mockContactDeleteMany).toHaveBeenCalledTimes(1);
    expect(mockContactDeleteMany).toHaveBeenCalledWith({ where: { email: 'foo@bar.com' } });
  });

  it('contact submissions — a stale caller address is ignored; the stored one is matched', async () => {
    // Arrange — the caller's copy predates an email change (a cached session)
    mockUserFind.mockResolvedValue({ email: 'new@bar.com', emailVerified: true });

    // Act
    await eraseUser({ ...BASE_PARAMS, userEmail: 'old@bar.com' });

    // Assert — the old address may be someone else's by now; never match it
    expect(mockContactDeleteMany).toHaveBeenCalledWith({ where: { email: 'new@bar.com' } });
  });

  it('contact submissions — none deleted for an unverified address; what is left is counted and flagged', async () => {
    // Arrange — the account never proved it owns the address, so the messages
    // under it may be a stranger's (anyone can type any address in the form)
    mockUserFind.mockResolvedValue({ email: ' Foo@BAR.com', emailVerified: false });
    mockContactCount.mockResolvedValue(2);

    // Act
    const result = await eraseUser(BASE_PARAMS);

    // Assert — nothing deleted, the rest of the erasure ran, the log says 0
    expect(mockContactDeleteMany).not.toHaveBeenCalled();
    expect(mockUserDelete).toHaveBeenCalledTimes(1);
    expect(result.receiptId).toBe('receipt-1');
    expect(mockLogger.info).toHaveBeenCalledWith(
      'User erased',
      expect.objectContaining({ contactSubmissionsDeleted: 0 })
    );
    // …the rows left were counted on the stored address, exactly…
    expect(mockContactCount).toHaveBeenCalledWith({ where: { email: 'foo@bar.com' } });
    // …and flagged with that count, so an operator can answer the rest of the
    // request by hand (the address is not logged: it is PII)
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'Contact messages not erased: the account never verified its address',
      { userId: BASE_PARAMS.userId, receiptId: 'receipt-1', contactSubmissionsLeft: 2 }
    );
  });

  it('contact submissions — no warning for an unverified account with nothing under its address', async () => {
    // Arrange — the common case where verification is off: no messages at all
    mockUserFind.mockResolvedValue({ email: 'foo@bar.com', emailVerified: false });
    mockContactCount.mockResolvedValue(0);

    // Act
    await eraseUser(BASE_PARAMS);

    // Assert — a warning on every such erasure would teach operators to ignore it
    expect(mockContactCount).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it('contact submissions — no unverified-address warning for a verified account', async () => {
    // Act — beforeEach's stored address is verified
    await eraseUser(BASE_PARAMS);

    // Assert — deleted, not counted, and no warning
    expect(mockContactDeleteMany).toHaveBeenCalledTimes(1);
    expect(mockContactCount).not.toHaveBeenCalled();
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it('contact submissions — an address with `_` and `%` is matched as a literal string, not a pattern', async () => {
    // Arrange — under `mode: 'insensitive'` (ILIKE) `_` matches any one
    // character and `%` any run, so this would also delete `aXb@ex.com`'s
    // messages. An equality match on the literal string cannot.
    mockUserFind.mockResolvedValue({ email: 'a_b%c@ex.com', emailVerified: true });

    // Act
    await eraseUser(BASE_PARAMS);

    // Assert — exactly this filter: a plain string, no `mode`, no operator
    const [args] = mockContactDeleteMany.mock.calls[0] as [{ where: unknown }];
    expect(args).toEqual({ where: { email: 'a_b%c@ex.com' } });
  });

  it('contact submissions — deleted through the transaction client, before the user row', async () => {
    // Arrange — hand the callback a tx distinct from `prisma`, so a delete
    // issued on the outer client (outside the transaction) would miss it
    const txContactDeleteMany = vi.fn().mockResolvedValue({ count: 2 });
    const tx = { ...mockPrisma, contactSubmission: { deleteMany: txContactDeleteMany } };
    mockPrisma.$transaction.mockImplementation(
      (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)
    );

    // Act
    await eraseUser(BASE_PARAMS);

    // Assert — on the tx, not the outer client, and ahead of the user delete
    expect(txContactDeleteMany).toHaveBeenCalledTimes(1);
    expect(mockContactDeleteMany).not.toHaveBeenCalled();
    expect(txContactDeleteMany.mock.invocationCallOrder[0]).toBeLessThan(
      mockUserDelete.mock.invocationCallOrder[0]
    );
  });

  it('contact submissions — the number deleted is logged on the erasure line', async () => {
    // Arrange
    mockContactDeleteMany.mockResolvedValue({ count: 3 });

    // Act
    await eraseUser(BASE_PARAMS);

    // Assert — erased by address, not FK, so the log is its only trace
    expect(mockLogger.info).toHaveBeenCalledWith(
      'User erased',
      expect.objectContaining({ contactSubmissionsDeleted: 3 })
    );
  });

  it('contact submissions — a failed delete rolls the erasure back (the user row is never deleted)', async () => {
    // Arrange
    mockContactDeleteMany.mockRejectedValue(new Error('contact delete failed'));

    // Act + Assert — the throw escapes the transaction; nothing after it ran
    await expect(eraseUser(BASE_PARAMS)).rejects.toThrow('contact delete failed');
    expect(mockReceiptCreate).not.toHaveBeenCalled();
    expect(mockUserDelete).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Webhook deliveries outlive the subscription: the person's own address is
  // redacted from them (and from previousDestinations) inside the transaction
  // -------------------------------------------------------------------------

  describe('webhook delivery redaction', () => {
    /** The pass-1 writes: one conditional updateMany per retrying row, by id. */
    function retryingWrites(): Array<{
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }> {
      return (
        mockDeliveryUpdateMany.mock.calls as unknown as Array<
          [{ where: Record<string, unknown>; data: Record<string, unknown> }]
        >
      )
        .map(([args]) => args)
        .filter((args) => 'id' in args.where);
    }

    const UNTIL = '2026-01-01T00:00:00.000Z';

    type Row = Record<string, unknown>;

    /**
     * Route the two findMany passes by the shape of their where, so a test
     * states what each pass returns instead of depending on call order:
     * the retrying pass is `{ AND: [...] }`, the history pass is a bare
     * `previousDestinations` match.
     */
    function seed(rows: { retrying?: Row[]; movedOn?: Row[]; updateManyCount?: number }): void {
      mockDeliveryFindMany.mockImplementation(async (args: { where: Record<string, unknown> }) =>
        'AND' in args.where ? (rows.retrying ?? []) : (rows.movedOn ?? [])
      );
      mockDeliveryUpdateMany.mockResolvedValue({ count: rows.updateManyCount ?? 0 });
    }

    it('reads the retrying rows from the STORED address, normalised, restricted to pending/failed', async () => {
      // Arrange — the caller and the row disagree; the row is the authority
      mockUserFind.mockResolvedValue({ email: ' Stored@Bar.com ', emailVerified: true });

      // Act
      await eraseUser({ ...BASE_PARAMS, userEmail: 'caller-supplied@bar.com' });

      // Assert — pass (a): exact shape, normalised, no ILIKE mode
      expect(mockDeliveryFindMany).toHaveBeenCalledTimes(2);
      expect(mockDeliveryFindMany).toHaveBeenNthCalledWith(1, {
        where: {
          AND: [
            {
              OR: [
                { destination: 'stored@bar.com' },
                { previousDestinations: { array_contains: [{ destination: 'stored@bar.com' }] } },
              ],
            },
            { status: { in: ['pending', 'failed'] } },
          ],
        },
        select: { id: true, destination: true, previousDestinations: true, lastError: true },
      });
      // Pass (b) and (c) use the same stored address
      expect(mockDeliveryUpdateMany).toHaveBeenCalledWith({
        where: { destination: 'stored@bar.com' },
        data: { destination: '[erased]', destinationFingerprint: null },
      });
      expect(mockDeliveryFindMany).toHaveBeenNthCalledWith(2, {
        where: { previousDestinations: { array_contains: [{ destination: 'stored@bar.com' }] } },
        select: { id: true, previousDestinations: true },
      });
      expect(JSON.stringify(mockDeliveryFindMany.mock.calls)).not.toContain('caller-supplied');
      expect(JSON.stringify(mockDeliveryUpdateMany.mock.calls)).not.toContain('caller-supplied');
      expect(JSON.stringify(mockDeliveryFindMany.mock.calls)).not.toContain('insensitive');
    });

    it('is not scoped by the subscription the person owns: no pass filters on subscription or the user id', async () => {
      await eraseUser(BASE_PARAMS);

      const wheres = JSON.stringify([
        ...mockDeliveryFindMany.mock.calls,
        ...mockDeliveryUpdateMany.mock.calls,
      ]);
      expect(wheres).not.toContain('subscription');
      expect(wheres).not.toContain('createdBy');
      expect(wheres).not.toContain(BASE_PARAMS.userId);
    });

    it('makes no aiWebhookDelivery call at all for an unverified account', async () => {
      mockUserFind.mockResolvedValue({ email: 'foo@bar.com', emailVerified: false });

      await eraseUser(BASE_PARAMS);

      // Population: the erasure itself ran to completion.
      expect(mockUserDelete).toHaveBeenCalledTimes(1);
      expect(mockDeliveryFindMany).not.toHaveBeenCalled();
      expect(mockDeliveryUpdate).not.toHaveBeenCalled();
      expect(mockDeliveryUpdateMany).not.toHaveBeenCalled();
    });

    it('exhausts a retrying row to the composed lastError, keeping the real error, and erases its destination', async () => {
      seed({
        retrying: [
          {
            id: 'd-retry',
            destination: 'foo@bar.com',
            previousDestinations: null,
            lastError: 'SMTP 550 mailbox full',
          },
        ],
      });

      await eraseUser(BASE_PARAMS);

      // Conditional on the row still retrying, so one an attempt delivered
      // since the read stays delivered (t-793).
      expect(mockDeliveryUpdate).not.toHaveBeenCalled();
      expect(retryingWrites()).toHaveLength(1);
      expect(mockDeliveryUpdateMany).toHaveBeenCalledWith({
        where: { id: 'd-retry', status: { in: ['pending', 'failed'] } },
        data: {
          status: 'exhausted',
          nextRetryAt: null,
          lastError: 'SMTP 550 mailbox full (not retried: recipient erased)',
          destination: '[erased]',
          destinationFingerprint: null,
        },
      });
    });

    it('exhausts a retrying row with no recorded error to the bare "Not retried" message', async () => {
      seed({
        retrying: [
          { id: 'd-new', destination: 'foo@bar.com', previousDestinations: null, lastError: null },
        ],
      });

      await eraseUser(BASE_PARAMS);

      const args = retryingWrites()[0];
      expect(args.data.lastError).toBe('Not retried: recipient erased');
      expect(args.data.status).toBe('exhausted');
    });

    it('stops a retrying row whose destination is someone else and only the history names them, without touching the destination', async () => {
      seed({
        retrying: [
          {
            id: 'd-moved',
            destination: 'someone-else@bar.com',
            lastError: 'boom',
            previousDestinations: [
              { destination: 'foo@bar.com', destinationFingerprint: 'v1:a', until: UNTIL },
            ],
          },
        ],
      });

      await eraseUser(BASE_PARAMS);

      const args = retryingWrites()[0];
      expect(args.data).toEqual({
        status: 'exhausted',
        nextRetryAt: null,
        lastError: 'boom (not retried: recipient erased)',
        previousDestinations: [
          { destination: '[erased]', destinationFingerprint: null, until: UNTIL },
        ],
      });
      expect(args.data).not.toHaveProperty('destination');
    });

    it('redacts a delivered row only through updateMany, with no per-row update', async () => {
      // A delivered row is not "retrying", so pass (a) returns nothing for it.
      seed({ retrying: [], updateManyCount: 3 });

      await eraseUser(BASE_PARAMS);

      expect(mockDeliveryUpdateMany).toHaveBeenCalledTimes(1);
      expect(mockDeliveryUpdateMany).toHaveBeenCalledWith({
        where: { destination: 'foo@bar.com' },
        data: { destination: '[erased]', destinationFingerprint: null },
      });
      expect(mockDeliveryUpdate).not.toHaveBeenCalled();
    });

    it('writes only previousDestinations for a history-only row, and never touches its status', async () => {
      seed({
        movedOn: [
          {
            id: 'd-history',
            previousDestinations: [
              { destination: 'foo@bar.com', destinationFingerprint: 'v1:a', until: UNTIL },
              {
                destination: 'https://hooks.example.com',
                destinationFingerprint: 'v1:b',
                until: UNTIL,
              },
            ],
          },
        ],
      });

      await eraseUser(BASE_PARAMS);

      expect(mockDeliveryUpdate).toHaveBeenCalledTimes(1);
      expect(mockDeliveryUpdate).toHaveBeenCalledWith({
        where: { id: 'd-history' },
        data: {
          previousDestinations: [
            { destination: '[erased]', destinationFingerprint: null, until: UNTIL },
            {
              destination: 'https://hooks.example.com',
              destinationFingerprint: 'v1:b',
              until: UNTIL,
            },
          ],
        },
      });
    });

    it('skips the update for a history row whose entries name nobody erased', async () => {
      // e.g. the JSONB containment matched but the normalised compare does not
      seed({
        movedOn: [
          {
            id: 'd-nochange',
            previousDestinations: [
              { destination: 'other@bar.com', destinationFingerprint: 'v1:x', until: UNTIL },
            ],
          },
        ],
      });

      await eraseUser(BASE_PARAMS);

      expect(mockDeliveryUpdate).not.toHaveBeenCalled();
    });

    it('does not write previousDestinations on a retrying row whose history names nobody erased', async () => {
      seed({
        retrying: [
          {
            id: 'd-current',
            destination: 'foo@bar.com',
            lastError: null,
            previousDestinations: [
              { destination: 'other@bar.com', destinationFingerprint: 'v1:x', until: UNTIL },
            ],
          },
        ],
      });

      await eraseUser(BASE_PARAMS);

      const args = retryingWrites()[0];
      expect(args.data).not.toHaveProperty('previousDestinations');
    });

    it('logs webhookDeliveriesRedacted as retrying + updateMany count + history rows', async () => {
      seed({
        retrying: [
          { id: 'r1', destination: 'foo@bar.com', previousDestinations: null, lastError: null },
          { id: 'r2', destination: 'foo@bar.com', previousDestinations: null, lastError: null },
        ],
        updateManyCount: 5,
        movedOn: [
          {
            id: 'm1',
            previousDestinations: [
              { destination: 'foo@bar.com', destinationFingerprint: 'v1:a', until: UNTIL },
            ],
          },
        ],
      });

      await eraseUser(BASE_PARAMS);

      expect(mockLogger.info).toHaveBeenCalledWith(
        'User erased',
        expect.objectContaining({ webhookDeliveriesRedacted: 2 + 5 + 1 })
      );
    });

    it('logs webhookDeliveriesRedacted as 0 for an unverified account', async () => {
      mockUserFind.mockResolvedValue({ email: 'foo@bar.com', emailVerified: false });

      await eraseUser(BASE_PARAMS);

      expect(mockLogger.info).toHaveBeenCalledWith(
        'User erased',
        expect.objectContaining({ webhookDeliveriesRedacted: 0 })
      );
    });

    it('runs every delivery pass before tx.user.delete', async () => {
      const callOrder: string[] = [];
      mockDeliveryFindMany.mockImplementation(async (args: { where: Record<string, unknown> }) => {
        if ('AND' in args.where) {
          callOrder.push('findMany:retrying');
          return [
            { id: 'r1', destination: 'foo@bar.com', previousDestinations: null, lastError: null },
          ];
        }
        callOrder.push('findMany:history');
        return [
          {
            id: 'm1',
            previousDestinations: [
              { destination: 'foo@bar.com', destinationFingerprint: 'v1:a', until: UNTIL },
            ],
          },
        ];
      });
      mockDeliveryUpdateMany.mockImplementation(async () => {
        callOrder.push('updateMany');
        return { count: 1 };
      });
      mockDeliveryUpdate.mockImplementation(async () => {
        callOrder.push('update');
        return {};
      });
      mockUserDelete.mockImplementation(async () => {
        callOrder.push('user.delete');
        return { id: BASE_PARAMS.userId };
      });

      await eraseUser(BASE_PARAMS);

      expect(callOrder).toEqual([
        'findMany:retrying',
        'updateMany',
        'updateMany',
        'findMany:history',
        'update',
        'user.delete',
      ]);
    });

    it('a failed redaction rolls the erasure back: the user row is never deleted', async () => {
      seed({
        retrying: [
          { id: 'd-1', destination: 'foo@bar.com', previousDestinations: null, lastError: null },
        ],
      });
      mockDeliveryUpdateMany.mockRejectedValueOnce(new Error('redaction failed'));

      await expect(eraseUser(BASE_PARAMS)).rejects.toThrow('redaction failed');

      expect(mockUserDelete).not.toHaveBeenCalled();
      expect(mockReceiptCreate).not.toHaveBeenCalled();
    });

    it('a failed updateMany rolls the erasure back too', async () => {
      mockDeliveryUpdateMany.mockRejectedValue(new Error('bulk redaction failed'));

      await expect(eraseUser(BASE_PARAMS)).rejects.toThrow('bulk redaction failed');

      expect(mockUserDelete).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // t-786: colleagues' email subscriptions that notify the erased person
  // -------------------------------------------------------------------------

  describe('colleague email subscriptions (t-786)', () => {
    type Sub = {
      id: string;
      emailAddress: string | null;
      isActive: boolean;
      orgId: string | null;
      createdBy: string;
    };

    /** A candidate row as the `findMany` returns it; override what a test cares about. */
    function sub(overrides: Partial<Sub> & { id: string }): Sub {
      return {
        emailAddress: 'foo@bar.com',
        isActive: true,
        orgId: 'org-a',
        createdBy: 'owner-1',
        ...overrides,
      };
    }

    it('asks for other people’s email subscriptions only, by an exact where on the erased user', async () => {
      await eraseUser(BASE_PARAMS);

      // The erased user's own subscriptions are excluded by the where (they
      // cascade with the user row); the address is compared in code, so the
      // query carries no address at all.
      expect(mockSubFindMany).toHaveBeenCalledTimes(1);
      expect(mockSubFindMany).toHaveBeenCalledWith({
        where: {
          channel: 'email',
          emailAddress: { not: null },
          createdBy: { not: BASE_PARAMS.userId },
        },
        select: { id: true, emailAddress: true, isActive: true, orgId: true, createdBy: true },
      });
      expect(JSON.stringify(mockSubFindMany.mock.calls)).not.toContain('insensitive');
    });

    it('clears exactly the subscriptions whose normalised address is the STORED one, whatever case or whitespace they were typed in', async () => {
      // Arrange — stored form is not canonical, and differs from the caller's copy
      mockUserFind.mockResolvedValue({ email: '  Stored@BAR.com ', emailVerified: true });
      mockSubFindMany.mockResolvedValue([
        sub({ id: 'sub-exact', emailAddress: 'stored@bar.com' }),
        sub({ id: 'sub-case', emailAddress: 'STORED@Bar.COM' }),
        sub({ id: 'sub-tab', emailAddress: '\tstored@bar.com \t' }),
        sub({ id: 'sub-other', emailAddress: 'someone-else@bar.com' }),
        sub({ id: 'sub-caller', emailAddress: 'caller-supplied@bar.com' }),
        sub({ id: 'sub-prefix', emailAddress: 'xstored@bar.com' }),
        sub({ id: 'sub-null', emailAddress: null }),
      ]);

      // Act
      await eraseUser({ ...BASE_PARAMS, userEmail: 'caller-supplied@bar.com' });

      // Assert — matched in code on the stored address; the caller's copy is ignored
      expect(mockSubUpdateMany).toHaveBeenCalledTimes(1);
      expect(mockSubUpdateMany).toHaveBeenCalledWith({
        where: { id: { in: ['sub-exact', 'sub-case', 'sub-tab'] } },
        data: { emailAddress: null, isActive: false },
      });
      expect(
        mockAuditCreateMany.mock.calls[0][0].data.map((row: { entityId: string }) => row.entityId)
      ).toEqual(['sub-exact', 'sub-case', 'sub-tab']);
    });

    it('writes one audit entry per cleared subscription, recording its prior isActive, never the address', async () => {
      // Arrange
      mockSubFindMany.mockResolvedValue([
        sub({ id: 'sub-1', orgId: 'org-a', createdBy: 'owner-1', isActive: true }),
        sub({
          id: 'sub-2',
          orgId: null,
          createdBy: 'owner-2',
          isActive: false,
          emailAddress: ' FOO@bar.com ',
        }),
      ]);
      mockUserFind.mockResolvedValue({ email: ' Foo@BAR.com ', emailVerified: true });

      // Act
      await eraseUser(BASE_PARAMS);

      // Assert
      expect(mockAuditCreateMany).toHaveBeenCalledTimes(1);
      const reason = 'The person this subscription emailed was erased.';
      expect(mockAuditCreateMany).toHaveBeenCalledWith({
        data: [
          {
            userId: BASE_PARAMS.actorUserId,
            action: 'webhook_subscription.recipient_erased',
            entityType: 'webhook_subscription',
            entityId: 'sub-1',
            entityName: 'sub-1',
            changes: {
              emailAddress: { from: '[erased]', to: null },
              isActive: { from: true, to: false },
            },
            metadata: { reason, ownerUserId: 'owner-1', orgId: 'org-a' },
          },
          {
            userId: BASE_PARAMS.actorUserId,
            action: 'webhook_subscription.recipient_erased',
            entityType: 'webhook_subscription',
            entityId: 'sub-2',
            entityName: 'sub-2',
            changes: {
              emailAddress: { from: '[erased]', to: null },
              isActive: { from: false, to: false },
            },
            metadata: { reason, ownerUserId: 'owner-2', orgId: null },
          },
        ],
      });
      // The log is kept through erasure and the address is what is erased
      const serialised = JSON.stringify(mockAuditCreateMany.mock.calls).toLowerCase();
      expect(serialised).not.toContain('foo@bar.com');
    });

    it('writes nothing when no subscription matches the address', async () => {
      mockSubFindMany.mockResolvedValue([sub({ id: 'sub-other', emailAddress: 'nobody@bar.com' })]);

      await eraseUser(BASE_PARAMS);

      // Population: the candidates were read and the erasure completed
      expect(mockSubFindMany).toHaveBeenCalledTimes(1);
      expect(mockUserDelete).toHaveBeenCalledTimes(1);
      expect(mockSubUpdateMany).not.toHaveBeenCalled();
      expect(mockAuditCreateMany).not.toHaveBeenCalled();
    });

    it('reads, updates and audits nothing for an unverified address', async () => {
      mockUserFind.mockResolvedValue({ email: 'foo@bar.com', emailVerified: false });
      mockSubFindMany.mockResolvedValue([sub({ id: 'sub-1' })]);

      await eraseUser(BASE_PARAMS);

      // Population: the erasure itself ran
      expect(mockUserDelete).toHaveBeenCalledTimes(1);
      expect(mockSubFindMany).not.toHaveBeenCalled();
      expect(mockSubUpdateMany).not.toHaveBeenCalled();
      expect(mockAuditCreateMany).not.toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith(
        'User erased',
        expect.objectContaining({ subscriptionsDeactivated: 0 })
      );
    });

    it('logs the number of subscriptions deactivated', async () => {
      mockSubFindMany.mockResolvedValue([
        sub({ id: 'sub-1' }),
        sub({ id: 'sub-2', emailAddress: 'FOO@bar.com' }),
        sub({ id: 'sub-3', orgId: 'org-b', createdBy: 'owner-2', isActive: false }),
        sub({ id: 'sub-skipped', emailAddress: 'other@bar.com' }),
      ]);

      await eraseUser(BASE_PARAMS);

      expect(mockLogger.info).toHaveBeenCalledWith(
        'User erased',
        expect.objectContaining({ subscriptionsDeactivated: 3 })
      );
    });

    it('clears subscriptions first: before the delivery-address passes, the payload passes and tx.user.delete', async () => {
      const callOrder: string[] = [];
      mockSubFindMany.mockImplementation(async () => {
        callOrder.push('subscription.findMany');
        return [sub({ id: 'sub-1' })];
      });
      mockSubUpdateMany.mockImplementation(async () => {
        callOrder.push('subscription.updateMany');
        return { count: 1 };
      });
      mockAuditCreateMany.mockImplementation(async () => {
        callOrder.push('audit.createMany');
        return { count: 1 };
      });
      mockDeliveryFindMany.mockImplementation(async () => {
        callOrder.push('delivery.findMany');
        return [];
      });
      mockDeliveryUpdateMany.mockImplementation(async () => {
        callOrder.push('delivery.updateMany');
        return { count: 0 };
      });
      mockEraseDeliveries.mockImplementation(async () => {
        callOrder.push('eraseSubjectFromDeliveries');
        return 0;
      });
      mockUserDelete.mockImplementation(async () => {
        callOrder.push('user.delete');
        return { id: BASE_PARAMS.userId };
      });

      await eraseUser(BASE_PARAMS);

      expect(callOrder).toEqual([
        'subscription.findMany',
        'subscription.updateMany',
        'audit.createMany',
        'delivery.findMany',
        'delivery.updateMany',
        'delivery.findMany',
        'eraseSubjectFromDeliveries',
        'eraseSubjectFromDeliveries',
        'user.delete',
      ]);
    });

    it('a failed subscription read rolls the erasure back: the user row is never deleted', async () => {
      mockSubFindMany.mockRejectedValue(new Error('subscription read failed'));

      await expect(eraseUser(BASE_PARAMS)).rejects.toThrow('subscription read failed');

      expect(mockUserDelete).not.toHaveBeenCalled();
      expect(mockReceiptCreate).not.toHaveBeenCalled();
    });

    it('a failed subscription update rolls the erasure back: the user row is never deleted', async () => {
      mockSubFindMany.mockResolvedValue([sub({ id: 'sub-1' })]);
      mockSubUpdateMany.mockRejectedValue(new Error('subscription clear failed'));

      await expect(eraseUser(BASE_PARAMS)).rejects.toThrow('subscription clear failed');

      expect(mockAuditCreateMany).not.toHaveBeenCalled();
      expect(mockUserDelete).not.toHaveBeenCalled();
      expect(mockReceiptCreate).not.toHaveBeenCalled();
    });

    it('a failed audit write rolls the erasure back: the user row is never deleted', async () => {
      mockSubFindMany.mockResolvedValue([sub({ id: 'sub-1' })]);
      mockAuditCreateMany.mockRejectedValue(new Error('audit write failed'));

      await expect(eraseUser(BASE_PARAMS)).rejects.toThrow('audit write failed');

      expect(mockUserDelete).not.toHaveBeenCalled();
    });
  });

  it('runs the erasure transaction with the 60s timeout, not Prisma’s 5s default', async () => {
    await eraseUser(BASE_PARAMS);

    expect(ERASURE_TRANSACTION_TIMEOUT_MS).toBe(60_000);
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    expect(mockPrisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      timeout: ERASURE_TRANSACTION_TIMEOUT_MS,
    });
  });

  // -------------------------------------------------------------------------
  // t-783: delivery payloads that name the person
  // -------------------------------------------------------------------------

  describe('config that names the user (t-791)', () => {
    it('passes the transaction client, the user id, the STORED normalised address and the actor', async () => {
      const tx = { ...mockPrisma };
      mockPrisma.$transaction.mockImplementation(
        (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)
      );
      mockUserFind.mockResolvedValue({ email: '  New@Bar.COM ', emailVerified: true });

      await eraseUser({ ...BASE_PARAMS, userEmail: 'old@bar.com' });

      expect(mockEraseConfig).toHaveBeenCalledTimes(1);
      expect(mockEraseConfig).toHaveBeenCalledWith(tx, {
        userId: BASE_PARAMS.userId,
        address: 'new@bar.com',
        actorUserId: BASE_PARAMS.actorUserId,
      });
    });

    it('passes a null address for an unverified account, so only the approver id is matched', async () => {
      mockUserFind.mockResolvedValue({ email: 'foo@bar.com', emailVerified: false });

      await eraseUser(BASE_PARAMS);

      expect(mockEraseConfig).toHaveBeenCalledWith(expect.anything(), {
        userId: BASE_PARAMS.userId,
        address: null,
        actorUserId: BASE_PARAMS.actorUserId,
      });
    });

    it('runs after the delivery passes, just before the receipt and tx.user.delete', async () => {
      // Its row locks (the settings singleton among them) are then held only
      // until the commit, not through the longest part of the transaction.
      const callOrder: string[] = [];
      mockEraseDeliveries.mockImplementation(async (_tx: unknown, table: string) => {
        callOrder.push(`deliveries:${table}`);
        return 0;
      });
      mockEraseConfig.mockImplementation(async () => {
        callOrder.push('config');
        return { escalationListsChanged: 0, workflowsChanged: 0 };
      });
      mockReceiptCreate.mockImplementation(async () => {
        callOrder.push('receipt');
        return { id: 'receipt-1', erasedAt: new Date('2026-01-01T00:00:00.000Z') };
      });
      mockUserDelete.mockImplementation(async () => {
        callOrder.push('user.delete');
        return { id: BASE_PARAMS.userId };
      });

      await eraseUser(BASE_PARAMS);

      expect(callOrder).toEqual([
        'deliveries:webhook',
        'deliveries:hook',
        'config',
        'receipt',
        'user.delete',
      ]);
    });

    it('logs both counts and clears the settings cache when an escalation list changed', async () => {
      mockEraseConfig.mockResolvedValue({ escalationListsChanged: 1, workflowsChanged: 3 });

      await eraseUser(BASE_PARAMS);

      expect(mockLogger.info).toHaveBeenCalledWith(
        'User erased',
        expect.objectContaining({ escalationListsChanged: 1, workflowsChanged: 3 })
      );
      expect(mockInvalidateSettings).toHaveBeenCalledTimes(1);
    });

    it('leaves the settings cache alone when no escalation list changed', async () => {
      mockEraseConfig.mockResolvedValue({ escalationListsChanged: 0, workflowsChanged: 2 });

      await eraseUser(BASE_PARAMS);

      expect(mockInvalidateSettings).not.toHaveBeenCalled();
    });

    it('a failed rewrite rolls the erasure back: no receipt, the user row is never deleted', async () => {
      mockEraseConfig.mockRejectedValue(new Error('config rewrite failed'));

      await expect(eraseUser(BASE_PARAMS)).rejects.toThrow('config rewrite failed');

      expect(mockReceiptCreate).not.toHaveBeenCalled();
      expect(mockUserDelete).not.toHaveBeenCalled();
      expect(mockInvalidateSettings).not.toHaveBeenCalled();
    });
  });

  describe('delivery payload redaction (t-783)', () => {
    it('redacts both delivery tables for the user, through the transaction client', async () => {
      // Arrange — a tx distinct from `prisma`, so a call on the outer client misses it
      const tx = { ...mockPrisma };
      mockPrisma.$transaction.mockImplementation(
        (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)
      );

      // Act
      await eraseUser(BASE_PARAMS);

      // Assert
      expect(mockEraseDeliveries).toHaveBeenCalledTimes(2);
      expect(mockEraseDeliveries).toHaveBeenNthCalledWith(1, tx, 'webhook', BASE_PARAMS.userId);
      expect(mockEraseDeliveries).toHaveBeenNthCalledWith(2, tx, 'hook', BASE_PARAMS.userId);
    });

    it('redacts for the user even when the address is unverified', async () => {
      // The payload match is on the user id, not the address
      mockUserFind.mockResolvedValue({ email: 'foo@bar.com', emailVerified: false });

      await eraseUser(BASE_PARAMS);

      expect(mockEraseDeliveries).toHaveBeenCalledTimes(2);
      expect(mockUserDelete).toHaveBeenCalledTimes(1);
    });

    it('runs both redactions before tx.user.delete', async () => {
      const callOrder: string[] = [];
      mockEraseDeliveries.mockImplementation(async (_tx: unknown, table: string) => {
        callOrder.push(`deliveries:${table}`);
        return 0;
      });
      mockUserDelete.mockImplementation(async () => {
        callOrder.push('user.delete');
        return { id: BASE_PARAMS.userId };
      });

      await eraseUser(BASE_PARAMS);

      expect(callOrder).toEqual(['deliveries:webhook', 'deliveries:hook', 'user.delete']);
    });

    it('logs each table’s redacted count separately', async () => {
      mockEraseDeliveries.mockImplementation(async (_tx: unknown, table: string) =>
        table === 'webhook' ? 4 : 7
      );

      await eraseUser(BASE_PARAMS);

      expect(mockLogger.info).toHaveBeenCalledWith(
        'User erased',
        expect.objectContaining({ webhookPayloadsRedacted: 4, eventHookPayloadsRedacted: 7 })
      );
    });

    it('a failed redaction rolls the erasure back: the user row is never deleted', async () => {
      mockEraseDeliveries.mockRejectedValue(new Error('payload redaction failed'));

      await expect(eraseUser(BASE_PARAMS)).rejects.toThrow('payload redaction failed');

      expect(mockUserDelete).not.toHaveBeenCalled();
      expect(mockReceiptCreate).not.toHaveBeenCalled();
    });
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

  describe('the tenant scope (§107 t-748)', () => {
    const ACTIVE_ORG = 'cmorg00000000000000active';

    /** The context each phase saw: the external hook, the in-transaction scrub, the delete. */
    function recordPhases(): Array<{ phase: string; orgId: string | null; source: string } | null> {
      const seen: Array<{ phase: string; orgId: string | null; source: string } | null> = [];
      const record = (phase: string) => {
        const ctx = getTenantContext();
        seen.push(ctx ? { phase, orgId: ctx.orgId, source: ctx.source } : null);
      };
      registerErasureCleanupHook({
        name: 'hook-scope',
        cleanupExternal: async () => record('external'),
        scrubInTransaction: async () => record('scrub'),
      });
      mockUserDelete.mockImplementation(async () => {
        record('delete');
        return { id: BASE_PARAMS.userId };
      });
      return seen;
    }

    it('runs every hook phase and the transaction in the system scope at multi, whatever org the caller is in', async () => {
      // A person's rows can sit in several orgs. A session enters its active
      // org, where a hook clearing a tenant-owned table would reach only that
      // org; an admin API key enters none, where it would throw.
      mockEnv.TENANCY_MODE = 'multi';
      const seen = recordPhases();

      await runAsOrg(ACTIVE_ORG, () => eraseUser(BASE_PARAMS), { source: 'session' });
      await eraseUser(BASE_PARAMS);

      const phases = ['external', 'scrub', 'delete'].map((phase) => ({
        phase,
        orgId: null,
        source: 'system',
      }));
      expect(seen).toEqual([...phases, ...phases]);
    });

    it('enters no scope at single, so a hook keeps the caller’s org (or the implicit install org)', async () => {
      const seen = recordPhases();

      await runAsOrg(ACTIVE_ORG, () => eraseUser(BASE_PARAMS), { source: 'session' });
      await eraseUser(BASE_PARAMS);

      const inSession = ['external', 'scrub', 'delete'].map((phase) => ({
        phase,
        orgId: ACTIVE_ORG,
        source: 'session',
      }));
      expect(seen).toEqual([...inSession, null, null, null]);
    });
  });
});
