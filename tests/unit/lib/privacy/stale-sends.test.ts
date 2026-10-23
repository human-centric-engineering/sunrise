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

import {
  NOBODY_ERASED,
  SENDER_LOCK_WAIT_MS,
  decideDeliveryUnderLocks,
  sendHoldingSubjects,
  settleStoppedDelivery,
} from '@/lib/privacy/stale-sends';
import { COPY_CLOCK_SKEW_MS, subjectEmailHash } from '@/lib/privacy/erased-subjects';

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
    expect(tx.$executeRaw.mock.calls[0]).toContain(`${SENDER_LOCK_WAIT_MS}ms`);
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
      timeout: SENDER_LOCK_WAIT_MS + 15_000 + 10_000,
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

describe('decideDeliveryUnderLocks (owner ruling, 2026-10-22)', () => {
  const delivery = {
    eventType: 'message.created',
    payload: { event: 'message.created', data: { userId: 'u-1' } },
    createdAt: takenAt,
  };

  /** Run the decision, recording whether `send` ran inside the transaction. */
  async function decide(holdAcrossSend: boolean) {
    let inTx = false;
    prismaMock.$transaction.mockImplementation(
      async (run: (client: typeof tx) => Promise<unknown>) => {
        inTx = true;
        try {
          return await run(tx);
        } finally {
          inTx = false;
        }
      }
    );
    const sentInTx: boolean[] = [];
    const settle = vi.fn().mockResolvedValue(undefined);
    const result = await decideDeliveryUnderLocks(
      delivery,
      null,
      takenAt,
      { sendTimeoutMs: 15_000, holdAcrossSend },
      settle,
      async () => {
        sentInTx.push(inTx);
        return 'sent';
      }
    );
    return { result, sentInTx, settle };
  }

  it('posts a webhook or hook after the decision commits: no connection held across it', async () => {
    const { result, sentInTx, settle } = await decide(false);

    expect(result).toBe('sent');
    expect(sentInTx).toEqual([false]);
    expect(settle).toHaveBeenCalledWith(tx, { kind: 'send', payload: null });
    // The transaction is given no send time, only the lock wait.
    expect(prismaMock.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      timeout: SENDER_LOCK_WAIT_MS + 0 + 10_000,
      maxWait: 10_000,
    });
  });

  it('sends an email under the locks, until it settles', async () => {
    const { result, sentInTx } = await decide(true);

    expect(result).toBe('sent');
    expect(sentInTx).toEqual([true]);
    expect(prismaMock.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      timeout: SENDER_LOCK_WAIT_MS + 15_000 + 10_000,
      maxWait: 10_000,
    });
  });

  it('settles a stop inside the transaction and sends nothing', async () => {
    tx.dataErasureReceipt.findMany.mockResolvedValue([
      { subjectUserId: 'u-1', subjectEmailHash: null, metadata: null },
    ]);
    const send = vi.fn();
    const settle = vi.fn().mockResolvedValue(undefined);

    const result = await decideDeliveryUnderLocks(
      delivery,
      null,
      takenAt,
      { sendTimeoutMs: 5_000, holdAcrossSend: false },
      settle,
      send
    );

    expect(result).toBeNull();
    expect(send).not.toHaveBeenCalled();
    expect(settle).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ kind: 'stop', reason: 'subject erased' })
    );
  });
});

describe('decideDeliveryUnderLocks: two anchors (code review round 3)', () => {
  it('checks the payload against the row’s age and the address against this read', async () => {
    const createdAt = new Date(takenAt.getTime() - 10 * 24 * 60 * 60_000);
    const erasedAt = new Date(takenAt.getTime() - 5 * 24 * 60 * 60_000);
    // A receipt for the address, from between the row's event and this read.
    tx.dataErasureReceipt.findMany.mockImplementation(
      async (args: { where: { erasedAt?: { gte: Date } } }) =>
        !args.where.erasedAt || args.where.erasedAt.gte <= erasedAt
          ? [
              {
                subjectUserId: 'gone',
                subjectEmailHash: subjectEmailHash('back@example.com'),
                metadata: { addressVerified: true },
              },
            ]
          : []
    );
    const send = vi.fn().mockResolvedValue('sent');
    const settle = vi.fn().mockResolvedValue(undefined);

    const result = await decideDeliveryUnderLocks(
      { eventType: 'e', payload: { event: 'e', data: {} }, createdAt },
      'back@example.com',
      takenAt,
      { sendTimeoutMs: 15_000, holdAcrossSend: true },
      settle,
      send
    );

    // Re-entered on the subscription after that erasure: sent.
    expect(result).toBe('sent');
    expect(settle).toHaveBeenCalledWith(tx, { kind: 'send', payload: null });
  });
});

describe('settleStoppedDelivery (t-926)', () => {
  function client() {
    return {
      aiWebhookDelivery: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      aiEventHookDelivery: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
  }
  const where = { id: 'd-1', status: { in: ['pending', 'failed'] } };

  it('stops a hook row as erasure stops one, redacted payload included', async () => {
    const c = client();
    const payload = { event: 'message.created', data: { userId: null } };

    await settleStoppedDelivery(
      c as never,
      'hook',
      { id: 'd-1', lastError: null },
      { reason: 'subject erased', payload }
    );

    expect(c.aiWebhookDelivery.updateMany).not.toHaveBeenCalled();
    expect(c.aiEventHookDelivery.updateMany).toHaveBeenCalledWith({
      where,
      data: {
        status: 'exhausted',
        nextRetryAt: null,
        stoppedByErasure: true,
        lastError: 'Not retried: subject erased',
        payload,
      },
    });
  });

  it('stops a webhook row, clearing its address when given, and leaves a null payload alone', async () => {
    const c = client();

    await settleStoppedDelivery(
      c as never,
      'webhook',
      { id: 'd-1', lastError: 'HTTP 500' },
      { reason: 'recipient erased', payload: null },
      { destination: '[erased]', destinationFingerprint: null }
    );

    expect(c.aiEventHookDelivery.updateMany).not.toHaveBeenCalled();
    const [args] = c.aiWebhookDelivery.updateMany.mock.calls[0] as [
      { where: unknown; data: Record<string, unknown> },
    ];
    expect(args.where).toEqual(where);
    expect(args.data).toMatchObject({
      status: 'exhausted',
      stoppedByErasure: true,
      destination: '[erased]',
      destinationFingerprint: null,
    });
    expect(args.data.lastError).toMatch(/HTTP 500.*recipient erased/);
    expect(args.data).not.toHaveProperty('payload');
  });
});

describe('decideDeliveryUnderLocks with subjects already resolved (t-926)', () => {
  it('uses them, looking nothing up', async () => {
    const lookups = { conversation: vi.fn(), execution: vi.fn() };
    Object.assign(prismaMock, {
      aiConversation: { findUnique: lookups.conversation },
      aiWorkflowExecution: { findUnique: lookups.execution },
    });

    const result = await decideDeliveryUnderLocks(
      {
        eventType: 'budget_exceeded',
        payload: { event: 'budget_exceeded', data: { conversationId: 'conv-1' } },
        createdAt: takenAt,
      },
      null,
      takenAt,
      {
        sendTimeoutMs: 15_000,
        holdAcrossSend: false,
        subjects: { userIds: new Map([['u-9', 'activity']]), dangling: false, runStartedAt: null },
      },
      vi.fn().mockResolvedValue(undefined),
      async () => 'sent'
    );

    expect(result).toBe('sent');
    expect(lookups.conversation).not.toHaveBeenCalled();
    expect(lookups.execution).not.toHaveBeenCalled();
    // The resolved owner is still locked and checked.
    expect(tx.dataErasureReceipt.findMany).toHaveBeenCalled();
  });
});
