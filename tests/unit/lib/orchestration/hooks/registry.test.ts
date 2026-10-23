/**
 * Tests: Event Hook Registry & Dispatcher
 *
 * Covers: emit → dispatch → webhook delivery (with persisted delivery records
 * and retry scheduling). Also covers `retryHookDelivery` and
 * `processPendingHookRetries`.
 *
 * @see lib/orchestration/hooks/registry.ts
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// ─── Module mocks ───────────────────────────────────────────────────────

// `after()` records what it was handed (t-903); the real one throws outside a
// request scope.
const mockAfter = vi.hoisted(() => vi.fn());
vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/server')>()),
  after: mockAfter,
}));

vi.mock('@/lib/db/client', () => {
  const prisma = {
    aiEventHook: {
      findMany: vi.fn(),
    },
    aiEventHookDelivery: {
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      updateManyAndReturn: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
    // Who a payload's conversation or run belongs to (t-886).
    aiConversation: { findUnique: vi.fn().mockResolvedValue({ userId: null }) },
    aiWorkflowExecution: { findUnique: vi.fn().mockResolvedValue({ userId: null }) },
    dataErasureReceipt: { findFirst: vi.fn().mockResolvedValue(null) },
  };
  // The erasure check's transaction runs on the same mock.
  return {
    prisma: {
      ...prisma,
      $transaction: vi.fn((run: (tx: typeof prisma) => Promise<unknown>) => run(prisma)),
    },
  };
});

// Who the receipt check reports erased since the copy was taken (t-886).
// The lock statements and the receipt query are `erased-subjects.test.ts`'s
// and `stale-sends.test.ts`'s; here, what the sender does with the answer.
// The transaction is the prisma mock, so a write in it is a write on `prisma`.
const erasedSince = vi.hoisted(() => ({
  addresses: [] as string[],
  userIds: [] as string[],
  fail: null as Error | null,
}));
vi.mock('@/lib/privacy/erased-subjects', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/privacy/erased-subjects')>()),
  boundLockWaits: vi.fn().mockResolvedValue(undefined),
  findErasedSubjects: vi.fn(() =>
    erasedSince.fail
      ? Promise.reject(erasedSince.fail)
      : Promise.resolve({ addresses: erasedSince.addresses, userIds: erasedSince.userIds })
  ),
}));

vi.mock('@/lib/logging', () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// ─── Imports ────────────────────────────────────────────────────────────

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import {
  emitHookEvent,
  invalidateHookCache,
  retryHookDelivery,
  processPendingHookRetries,
} from '@/lib/orchestration/hooks/registry';
import { describeDestination } from '@/lib/orchestration/webhooks/destination';
import { findErasedSubjects } from '@/lib/privacy/erased-subjects';

// ─── Fixtures ───────────────────────────────────────────────────────────

function makeHook(overrides: Record<string, unknown> = {}) {
  return {
    orgId: null,
    id: 'hook-1',
    name: 'Test Hook',
    eventType: 'conversation.started',
    action: { type: 'webhook', url: 'https://example.com/hook' },
    filter: null,
    isEnabled: true,
    secret: null,
    createdBy: 'user-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeDelivery(overrides: Record<string, unknown> = {}) {
  return {
    orgId: null,
    id: 'del-1',
    hookId: 'hook-1',
    eventType: 'conversation.started',
    payload: { eventType: 'conversation.started', timestamp: '2026-04-23T00:00:00Z', data: {} },
    status: 'pending',
    attempts: 0,
    lastAttemptAt: null,
    nextRetryAt: null,
    lastResponseCode: null,
    lastError: null,
    createdAt: new Date(),
    destination: null,
    destinationFingerprint: null,
    previousDestinations: null,
    stoppedByErasure: false,
    ...overrides,
  };
}

/** Where an outcome write must match: only a row still waiting to send (t-793). */
const AWAITING_STATUS = { in: ['pending', 'failed'] };

/**
 * The row an in-process retry timer re-reads: `failed`, with the `nextRetryAt`
 * the failed attempt wrote when it armed the timer. Read from the latest
 * outcome write rather than hard-coded, because the code computes it from the
 * clock. Call it when the timer fires (inside a `mockImplementationOnce`), not
 * when the mock is queued: nothing has been written by then.
 */
function armedRow(overrides: Record<string, unknown> = {}) {
  const calls = vi.mocked(prisma.aiEventHookDelivery.updateMany).mock.calls;
  const written = (calls.at(-1)?.[0] as { data?: { nextRetryAt?: unknown } } | undefined)?.data
    ?.nextRetryAt;
  return makeDelivery({
    status: 'failed',
    nextRetryAt: written instanceof Date ? written : null,
    ...overrides,
  });
}

// ─── Tests ──────────────────────────────────────────────────────────────

/** Whether `promise` has settled, without waiting for it to. */
async function settledYet(promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  void promise.then(
    () => (settled = true),
    () => (settled = true)
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  return settled;
}

beforeEach(() => {
  vi.clearAllMocks();
  invalidateHookCache();
  mockFetch.mockResolvedValue({ ok: true, status: 200 });
  vi.mocked(prisma.aiEventHookDelivery.create).mockResolvedValue(makeDelivery());
  vi.mocked(prisma.aiEventHookDelivery.update).mockResolvedValue(makeDelivery());
  vi.mocked(prisma.aiEventHookDelivery.updateMany).mockResolvedValue({ count: 1 });
  // A claim or a reset matches, and returns the row as written. It carries the
  // fixture payload; a test that needs a different one supplies its own result.
  vi.mocked(prisma.aiEventHookDelivery.updateManyAndReturn).mockImplementation((async (args: {
    where: { id: string };
    data: { status?: string; nextRetryAt?: Date | null };
  }) => [
    makeDelivery({
      id: args.where.id,
      status: args.data.status ?? 'failed',
      nextRetryAt: args.data.nextRetryAt ?? null,
    }),
  ]) as never);
  vi.mocked(prisma.aiEventHookDelivery.findUnique).mockResolvedValue(makeDelivery());
});

afterEach(() => {
  invalidateHookCache();
});

describe('emitHookEvent', () => {
  it('keeps the dispatch and its deliveries alive past the response (t-903)', async () => {
    vi.mocked(prisma.aiEventHook.findMany).mockResolvedValue([makeHook()] as never);
    let answer!: (value: unknown) => void;
    mockFetch.mockReturnValueOnce(
      new Promise((resolve) => {
        answer = resolve;
      })
    );

    emitHookEvent('conversation.started', { conversationId: 'conv-1' });

    expect(mockAfter).toHaveBeenCalledTimes(1);
    const handed = mockAfter.mock.calls[0]?.[0] as Promise<unknown>;
    // The delivery's request is out, and the hold is still open on it.
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled());
    expect(await settledYet(handed)).toBe(false);

    answer({ ok: true, status: 200 });
    await handed;
    expect(await settledYet(handed)).toBe(true);
  });

  it('creates a delivery record and dispatches webhook hooks matching the event type', async () => {
    vi.mocked(prisma.aiEventHook.findMany).mockResolvedValue([makeHook()] as never);

    emitHookEvent('conversation.started', { conversationId: 'conv-1' });

    await vi.waitFor(() => {
      expect(prisma.aiEventHookDelivery.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            hookId: 'hook-1',
            eventType: 'conversation.started',
            status: 'pending',
          }),
        })
      );
      expect(mockFetch).toHaveBeenCalledWith(
        'https://example.com/hook',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            'X-Hook-Event': 'conversation.started',
          }),
          body: expect.stringContaining('"conversation.started"'),
        })
      );
    });
  });

  it('does not dispatch hooks for non-matching event types', async () => {
    vi.mocked(prisma.aiEventHook.findMany).mockResolvedValue([
      makeHook({ eventType: 'workflow.completed' }),
    ] as never);

    emitHookEvent('conversation.started', { conversationId: 'conv-1' });

    // test-review:accept no_arg_called — polling guard inside vi.waitFor; primary assertions follow
    await vi.waitFor(() => {
      expect(prisma.aiEventHook.findMany).toHaveBeenCalled();
    });

    expect(mockFetch).not.toHaveBeenCalled();
    expect(prisma.aiEventHookDelivery.create).not.toHaveBeenCalled();
  });

  it('applies filter to match specific data fields', async () => {
    vi.mocked(prisma.aiEventHook.findMany).mockResolvedValue([
      makeHook({
        eventType: 'message.created',
        filter: { agentSlug: 'support-bot' },
      }),
    ] as never);

    emitHookEvent('message.created', { agentSlug: 'sales-bot' });
    // test-review:accept no_arg_called — polling guard inside vi.waitFor; primary assertions follow
    await vi.waitFor(() => {
      expect(prisma.aiEventHook.findMany).toHaveBeenCalled();
    });
    expect(mockFetch).not.toHaveBeenCalled();

    emitHookEvent('message.created', { agentSlug: 'support-bot' });
    await vi.waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  it('marks delivery failed and logs on non-ok webhook response', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500 });
    vi.mocked(prisma.aiEventHook.findMany).mockResolvedValue([
      makeHook({
        id: 'hook-4',
        eventType: 'agent.updated',
        action: { type: 'webhook', url: 'https://example.com/fail' },
      }),
    ] as never);

    emitHookEvent('agent.updated', { agentId: 'agent-1' });

    await vi.waitFor(() => {
      expect(prisma.aiEventHookDelivery.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'del-1', status: AWAITING_STATUS },
          data: expect.objectContaining({
            status: 'failed',
            lastResponseCode: 500,
            lastError: 'HTTP 500',
          }),
        })
      );
      expect(logger.warn).toHaveBeenCalledWith(
        'Hook webhook delivery failed',
        expect.objectContaining({ statusCode: 500 })
      );
    });
  });

  it('marks delivery exhausted after MAX_ATTEMPTS', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500 });
    vi.mocked(prisma.aiEventHook.findMany).mockResolvedValue([makeHook()] as never);
    // Simulate this being the final retry (attempts already 2 → becomes 3)
    vi.mocked(prisma.aiEventHookDelivery.findUnique).mockResolvedValue(
      makeDelivery({ attempts: 2 })
    );

    emitHookEvent('conversation.started', { conversationId: 'conv-1' });

    await vi.waitFor(() => {
      expect(prisma.aiEventHookDelivery.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'del-1', status: AWAITING_STATUS },
          data: expect.objectContaining({
            status: 'exhausted',
            attempts: 3,
            nextRetryAt: null,
          }),
        })
      );
    });
  });

  it('marks delivery delivered on 2xx response', async () => {
    vi.mocked(prisma.aiEventHook.findMany).mockResolvedValue([makeHook()] as never);
    mockFetch.mockResolvedValue({ ok: true, status: 202 });

    emitHookEvent('conversation.started', { conversationId: 'conv-1' });

    await vi.waitFor(() => {
      expect(prisma.aiEventHookDelivery.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'del-1', status: AWAITING_STATUS },
          data: expect.objectContaining({
            status: 'delivered',
            lastResponseCode: 202,
          }),
        })
      );
    });
  });

  it('caches hooks and does not re-query within TTL', async () => {
    vi.mocked(prisma.aiEventHook.findMany).mockResolvedValue([]);

    emitHookEvent('conversation.started', {});
    await vi.waitFor(() => {
      expect(prisma.aiEventHook.findMany).toHaveBeenCalledTimes(1);
    });

    emitHookEvent('conversation.started', {});
    await vi.waitFor(() => {
      expect(prisma.aiEventHook.findMany).toHaveBeenCalledTimes(1);
    });
  });

  it('reloads hooks after invalidateHookCache', async () => {
    vi.mocked(prisma.aiEventHook.findMany).mockResolvedValue([]);

    emitHookEvent('conversation.started', {});
    await vi.waitFor(() => {
      expect(prisma.aiEventHook.findMany).toHaveBeenCalledTimes(1);
    });

    invalidateHookCache();

    emitHookEvent('conversation.started', {});
    await vi.waitFor(() => {
      expect(prisma.aiEventHook.findMany).toHaveBeenCalledTimes(2);
    });
  });

  it('includes custom headers in webhook requests', async () => {
    vi.mocked(prisma.aiEventHook.findMany).mockResolvedValue([
      makeHook({
        id: 'hook-5',
        eventType: 'message.created',
        action: {
          type: 'webhook',
          url: 'https://example.com/hook',
          headers: { Authorization: 'Bearer token123' },
        },
      }),
    ] as never);

    emitHookEvent('message.created', { messageId: 'msg-1' });

    await vi.waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        'https://example.com/hook',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer token123',
          }),
        })
      );
    });
  });
});

describe('retryHookDelivery', () => {
  it('returns false when delivery not found', async () => {
    vi.mocked(prisma.aiEventHookDelivery.findUnique).mockResolvedValue(null);

    const result = await retryHookDelivery('nonexistent');

    expect(result).toBe(false);
  });

  it('returns false when hook is disabled', async () => {
    vi.mocked(prisma.aiEventHookDelivery.findUnique).mockResolvedValue({
      ...makeDelivery({ status: 'exhausted' }),
      hook: makeHook({ isEnabled: false }),
    } as never);

    const result = await retryHookDelivery('del-1');

    expect(result).toBe(false);
    expect(prisma.aiEventHookDelivery.update).not.toHaveBeenCalled();
    expect(prisma.aiEventHookDelivery.updateMany).not.toHaveBeenCalled();
  });

  it('returns false when hook action is not a webhook (defensive against legacy data)', async () => {
    vi.mocked(prisma.aiEventHookDelivery.findUnique).mockResolvedValue({
      ...makeDelivery({ status: 'exhausted' }),
      hook: makeHook({ action: { type: 'legacy-internal', handler: 'x' } }),
    } as never);

    const result = await retryHookDelivery('del-1');

    expect(result).toBe(false);
  });

  it('keeps the attempt alive past the retry route’s response (t-903)', async () => {
    vi.mocked(prisma.aiEventHookDelivery.findUnique).mockResolvedValueOnce({
      ...makeDelivery({ status: 'exhausted', attempts: 3 }),
      hook: makeHook(),
    } as never);
    vi.mocked(prisma.aiEventHookDelivery.updateManyAndReturn).mockResolvedValueOnce([
      makeDelivery({ status: 'pending', attempts: 0 }),
    ] as never);
    let answer!: (value: unknown) => void;
    mockFetch.mockReturnValueOnce(
      new Promise((resolve) => {
        answer = resolve;
      })
    );

    expect(await retryHookDelivery('del-1')).toBe(true);

    expect(mockAfter).toHaveBeenCalledTimes(1);
    const handed = mockAfter.mock.calls[0]?.[0] as Promise<unknown>;
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled());
    expect(await settledYet(handed)).toBe(false);

    answer({ ok: true, status: 200 });
    await handed;
  });

  it('resets delivery state and re-attempts', async () => {
    // The read: the exhausted row. The reset returns the row it wrote.
    vi.mocked(prisma.aiEventHookDelivery.findUnique).mockResolvedValueOnce({
      ...makeDelivery({ status: 'exhausted', attempts: 3 }),
      hook: makeHook(),
    } as never);
    vi.mocked(prisma.aiEventHookDelivery.updateManyAndReturn).mockResolvedValueOnce([
      makeDelivery({ status: 'pending', attempts: 0 }),
    ] as never);

    const result = await retryHookDelivery('del-1');

    // test-review:accept tobe_true — boolean return from retryHookDelivery; structural assertion on retry outcome
    expect(result).toBe(true);
    // The reset matches the row as it was read, so a concurrent change is not undone.
    expect(prisma.aiEventHookDelivery.updateManyAndReturn).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'del-1',
          status: 'exhausted',
          lastError: null,
          nextRetryAt: null,
          stoppedByErasure: false,
        },
        data: expect.objectContaining({
          status: 'pending',
          attempts: 0,
          lastError: null,
          nextRetryAt: null,
        }),
      })
    );
  });
});

describe('an erasure’s stop on a hook delivery (t-793)', () => {
  beforeEach(() => {
    vi.mocked(prisma.aiEventHook.findMany).mockResolvedValue([makeHook()] as never);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('leaves a row stopped while the POST was out stopped when the send succeeds, and says so', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 });
    vi.mocked(prisma.aiEventHookDelivery.updateMany).mockResolvedValue({ count: 0 });

    emitHookEvent('conversation.started', { conversationId: 'conv-1' });

    await vi.waitFor(() => {
      expect(logger.info).toHaveBeenCalledWith(
        'Hook delivery outcome not recorded: the row was settled while in flight',
        { deliveryId: 'del-1', outcome: 'delivered' }
      );
    });
    expect(prisma.aiEventHookDelivery.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'del-1', status: AWAITING_STATUS },
        data: expect.objectContaining({ status: 'delivered' }),
      })
    );
    expect(prisma.aiEventHookDelivery.update).not.toHaveBeenCalled();
  });

  it('leaves a stopped row stopped and arms no timer when the send fails', async () => {
    vi.useFakeTimers();
    mockFetch.mockResolvedValue({ ok: false, status: 503 });
    vi.mocked(prisma.aiEventHookDelivery.findUnique).mockResolvedValue(
      makeDelivery({ status: 'exhausted', lastError: 'Not retried: subject erased' })
    );
    // The stopped row matches no awaiting status
    vi.mocked(prisma.aiEventHookDelivery.updateMany)
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });

    emitHookEvent('conversation.started', { conversationId: 'conv-1' });
    await vi.waitFor(() => {
      expect(logger.info).toHaveBeenCalledWith(
        'Hook delivery outcome not recorded: the row was settled while in flight',
        { deliveryId: 'del-1', outcome: 'failed' }
      );
    });
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(prisma.aiEventHookDelivery.update).not.toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    // The attempt that went out is still recorded, without touching the
    // status or the erasure's mark.
    expect(prisma.aiEventHookDelivery.updateMany).toHaveBeenCalledTimes(2);
    expect(prisma.aiEventHookDelivery.updateMany).toHaveBeenLastCalledWith({
      where: { id: 'del-1', status: { not: 'delivered' } },
      data: { attempts: { increment: 1 }, lastAttemptAt: expect.any(Date), lastResponseCode: 503 },
    });
  });

  it('records an attempt that had no status code without a lastResponseCode, so the settled row’s code is not nulled', async () => {
    vi.useFakeTimers();
    // A fetch rejection: no response, so no status code.
    mockFetch.mockRejectedValue(new Error('ECONNRESET'));
    vi.mocked(prisma.aiEventHookDelivery.findUnique).mockResolvedValue(
      makeDelivery({ status: 'exhausted', lastError: 'Not retried: subject erased' })
    );
    vi.mocked(prisma.aiEventHookDelivery.updateMany)
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });

    emitHookEvent('conversation.started', { conversationId: 'conv-1' });
    await vi.waitFor(() => {
      expect(prisma.aiEventHookDelivery.updateMany).toHaveBeenCalledTimes(2);
    });
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(prisma.aiEventHookDelivery.updateMany).toHaveBeenLastCalledWith({
      where: { id: 'del-1', status: { not: 'delivered' } },
      data: { attempts: { increment: 1 }, lastAttemptAt: expect.any(Date) },
    });
  });

  it('arms no timer when the stop lands between the failure’s read and its write', async () => {
    vi.useFakeTimers();
    mockFetch.mockResolvedValue({ ok: false, status: 503 });
    vi.mocked(prisma.aiEventHookDelivery.findUnique).mockResolvedValue(
      makeDelivery({ status: 'pending' })
    );
    vi.mocked(prisma.aiEventHookDelivery.updateMany).mockResolvedValue({ count: 0 });

    emitHookEvent('conversation.started', { conversationId: 'conv-1' });
    // The conditional outcome write, then the attempt recorded alone
    await vi.waitFor(() => {
      expect(prisma.aiEventHookDelivery.updateMany).toHaveBeenCalledTimes(2);
    });
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    // A timer would have re-read the row with its hook and sent again.
    expect(prisma.aiEventHookDelivery.findUnique).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  // The stop is the column (t-809): a lastError written over the erasure's
  // wording does not clear it.
  it.each(['HTTP 503 (not retried: subject erased)', 'HTTP 500 written over the wording', null])(
    'refuses a manual retry of a row an erasure stopped, whatever its lastError (%s)',
    async (lastError) => {
      vi.mocked(prisma.aiEventHookDelivery.findUnique).mockResolvedValue({
        ...makeDelivery({ status: 'exhausted', lastError, stoppedByErasure: true }),
        hook: makeHook(),
      } as never);

      const result = await retryHookDelivery('del-1');

      expect(result).toBe(false);
      expect(prisma.aiEventHookDelivery.updateMany).not.toHaveBeenCalled();
      expect(prisma.aiEventHookDelivery.updateManyAndReturn).not.toHaveBeenCalled();
      expect(mockFetch).not.toHaveBeenCalled();
    }
  );

  it('retries a row that is not marked, even if its lastError reads like an erasure’s (t-809)', async () => {
    vi.mocked(prisma.aiEventHookDelivery.findUnique).mockResolvedValue({
      ...makeDelivery({ status: 'exhausted', lastError: 'HTTP 422 (not retried: subject erased)' }),
      hook: makeHook(),
    } as never);
    vi.mocked(prisma.aiEventHookDelivery.updateManyAndReturn).mockResolvedValue([
      makeDelivery({ status: 'pending', attempts: 0 }),
    ] as never);

    const result = await retryHookDelivery('del-1');

    expect(result).toBe(true);
  });

  // Merges the former "row changed between the read and the reset" and "an
  // erasure stopped the row just after the reset": with the reset returning the
  // row it wrote there is no later re-read, so the one real case left is a reset
  // that matches nothing because an erasure (or any writer) changed the row first.
  it('sends nothing when the row changed between the read and the reset, as an erasure does', async () => {
    vi.mocked(prisma.aiEventHookDelivery.findUnique).mockResolvedValue({
      ...makeDelivery({ status: 'exhausted', lastError: 'HTTP 503' }),
      hook: makeHook(),
    } as never);
    vi.mocked(prisma.aiEventHookDelivery.updateManyAndReturn).mockResolvedValue([]);

    const result = await retryHookDelivery('del-1');
    await Promise.resolve();

    expect(result).toBe(false);
    expect(prisma.aiEventHookDelivery.updateManyAndReturn).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'del-1',
          status: 'exhausted',
          lastError: 'HTTP 503',
          nextRetryAt: null,
          stoppedByErasure: false,
        },
      })
    );
    // One read only: the reset is the last thing the retry asks the database.
    expect(prisma.aiEventHookDelivery.findUnique).toHaveBeenCalledTimes(1);
    expect(prisma.aiEventHookDelivery.updateMany).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('settles a reset row whose payload no longer parses, rather than leave it pending', async () => {
    vi.mocked(prisma.aiEventHookDelivery.findUnique).mockResolvedValueOnce({
      ...makeDelivery({ status: 'exhausted' }),
      hook: makeHook(),
    } as never);
    vi.mocked(prisma.aiEventHookDelivery.updateManyAndReturn).mockResolvedValueOnce([
      makeDelivery({ status: 'pending', payload: { not: 'an event' } }),
    ] as never);

    const result = await retryHookDelivery('del-1');

    expect(result).toBe(false);
    expect(prisma.aiEventHookDelivery.updateMany).toHaveBeenLastCalledWith({
      where: { id: 'del-1', status: 'pending' },
      data: { status: 'exhausted', nextRetryAt: null, lastError: 'invalid_payload' },
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('claims the row before a timer sends it, and sends nothing when the tick claimed it first', async () => {
    vi.useFakeTimers();
    mockFetch.mockResolvedValue({ ok: false, status: 503 });
    vi.mocked(prisma.aiEventHookDelivery.findUnique)
      .mockResolvedValueOnce(makeDelivery({ status: 'pending' }))
      .mockImplementationOnce((async () => ({
        ...armedRow({ attempts: 1 }),
        hook: makeHook(),
      })) as never);

    emitHookEvent('conversation.started', { conversationId: 'conv-1' });
    await vi.waitFor(() => {
      expect(prisma.aiEventHookDelivery.updateMany).toHaveBeenCalledTimes(1);
    });
    const armedFor: unknown = armedRow().nextRetryAt;
    if (!(armedFor instanceof Date)) throw new Error('the failed attempt armed no retry');
    // The tick's claim landed first: the timer's claim matches nothing.
    vi.mocked(prisma.aiEventHookDelivery.updateManyAndReturn).mockResolvedValueOnce([]);

    await vi.advanceTimersByTimeAsync(10_000);

    expect(prisma.aiEventHookDelivery.updateManyAndReturn).toHaveBeenLastCalledWith({
      where: { id: 'del-1', status: 'failed', nextRetryAt: armedFor },
      data: { nextRetryAt: expect.any(Date) },
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('does not send again from a timer armed before the row was reset by hand', async () => {
    vi.useFakeTimers();
    mockFetch.mockResolvedValue({ ok: false, status: 503 });
    vi.mocked(prisma.aiEventHookDelivery.findUnique).mockResolvedValue(
      makeDelivery({ status: 'pending' })
    );

    emitHookEvent('conversation.started', { conversationId: 'conv-1' });
    await vi.waitFor(() => {
      expect(prisma.aiEventHookDelivery.updateMany).toHaveBeenCalledTimes(1);
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // An admin retried it while the timer waited: pending, the manual attempt
    // still in flight. The old check (pending or failed) sent it a second time.
    vi.mocked(prisma.aiEventHookDelivery.findUnique).mockResolvedValue({
      ...makeDelivery({ status: 'pending', nextRetryAt: null }),
      hook: makeHook(),
    } as never);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

describe('scheduleRetry (via emitHookEvent failure + timer advancement)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('on retry timer firing, re-attempts delivery against still-enabled hook and flips to delivered on success', async () => {
    // Arrange
    vi.useFakeTimers();

    const deliveryId = 'del-retry-1';
    const hookId = 'hook-retry-1';
    const webhookUrl = 'https://example.com/retry-hook';

    vi.mocked(prisma.aiEventHook.findMany).mockResolvedValue([
      makeHook({
        id: hookId,
        eventType: 'workflow.completed',
        action: { type: 'webhook', url: webhookUrl },
      }),
    ] as never);

    vi.mocked(prisma.aiEventHookDelivery.create).mockResolvedValue(
      makeDelivery({ id: deliveryId, hookId, attempts: 0 })
    );

    // First fetch fails — triggers scheduleRetry
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
    // Second fetch succeeds — triggered by the retry timer
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200 });

    // findUnique call 1 (in attemptDelivery failure path, no include) — returns attempts: 0
    vi.mocked(prisma.aiEventHookDelivery.findUnique).mockResolvedValueOnce(
      makeDelivery({ id: deliveryId, attempts: 0 })
    );

    // findUnique call 2 (in scheduleRetry timer, with include: { hook: true }) — returns delivery with enabled hook
    // The timer's read carries the payload an erasure is about to redact.
    vi.mocked(prisma.aiEventHookDelivery.findUnique).mockImplementationOnce((async () => ({
      ...armedRow({
        id: deliveryId,
        attempts: 1,
        payload: {
          eventType: 'workflow.completed',
          timestamp: '2026-04-23T00:00:00Z',
          data: { note: 'pre-claim-copy' },
        },
      }),
      hook: makeHook({
        id: hookId,
        eventType: 'workflow.completed',
        action: { type: 'webhook', url: webhookUrl },
      }),
    })) as never);
    // The claim returns the row as the erasure left it: this is what is sent.
    vi.mocked(prisma.aiEventHookDelivery.updateManyAndReturn).mockResolvedValueOnce([
      makeDelivery({
        id: deliveryId,
        status: 'failed',
        attempts: 1,
        payload: {
          eventType: 'workflow.completed',
          timestamp: '2026-04-23T00:00:00Z',
          data: { note: 'claimed-copy' },
        },
      }),
    ] as never);

    // Act — emit event; initial attempt fails, schedules 10s retry
    emitHookEvent('workflow.completed', { workflowId: 'wf-1' });

    // Wait for the initial dispatch to complete (fetch + findUnique + update all settle)
    await vi.waitFor(() => {
      expect(prisma.aiEventHookDelivery.updateMany).toHaveBeenCalledTimes(1);
    });

    // Verify initial failure update
    const updateCalls = vi.mocked(prisma.aiEventHookDelivery.updateMany).mock.calls;
    const firstUpdate = updateCalls[0]?.[0];
    expect(firstUpdate).toMatchObject({
      where: { id: deliveryId, status: AWAITING_STATUS },
      data: expect.objectContaining({ status: 'failed' }),
    });

    // Advance timers to fire the scheduleRetry callback (10_000ms delay)
    await vi.advanceTimersByTimeAsync(10_000);

    // Assert — the retry fired, second fetch was called, and delivery flipped to delivered
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // The timer claimed the row before sending it
    expect(prisma.aiEventHookDelivery.updateManyAndReturn).toHaveBeenCalledTimes(1);
    expect(prisma.aiEventHookDelivery.updateManyAndReturn).toHaveBeenCalledWith({
      where: { id: deliveryId, status: 'failed', nextRetryAt: expect.any(Date) },
      data: { nextRetryAt: expect.any(Date) },
    });
    // What the retry sent is the payload the claim returned, not the copy the
    // timer read before claiming.
    const retryBody = String((mockFetch.mock.calls[1][1] as { body: string }).body);
    expect(retryBody).toContain('claimed-copy');
    expect(retryBody).not.toContain('pre-claim-copy');

    // The failed outcome, then the delivered outcome
    const allUpdateCalls = vi.mocked(prisma.aiEventHookDelivery.updateMany).mock.calls;
    expect(allUpdateCalls.length).toBe(2);
    expect(allUpdateCalls.at(-1)![0]).toMatchObject({
      where: { id: deliveryId, status: AWAITING_STATUS },
      data: expect.objectContaining({
        status: 'delivered',
        attempts: { increment: 1 },
      }),
    });
  });

  it('on retry timer firing with a disabled hook, marks delivery exhausted without re-dispatching', async () => {
    // Arrange
    vi.useFakeTimers();

    const deliveryId = 'del-retry-2';
    const hookId = 'hook-retry-2';

    vi.mocked(prisma.aiEventHook.findMany).mockResolvedValue([
      makeHook({
        id: hookId,
        eventType: 'workflow.completed',
        action: { type: 'webhook', url: 'https://example.com/hook' },
      }),
    ] as never);

    vi.mocked(prisma.aiEventHookDelivery.create).mockResolvedValue(
      makeDelivery({ id: deliveryId, hookId, attempts: 0 })
    );

    // Initial fetch fails — triggers scheduleRetry
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503 });

    // findUnique call 1 (in attemptDelivery failure path) — returns attempts: 0
    vi.mocked(prisma.aiEventHookDelivery.findUnique).mockResolvedValueOnce(
      makeDelivery({ id: deliveryId, attempts: 0 })
    );

    // findUnique call 2 (in scheduleRetry timer) — hook is now disabled
    vi.mocked(prisma.aiEventHookDelivery.findUnique).mockImplementationOnce((async () => ({
      ...armedRow({ id: deliveryId, attempts: 1 }),
      hook: makeHook({ id: hookId, isEnabled: false }),
    })) as never);

    // Act
    emitHookEvent('workflow.completed', { workflowId: 'wf-2' });
    await vi.waitFor(() => {
      expect(prisma.aiEventHookDelivery.updateMany).toHaveBeenCalledTimes(1);
    });

    // Advance timers to fire retry callback
    await vi.advanceTimersByTimeAsync(10_000);

    // Assert — fetch was NOT called again (no re-dispatch)
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // An exhausted write for the disabled hook, after the failed attempt's
    // outcome write. Both conditional, so an erasure's mark survives (t-793).
    const allUpdateCalls = vi.mocked(prisma.aiEventHookDelivery.updateMany).mock.calls;
    expect(allUpdateCalls.length).toBe(2);
    expect(allUpdateCalls.at(-1)![0]).toMatchObject({
      where: { id: deliveryId, status: AWAITING_STATUS },
      data: expect.objectContaining({ status: 'exhausted', nextRetryAt: null }),
    });
    expect(prisma.aiEventHookDelivery.update).not.toHaveBeenCalled();
  });

  it.each(['exhausted', 'delivered'])(
    'on retry timer firing for a delivery settled as %s meanwhile, neither sends nor writes',
    async (settled) => {
      // Arrange — an erasure (or a manual retry) settles the row after the timer was armed
      vi.useFakeTimers();
      const deliveryId = `del-settled-${settled}`;
      const hookId = 'hook-settled';
      const enabledHook = makeHook({
        id: hookId,
        eventType: 'workflow.completed',
        action: { type: 'webhook', url: 'https://example.com/hook' },
      });
      vi.mocked(prisma.aiEventHook.findMany).mockResolvedValue([enabledHook] as never);
      vi.mocked(prisma.aiEventHookDelivery.create).mockResolvedValue(
        makeDelivery({ id: deliveryId, hookId, attempts: 0 })
      );
      mockFetch.mockResolvedValueOnce({ ok: false, status: 503 });
      vi.mocked(prisma.aiEventHookDelivery.findUnique).mockResolvedValueOnce(
        makeDelivery({ id: deliveryId, attempts: 0 })
      );
      // The timer's re-read: hook still enabled, so only the status can stop it
      vi.mocked(prisma.aiEventHookDelivery.findUnique).mockImplementationOnce((async () => ({
        ...armedRow({ id: deliveryId, attempts: 1, status: settled }),
        hook: enabledHook,
      })) as never);

      emitHookEvent('workflow.completed', { workflowId: 'wf-settled' });
      await vi.waitFor(() => {
        expect(prisma.aiEventHookDelivery.updateMany).toHaveBeenCalledTimes(1);
      });

      // Act
      await vi.advanceTimersByTimeAsync(10_000);

      // Assert — the timer re-read the row, then did nothing
      expect(prisma.aiEventHookDelivery.findUnique).toHaveBeenCalledTimes(2);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(prisma.aiEventHookDelivery.updateMany).toHaveBeenCalledTimes(1);
      expect(prisma.aiEventHookDelivery.update).not.toHaveBeenCalled();
    }
  );

  it('on retry timer firing for a delivery still marked failed, retries it', async () => {
    vi.useFakeTimers();
    const deliveryId = 'del-still-failed';
    const hookId = 'hook-still-failed';
    const url = 'https://example.com/hook';
    const enabledHook = makeHook({
      id: hookId,
      eventType: 'workflow.completed',
      action: { type: 'webhook', url },
    });
    vi.mocked(prisma.aiEventHook.findMany).mockResolvedValue([enabledHook] as never);
    vi.mocked(prisma.aiEventHookDelivery.create).mockResolvedValue(
      makeDelivery({ id: deliveryId, hookId, attempts: 0 })
    );
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: true, status: 200 });
    vi.mocked(prisma.aiEventHookDelivery.findUnique).mockResolvedValueOnce(
      makeDelivery({ id: deliveryId, attempts: 0 })
    );
    vi.mocked(prisma.aiEventHookDelivery.findUnique).mockImplementationOnce((async () => ({
      ...armedRow({ id: deliveryId, attempts: 1, status: 'failed' }),
      hook: enabledHook,
    })) as never);

    emitHookEvent('workflow.completed', { workflowId: 'wf-failed' });
    await vi.waitFor(() => {
      expect(prisma.aiEventHookDelivery.updateMany).toHaveBeenCalledTimes(1);
    });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(vi.mocked(prisma.aiEventHookDelivery.updateMany).mock.calls.at(-1)![0]).toMatchObject({
      where: { id: deliveryId, status: AWAITING_STATUS },
      data: expect.objectContaining({ status: 'delivered' }),
    });
  });

  it('on retry timer firing with a non-webhook hook action, returns early without dispatch', async () => {
    // Arrange
    vi.useFakeTimers();

    const deliveryId = 'del-retry-3';
    const hookId = 'hook-retry-3';

    vi.mocked(prisma.aiEventHook.findMany).mockResolvedValue([
      makeHook({
        id: hookId,
        eventType: 'workflow.completed',
        action: { type: 'webhook', url: 'https://example.com/hook' },
      }),
    ] as never);

    vi.mocked(prisma.aiEventHookDelivery.create).mockResolvedValue(
      makeDelivery({ id: deliveryId, hookId, attempts: 0 })
    );

    // Initial fetch fails — triggers scheduleRetry
    mockFetch.mockResolvedValueOnce({ ok: false, status: 502 });

    // findUnique call 1 (in attemptDelivery failure path) — returns attempts: 0
    vi.mocked(prisma.aiEventHookDelivery.findUnique).mockResolvedValueOnce(
      makeDelivery({ id: deliveryId, attempts: 0 })
    );

    // findUnique call 2 (in scheduleRetry timer) — hook action is no longer a webhook
    vi.mocked(prisma.aiEventHookDelivery.findUnique).mockImplementationOnce((async () => ({
      ...armedRow({ id: deliveryId, attempts: 1 }),
      hook: makeHook({ id: hookId, action: { type: 'internal', handler: 'some-handler' } }),
    })) as never);

    // Act
    emitHookEvent('workflow.completed', { workflowId: 'wf-3' });
    await vi.waitFor(() => {
      expect(prisma.aiEventHookDelivery.updateMany).toHaveBeenCalledTimes(1);
    });

    // Advance timers to fire retry callback
    await vi.advanceTimersByTimeAsync(10_000);

    // Assert — fetch was NOT called again (returned early for non-webhook action)
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // parseDeliveryForDispatch issues an exhausted write for the invalid action row, after
    // the initial failure write. Both conditional: 2 updateMany writes in total.
    const allUpdates = vi.mocked(prisma.aiEventHookDelivery.updateMany).mock.calls;
    expect(allUpdates.length).toBe(2);
    expect(prisma.aiEventHookDelivery.update).not.toHaveBeenCalled();
    const exhaustedUpdate = allUpdates[1];
    expect(exhaustedUpdate?.[0]).toMatchObject({
      // Only over the lastError it read, so an erasure's mark survives (t-793)
      where: { id: deliveryId, lastError: null },
      data: expect.objectContaining({
        status: 'exhausted',
        lastError: 'invalid_action',
      }),
    });
  });
});

describe('processPendingHookRetries', () => {
  it('returns 0 when no pending retries', async () => {
    vi.mocked(prisma.aiEventHookDelivery.findMany).mockResolvedValue([]);

    const count = await processPendingHookRetries();

    expect(count).toBe(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('processes pending retries and returns count', async () => {
    const due = new Date(Date.now() - 1_000);
    vi.mocked(prisma.aiEventHookDelivery.findMany).mockResolvedValue([
      {
        ...makeDelivery({ id: 'del-1', status: 'failed', attempts: 1, nextRetryAt: due }),
        hook: makeHook(),
      },
      {
        ...makeDelivery({ id: 'del-2', status: 'failed', attempts: 2, nextRetryAt: due }),
        hook: makeHook({ id: 'hook-2' }),
      },
    ] as never);

    const count = await processPendingHookRetries();

    expect(count).toBe(2);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    // Each row is claimed before it is sent (t-793).
    for (const id of ['del-1', 'del-2']) {
      expect(prisma.aiEventHookDelivery.updateManyAndReturn).toHaveBeenCalledWith({
        where: { id, status: 'failed', nextRetryAt: due },
        data: { nextRetryAt: expect.any(Date) },
      });
    }
  });

  it('sends nothing for a row a timer claimed first (t-793)', async () => {
    const due = new Date(Date.now() - 1_000);
    vi.mocked(prisma.aiEventHookDelivery.findMany).mockResolvedValue([
      {
        ...makeDelivery({ id: 'del-1', status: 'failed', attempts: 1, nextRetryAt: due }),
        hook: makeHook(),
      },
    ] as never);
    vi.mocked(prisma.aiEventHookDelivery.updateManyAndReturn).mockResolvedValueOnce([]);

    await processPendingHookRetries();

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('sends the payload the claim returned, not the copy the tick read before claiming', async () => {
    // An erasure redacts a payload between the tick's read and its claim: the
    // read still carries the PII, the row the claim returns does not.
    const due = new Date(Date.now() - 1_000);
    vi.mocked(prisma.aiEventHookDelivery.findMany).mockResolvedValue([
      {
        ...makeDelivery({
          id: 'del-1',
          status: 'failed',
          attempts: 1,
          nextRetryAt: due,
          payload: {
            eventType: 'conversation.started',
            timestamp: '2026-04-23T00:00:00Z',
            data: { note: 'pre-claim-copy' },
          },
        }),
        hook: makeHook(),
      },
    ] as never);
    vi.mocked(prisma.aiEventHookDelivery.updateManyAndReturn).mockResolvedValueOnce([
      makeDelivery({
        status: 'failed',
        attempts: 1,
        payload: {
          eventType: 'conversation.started',
          timestamp: '2026-04-23T00:00:00Z',
          data: { note: 'claimed-copy' },
        },
      }),
    ] as never);

    await processPendingHookRetries();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const body = String((mockFetch.mock.calls[0][1] as { body: string }).body);
    expect(body).toContain('claimed-copy');
    expect(body).not.toContain('pre-claim-copy');
  });

  it('marks deliveries exhausted when their hook has been disabled', async () => {
    vi.mocked(prisma.aiEventHookDelivery.findMany).mockResolvedValue([
      { ...makeDelivery({ id: 'del-1' }), hook: makeHook({ isEnabled: false }) },
    ] as never);

    await processPendingHookRetries();

    expect(mockFetch).not.toHaveBeenCalled();
    expect(prisma.aiEventHookDelivery.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'del-1', status: AWAITING_STATUS },
        data: expect.objectContaining({ status: 'exhausted', nextRetryAt: null }),
      })
    );
  });

  it('queries for failed deliveries past their nextRetryAt with attempts < MAX', async () => {
    vi.mocked(prisma.aiEventHookDelivery.findMany).mockResolvedValue([]);

    await processPendingHookRetries();

    expect(prisma.aiEventHookDelivery.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: 'failed',
          nextRetryAt: { lte: expect.any(Date) },
          attempts: { lt: 3 },
        }),
      })
    );
  });

  it('skips deliveries whose hook action is not a webhook (defensive)', async () => {
    // Arrange — seed findMany with a delivery whose hook action is internal (not webhook)
    vi.mocked(prisma.aiEventHookDelivery.findMany).mockResolvedValue([
      {
        ...makeDelivery({ id: 'd1', attempts: 1 }),
        hook: makeHook({ isEnabled: true, action: { type: 'internal', handler: 'noop' } }),
      },
    ] as never);

    // Act
    const count = await processPendingHookRetries();

    // Assert — fetch was never called (early return on non-webhook action)
    expect(mockFetch).not.toHaveBeenCalled();
    // The function still returns the number of pending rows found
    expect(count).toBe(1);
  });
});

describe('loadHooks (via emitHookEvent — invalid action skip)', () => {
  it('skips a DB row whose action is missing url (fails WebhookActionSchema) and does not dispatch it', async () => {
    // Arrange — one invalid hook (missing url) and one valid hook for the same event type
    const validHookId = 'hook-valid';
    const invalidHookId = 'hook-no-url';

    vi.mocked(prisma.aiEventHook.findMany).mockResolvedValue([
      makeHook({
        id: invalidHookId,
        eventType: 'conversation.started',
        // Missing required `url` field — WebhookActionSchema.safeParse will fail
        action: { type: 'webhook' },
      }),
      makeHook({
        id: validHookId,
        eventType: 'conversation.started',
        action: { type: 'webhook', url: 'https://example.com/hook' },
      }),
    ] as never);

    // Delivery created only for the valid hook
    vi.mocked(prisma.aiEventHookDelivery.create).mockResolvedValue(
      makeDelivery({ hookId: validHookId })
    );

    // Act
    emitHookEvent('conversation.started', { conversationId: 'conv-1' });

    // Assert — logger.warn called with the skip message for the invalid hook
    await vi.waitFor(() => {
      expect(logger.warn).toHaveBeenCalledWith(
        'Hook skipped: invalid action shape',
        expect.objectContaining({ hookId: invalidHookId })
      );
    });

    // Valid hook was still dispatched (fetch called once)
    await vi.waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    // Delivery was created with the valid hook id, not the invalid one
    const createCalls = vi.mocked(prisma.aiEventHookDelivery.create).mock.calls;
    expect(createCalls.length).toBe(1);
    expect(createCalls[0]?.[0]).toMatchObject({
      data: expect.objectContaining({ hookId: validHookId }),
    });
    const invalidHookCallExists = createCalls.some(
      (c) => (c[0] as { data?: { hookId?: string } }).data?.hookId === invalidHookId
    );
    expect(invalidHookCallExists).toBe(false);
  });
});

describe('retryHookDelivery (parseDeliveryForDispatch validation)', () => {
  it('marks delivery exhausted with lastError=invalid_action when hook action is not a valid webhook', async () => {
    // Arrange — action type is 'email', not 'webhook'; fails WebhookActionSchema
    vi.mocked(prisma.aiEventHookDelivery.findUnique).mockResolvedValue({
      ...makeDelivery({ id: 'del-bad-action', status: 'failed' }),
      hook: makeHook({
        isEnabled: true,
        action: { type: 'email', url: 'foo' },
      }),
    } as never);

    // Act
    const result = await retryHookDelivery('del-bad-action');

    // Assert — returns false
    expect(result).toBe(false);

    // Delivery marked exhausted with the canonical lastError string
    expect(prisma.aiEventHookDelivery.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'del-bad-action', lastError: null },
        data: expect.objectContaining({
          status: 'exhausted',
          nextRetryAt: null,
          lastError: 'invalid_action',
        }),
      })
    );

    // fetch was never called
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('marks delivery exhausted with lastError=invalid_payload when payload eventType is not in HOOK_EVENT_TYPES', async () => {
    // Arrange — valid action but payload has an unknown eventType
    vi.mocked(prisma.aiEventHookDelivery.findUnique).mockResolvedValue({
      ...makeDelivery({
        id: 'del-bad-payload',
        status: 'failed',
        // eventType in payload is not in HOOK_EVENT_TYPES — HookEventPayloadSchema will reject it
        payload: { eventType: 'bogus.event', timestamp: '2026-04-23T00:00:00Z', data: {} },
      }),
      hook: makeHook({
        isEnabled: true,
        action: { type: 'webhook', url: 'https://example.com/hook' },
      }),
    } as never);

    // Act
    const result = await retryHookDelivery('del-bad-payload');

    // Assert — returns false
    expect(result).toBe(false);

    // Delivery marked exhausted with the canonical lastError string
    expect(prisma.aiEventHookDelivery.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'del-bad-payload', lastError: null },
        data: expect.objectContaining({
          status: 'exhausted',
          lastError: 'invalid_payload',
        }),
      })
    );

    // fetch was never called
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('happy path: valid action and payload reset delivery to pending then dispatch fetch', async () => {
    // Arrange — valid webhook action, valid payload
    const deliveryId = 'del-happy';
    const webhookUrl = 'https://example.com/hook';
    const validPayload = {
      eventType: 'conversation.started',
      timestamp: '2026-04-23T00:00:00.000Z',
      data: { conversationId: 'conv-abc' },
    };

    // The row the reset returns holds a different payload from the first read, so
    // what is sent shows which of the two the dispatch used.
    const rereadPayload = { ...validPayload, data: { conversationId: 'conv-reread' } };
    vi.mocked(prisma.aiEventHookDelivery.findUnique).mockResolvedValueOnce({
      ...makeDelivery({ id: deliveryId, status: 'failed', attempts: 1, payload: validPayload }),
      hook: makeHook({
        isEnabled: true,
        action: { type: 'webhook', url: webhookUrl },
      }),
    } as never);
    vi.mocked(prisma.aiEventHookDelivery.updateManyAndReturn).mockResolvedValueOnce([
      makeDelivery({ id: deliveryId, status: 'pending', attempts: 0, payload: rereadPayload }),
    ] as never);

    // Act
    const result = await retryHookDelivery(deliveryId);

    // test-review:accept tobe_true — boolean return from retryHookDelivery; structural assertion on retry outcome
    expect(result).toBe(true);

    // The reset sets status: 'pending' (before re-dispatch), matching the row as
    // it was read
    const resetCalls = vi.mocked(prisma.aiEventHookDelivery.updateManyAndReturn).mock.calls;
    expect(resetCalls).toHaveLength(1);
    expect(resetCalls[0]?.[0]).toMatchObject({
      where: { id: deliveryId, status: 'failed', lastError: null },
      data: expect.objectContaining({
        status: 'pending',
        attempts: 0,
        lastError: null,
        nextRetryAt: null,
      }),
    });

    // fetch called with the webhook URL as a POST with the JSON payload
    await vi.waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        webhookUrl,
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"conversation.started"'),
        })
      );
    });
    // The payload sent is the reset's returned row, not the first read's
    const sentBody = (mockFetch.mock.calls[0]?.[1] as RequestInit).body as string;
    expect(sentBody).toContain('conv-reread');
    expect(sentBody).not.toContain('conv-abc');
  });
});

describe('processPendingHookRetries (parseDeliveryForDispatch validation in batch)', () => {
  it('marks a malformed-action delivery exhausted without poisoning a valid peer in the same batch', async () => {
    // Arrange — two pending deliveries: one with invalid action, one valid
    const invalidId = 'del-invalid-action';
    const validId = 'del-valid';
    const validPayload = {
      eventType: 'workflow.completed' as const,
      timestamp: '2026-04-23T00:00:00.000Z',
      data: { workflowId: 'wf-1' },
    };

    vi.mocked(prisma.aiEventHookDelivery.findMany).mockResolvedValue([
      {
        ...makeDelivery({ id: invalidId, attempts: 1, payload: validPayload }),
        hook: makeHook({
          id: 'hook-invalid',
          isEnabled: true,
          // action type 'slack' is not 'webhook' — WebhookActionSchema rejects it
          action: { type: 'slack', url: 'https://hooks.slack.com/x' },
        }),
      },
      {
        ...makeDelivery({
          id: validId,
          status: 'failed',
          attempts: 1,
          payload: validPayload,
          nextRetryAt: new Date(Date.now() - 1_000),
        }),
        hook: makeHook({
          id: 'hook-valid',
          isEnabled: true,
          action: { type: 'webhook', url: 'https://example.com/hook' },
        }),
      },
    ] as never);

    // Act
    await processPendingHookRetries();

    // Assert — the invalid delivery was marked exhausted with invalid_action
    expect(prisma.aiEventHookDelivery.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: invalidId, lastError: null },
        data: expect.objectContaining({
          status: 'exhausted',
          lastError: 'invalid_action',
        }),
      })
    );

    // The valid delivery was still dispatched (fetch called exactly once)
    await vi.waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });
});

describe('dispatchToHooks (filter negative match)', () => {
  it('skips hooks whose filter does not match payload.data', async () => {
    // Arrange — hook filters on agentSlug: 'support-bot' but payload has 'different-bot'
    vi.mocked(prisma.aiEventHook.findMany).mockResolvedValue([
      makeHook({
        id: 'hook-filter-neg',
        eventType: 'message.created',
        filter: { agentSlug: 'support-bot' },
      }),
    ] as never);

    // Act
    emitHookEvent('message.created', { agentSlug: 'different-bot' });

    // test-review:accept no_arg_called — polling guard inside vi.waitFor; primary assertions follow
    await vi.waitFor(() => {
      expect(prisma.aiEventHook.findMany).toHaveBeenCalled();
    });

    // Assert — filter did not match, so no delivery record was created and no fetch fired
    expect(prisma.aiEventHookDelivery.create).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('attemptDelivery (null-delivery guard after HTTP failure)', () => {
  it('skips update and scheduleRetry when findUnique returns null after HTTP failure', async () => {
    // Arrange — fetch rejects so attemptDelivery enters the failure path;
    // the subsequent findUnique call returns null (row was deleted between steps).
    vi.mocked(prisma.aiEventHook.findMany).mockResolvedValue([
      makeHook({ id: 'hook-null-guard', eventType: 'conversation.started' }),
    ] as never);

    vi.mocked(prisma.aiEventHookDelivery.create).mockResolvedValue(
      makeDelivery({ id: 'del-null-guard' })
    );

    mockFetch.mockRejectedValueOnce(new Error('network failure'));

    // First findUnique (attemptDelivery failure path) returns null — row gone
    vi.mocked(prisma.aiEventHookDelivery.findUnique).mockResolvedValueOnce(null);

    // Act
    emitHookEvent('conversation.started', { conversationId: 'conv-null' });

    // Wait for the async dispatch to settle (create is the last observable side-effect before
    // the null guard short-circuits)
    await vi.waitFor(() => {
      expect(prisma.aiEventHookDelivery.create).toHaveBeenCalledTimes(1);
    });

    // Give the promise chain time to fully resolve after the null guard
    await new Promise((r) => setTimeout(r, 0));

    // Assert — update was never called and no retry was scheduled (no further fetch calls)
    expect(prisma.aiEventHookDelivery.update).not.toHaveBeenCalled();
    expect(prisma.aiEventHookDelivery.updateMany).not.toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

describe('matchesFilter (null/undefined filter values)', () => {
  it('fires hook when filter contains a null value for a key absent from the payload', async () => {
    // Arrange — hook filter has status: null which should be skipped, so any event fires the hook
    vi.mocked(prisma.aiEventHook.findMany).mockResolvedValue([
      makeHook({
        id: 'hook-null-filter',
        eventType: 'message.created',
        filter: { status: null },
      }),
    ] as never);

    // Act — payload does not contain a `status` key
    emitHookEvent('message.created', { messageId: 'msg-null-filter' });

    // Assert — hook fired despite the null filter value (null means "skip this key")
    await vi.waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });
});

describe('HMAC signing (via dispatchWebhook)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('adds X-Sunrise-Timestamp and X-Sunrise-Signature headers when hook.secret is set', async () => {
    const secret = 'a'.repeat(64);
    vi.mocked(prisma.aiEventHook.findMany).mockResolvedValue([
      makeHook({
        id: 'hook-signed',
        eventType: 'conversation.started',
        action: { type: 'webhook', url: 'https://example.com/signed' },
        secret,
      }),
    ] as never);

    emitHookEvent('conversation.started', { conversationId: 'conv-1' });

    await vi.waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Sunrise-Timestamp']).toMatch(/^\d+$/);
    expect(headers['X-Sunrise-Signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  // #534: the hook URL is validated at create/update time and never again at
  // dispatch. `fetch` defaults to redirect: 'follow', so a redirect would POST
  // the event payload AND its HMAC signature headers to an unvalidated second
  // target. Refuse rather than chase — what GitHub and Stripe do.
  it('refuses to follow redirects, so a signed payload cannot be forwarded off-target', async () => {
    vi.mocked(prisma.aiEventHook.findMany).mockResolvedValue([
      makeHook({
        id: 'hook-redirect',
        eventType: 'conversation.started',
        action: { type: 'webhook', url: 'https://example.com/hook' },
        secret: 'c'.repeat(64),
      }),
    ] as never);

    emitHookEvent('conversation.started', { conversationId: 'conv-1' });

    await vi.waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(init.redirect).toBe('error');
  });

  // undici reports the reason on `cause`, not `message` — a refused redirect, a
  // DNS failure and a connection reset are all a bare "fetch failed" without it.
  // Without this an endpoint that started 301-ing would burn every retry and
  // land in `exhausted` with nothing pointing at "re-point the URL".
  it('records the underlying cause, not a bare "fetch failed"', async () => {
    vi.mocked(prisma.aiEventHook.findMany).mockResolvedValue([
      makeHook({
        id: 'hook-cause',
        eventType: 'conversation.started',
        action: { type: 'webhook', url: 'https://example.com/redirecting' },
      }),
    ] as never);
    mockFetch.mockRejectedValueOnce(
      Object.assign(new TypeError('fetch failed'), { cause: new Error('unexpected redirect') })
    );

    emitHookEvent('conversation.started', { conversationId: 'conv-1' });

    await vi.waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
    await vi.waitFor(() => {
      const writes = vi
        .mocked(prisma.aiEventHookDelivery.updateMany)
        .mock.calls.map((c) => (c[0] as { data?: { lastError?: string } })?.data?.lastError)
        .filter(Boolean);
      expect(writes.some((e) => e?.includes('unexpected redirect'))).toBe(true);
    });
  });

  it('omits signing headers when hook.secret is null', async () => {
    vi.mocked(prisma.aiEventHook.findMany).mockResolvedValue([
      makeHook({
        id: 'hook-unsigned',
        eventType: 'conversation.started',
        action: { type: 'webhook', url: 'https://example.com/unsigned' },
        secret: null,
      }),
    ] as never);

    emitHookEvent('conversation.started', { conversationId: 'conv-1' });

    await vi.waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Sunrise-Timestamp']).toBeUndefined();
    expect(headers['X-Sunrise-Signature']).toBeUndefined();
  });

  it('refreshes the timestamp on retries so receivers with strict staleness tolerance still accept them', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-23T00:00:00Z'));

    const secret = 'b'.repeat(64);
    const hookId = 'hook-retry-signed';
    const deliveryId = 'del-retry-signed';
    vi.mocked(prisma.aiEventHook.findMany).mockResolvedValue([
      makeHook({
        id: hookId,
        eventType: 'workflow.completed',
        action: { type: 'webhook', url: 'https://example.com/signed-retry' },
        secret,
      }),
    ] as never);

    vi.mocked(prisma.aiEventHookDelivery.create).mockResolvedValue(
      makeDelivery({ id: deliveryId, hookId, attempts: 0 })
    );

    // First attempt fails → schedules retry 10s out
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
    // Retry attempt succeeds
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200 });

    vi.mocked(prisma.aiEventHookDelivery.findUnique).mockResolvedValueOnce(
      makeDelivery({ id: deliveryId, attempts: 0 })
    );
    vi.mocked(prisma.aiEventHookDelivery.findUnique).mockImplementationOnce((async () => ({
      ...armedRow({ id: deliveryId, attempts: 1 }),
      hook: makeHook({
        id: hookId,
        eventType: 'workflow.completed',
        action: { type: 'webhook', url: 'https://example.com/signed-retry' },
        secret,
      }),
    })) as never);

    emitHookEvent('workflow.completed', { workflowId: 'wf-1' });

    await vi.waitFor(() => {
      expect(prisma.aiEventHookDelivery.updateMany).toHaveBeenCalledTimes(1);
    });

    // Advance 10s — retry fires
    await vi.advanceTimersByTimeAsync(10_000);

    expect(mockFetch).toHaveBeenCalledTimes(2);
    const firstHeaders = (mockFetch.mock.calls[0]?.[1] as RequestInit).headers as Record<
      string,
      string
    >;
    const retryHeaders = (mockFetch.mock.calls[1]?.[1] as RequestInit).headers as Record<
      string,
      string
    >;
    expect(firstHeaders['X-Sunrise-Timestamp']).toBeDefined();
    expect(retryHeaders['X-Sunrise-Timestamp']).toBeDefined();
    expect(Number(retryHeaders['X-Sunrise-Timestamp'])).toBeGreaterThan(
      Number(firstHeaders['X-Sunrise-Timestamp'])
    );
    // Refreshed timestamp → refreshed signature
    expect(retryHeaders['X-Sunrise-Signature']).not.toBe(firstHeaders['X-Sunrise-Signature']);
  });

  it('signing headers win when admin-supplied custom headers collide with reserved names', async () => {
    const secret = 'c'.repeat(64);
    vi.mocked(prisma.aiEventHook.findMany).mockResolvedValue([
      makeHook({
        id: 'hook-collide',
        eventType: 'conversation.started',
        action: {
          type: 'webhook',
          url: 'https://example.com/collide',
          headers: {
            'X-Sunrise-Signature': 'sha256=deadbeef',
            'X-Sunrise-Timestamp': '0',
          },
        },
        secret,
      }),
    ] as never);

    emitHookEvent('conversation.started', { conversationId: 'conv-collide' });

    await vi.waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Sunrise-Signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(headers['X-Sunrise-Signature']).not.toBe('sha256=deadbeef');
    expect(headers['X-Sunrise-Timestamp']).not.toBe('0');
  });
});

// ─── Outbound URL redaction (#953) ──────────────────────────────────────
//
// A webhook URL can carry its credential in the path or the query. The logger
// redacts by key name only, so the URL must be reduced before it is logged.

describe('webhook URL in log lines', () => {
  const SECRET = 'AbCdEfGhIjKlMnOpQrStUvWx';
  const SECRET_URL = `https://hooks.slack.com/services/T0000/B0000/${SECRET}?token=qs-secret`;

  function loggedText(): string {
    return JSON.stringify(vi.mocked(logger.warn).mock.calls);
  }

  it('does not log the credential when a delivery attempt fails', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500 });
    vi.mocked(prisma.aiEventHook.findMany).mockResolvedValue([
      makeHook({ action: { type: 'webhook', url: SECRET_URL } }),
    ] as never);

    emitHookEvent('conversation.started', { conversationId: 'conv-1' });

    await vi.waitFor(() => {
      expect(logger.warn).toHaveBeenCalledWith(
        'Hook webhook delivery failed',
        expect.objectContaining({ url: 'https://hooks.slack.com/services/T0000/B0000/[param]' })
      );
    });
    expect(loggedText()).not.toContain(SECRET);
    expect(loggedText()).not.toContain('qs-secret');
  });

  it('does not log the credential when dispatch setup fails', async () => {
    vi.mocked(prisma.aiEventHookDelivery.create).mockRejectedValue(new Error('db down'));
    vi.mocked(prisma.aiEventHook.findMany).mockResolvedValue([
      makeHook({ action: { type: 'webhook', url: SECRET_URL } }),
    ] as never);

    emitHookEvent('conversation.started', { conversationId: 'conv-1' });

    await vi.waitFor(() => {
      expect(logger.warn).toHaveBeenCalledWith(
        'Hook webhook dispatch setup failed',
        expect.objectContaining({ url: 'https://hooks.slack.com/services/T0000/B0000/[param]' })
      );
    });
    expect(loggedText()).not.toContain(SECRET);
    expect(loggedText()).not.toContain('qs-secret');
  });
});

// ─── Delivery destination recording (§109 t-739) ────────────────────────

describe('delivery destination recording', () => {
  const OLD_URL = 'https://old.example.com/hook';
  const NEW_URL = 'https://new.example.com/hook';
  const oldPair = describeDestination('webhook', OLD_URL);
  const newPair = describeDestination('webhook', NEW_URL);

  afterEach(() => {
    vi.useRealTimers();
  });

  it('carries the destination derived from action.url on the created row', async () => {
    const url = 'https://hooks.example.com/h/Ab3dEf6hIj9kLm2nOp5qRs8t?token=SECRETQ';
    vi.mocked(prisma.aiEventHook.findMany).mockResolvedValue([
      makeHook({ action: { type: 'webhook', url } }),
    ] as never);

    emitHookEvent('conversation.started', { conversationId: 'conv-1' });

    await vi.waitFor(() => {
      expect(prisma.aiEventHookDelivery.create).toHaveBeenCalled();
    });
    const data = vi.mocked(prisma.aiEventHookDelivery.create).mock.calls[0][0].data as Record<
      string,
      unknown
    >;
    expect(data.destination).toBe('https://hooks.example.com');
    expect(data.destinationFingerprint).toBe(
      describeDestination('webhook', url).destinationFingerprint
    );
    expect(JSON.stringify(data)).not.toContain('SECRETQ');
  });

  it('records the edited URL and the old one as history in the retry outcome update', async () => {
    vi.mocked(prisma.aiEventHookDelivery.findUnique).mockResolvedValue({
      ...makeDelivery({ status: 'failed', attempts: 1, ...oldPair }),
      hook: makeHook({ action: { type: 'webhook', url: NEW_URL } }),
    } as never);
    // The reset returns the row as it wrote it: still carrying the old destination.
    vi.mocked(prisma.aiEventHookDelivery.updateManyAndReturn).mockResolvedValue([
      makeDelivery({ status: 'pending', attempts: 0, ...oldPair }),
    ] as never);

    const ok = await retryHookDelivery('del-1');
    expect(ok).toBe(true);

    // The reset is updateManyAndReturn; the one updateMany is the attempt's outcome
    await vi.waitFor(() => {
      expect(prisma.aiEventHookDelivery.updateMany).toHaveBeenCalledTimes(1);
    });
    expect(mockFetch).toHaveBeenCalledWith(NEW_URL, expect.anything());
    const outcome = vi.mocked(prisma.aiEventHookDelivery.updateMany).mock.calls[0][0].data;
    expect(outcome).toMatchObject({
      status: 'delivered',
      ...newPair,
      previousDestinations: [{ ...oldPair, until: expect.any(String) }],
    });
  });

  it('adds no destination keys to the outcome update when the URL is unchanged', async () => {
    vi.mocked(prisma.aiEventHookDelivery.findUnique).mockResolvedValue({
      ...makeDelivery({ status: 'failed', attempts: 1, ...oldPair }),
      hook: makeHook({ action: { type: 'webhook', url: OLD_URL } }),
    } as never);
    // The reset returns the row as it wrote it: still carrying the old destination.
    vi.mocked(prisma.aiEventHookDelivery.updateManyAndReturn).mockResolvedValue([
      makeDelivery({ status: 'pending', attempts: 0, ...oldPair }),
    ] as never);

    await retryHookDelivery('del-1');
    await vi.waitFor(() => {
      expect(prisma.aiEventHookDelivery.updateMany).toHaveBeenCalledTimes(1);
    });

    // The reset is updateManyAndReturn; the one updateMany is the attempt's outcome
    const outcome = vi.mocked(prisma.aiEventHookDelivery.updateMany).mock.calls[0][0].data;
    expect(outcome).toMatchObject({ status: 'delivered' });
    expect(outcome).not.toHaveProperty('destination');
    expect(outcome).not.toHaveProperty('destinationFingerprint');
    expect(outcome).not.toHaveProperty('previousDestinations');
  });

  describe('when the hook has been deleted', () => {
    it('retryHookDelivery returns false without writing or sending', async () => {
      vi.mocked(prisma.aiEventHookDelivery.findUnique).mockResolvedValue({
        ...makeDelivery({ status: 'exhausted', ...oldPair }),
        hook: null,
      } as never);

      const result = await retryHookDelivery('del-1');

      expect(result).toBe(false);
      expect(prisma.aiEventHookDelivery.update).not.toHaveBeenCalled();
      expect(prisma.aiEventHookDelivery.updateMany).not.toHaveBeenCalled();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('processPendingHookRetries marks the row exhausted with a deleted reason and does not send', async () => {
      vi.mocked(prisma.aiEventHookDelivery.findMany).mockResolvedValue([
        {
          ...makeDelivery({ id: 'del-gone', status: 'failed', attempts: 1, lastError: 'HTTP 500' }),
          hook: null,
        },
      ] as never);

      await processPendingHookRetries();

      expect(mockFetch).not.toHaveBeenCalled();
      // The real failure survives; the reason retries stopped is appended to it.
      expect(prisma.aiEventHookDelivery.updateMany).toHaveBeenCalledWith({
        where: { id: 'del-gone', status: AWAITING_STATUS },
        data: {
          status: 'exhausted',
          nextRetryAt: null,
          lastError: 'HTTP 500 (not retried: hook deleted)',
        },
      });
    });

    it('processPendingHookRetries writes only the reason when the row had no earlier error', async () => {
      vi.mocked(prisma.aiEventHookDelivery.findMany).mockResolvedValue([
        { ...makeDelivery({ id: 'del-gone', status: 'failed', attempts: 1 }), hook: null },
      ] as never);

      await processPendingHookRetries();

      expect(prisma.aiEventHookDelivery.updateMany).toHaveBeenCalledWith({
        where: { id: 'del-gone', status: AWAITING_STATUS },
        data: expect.objectContaining({ lastError: 'Not retried: hook deleted' }),
      });
    });

    it('processPendingHookRetries leaves lastError alone for a disabled (non-null) hook', async () => {
      vi.mocked(prisma.aiEventHookDelivery.findMany).mockResolvedValue([
        {
          ...makeDelivery({ id: 'del-off', status: 'failed', attempts: 1 }),
          hook: makeHook({ isEnabled: false }),
        },
      ] as never);

      await processPendingHookRetries();

      expect(prisma.aiEventHookDelivery.updateMany).toHaveBeenCalledWith({
        where: { id: 'del-off', status: AWAITING_STATUS },
        data: { status: 'exhausted', nextRetryAt: null },
      });
    });

    it('the in-process retry marks the row exhausted with a deleted reason', async () => {
      vi.useFakeTimers();
      vi.mocked(prisma.aiEventHook.findMany).mockResolvedValue([makeHook()] as never);
      mockFetch.mockResolvedValue({ ok: false, status: 500 });
      // 1st lookup: the failure path reading attempts; 2nd: the timer, hook gone.
      vi.mocked(prisma.aiEventHookDelivery.findUnique)
        .mockResolvedValueOnce(makeDelivery({ attempts: 0 }))
        .mockImplementationOnce((async () => ({
          ...armedRow({ attempts: 1, lastError: 'HTTP 500' }),
          hook: null,
        })) as never);

      emitHookEvent('conversation.started', { conversationId: 'conv-1' });
      await vi.waitFor(() => {
        expect(prisma.aiEventHookDelivery.updateMany).toHaveBeenCalledTimes(1);
      });
      await vi.advanceTimersByTimeAsync(10_000);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(prisma.aiEventHookDelivery.updateMany).toHaveBeenLastCalledWith({
        where: { id: 'del-1', status: AWAITING_STATUS },
        data: {
          status: 'exhausted',
          nextRetryAt: null,
          lastError: 'HTTP 500 (not retried: hook deleted)',
        },
      });
    });

    it('the in-process retry on a disabled hook does not set the deleted reason', async () => {
      vi.useFakeTimers();
      vi.mocked(prisma.aiEventHook.findMany).mockResolvedValue([makeHook()] as never);
      mockFetch.mockResolvedValue({ ok: false, status: 500 });
      vi.mocked(prisma.aiEventHookDelivery.findUnique)
        .mockResolvedValueOnce(makeDelivery({ attempts: 0 }))
        .mockImplementationOnce((async () => ({
          ...armedRow({ attempts: 1 }),
          hook: makeHook({ isEnabled: false }),
        })) as never);

      emitHookEvent('conversation.started', { conversationId: 'conv-1' });
      await vi.waitFor(() => {
        expect(prisma.aiEventHookDelivery.updateMany).toHaveBeenCalledTimes(1);
      });
      await vi.advanceTimersByTimeAsync(10_000);

      expect(prisma.aiEventHookDelivery.updateMany).toHaveBeenLastCalledWith({
        where: { id: 'del-1', status: AWAITING_STATUS },
        data: { status: 'exhausted', nextRetryAt: null },
      });
    });
  });
});

/** The erasure check's call: the transaction, who it asked about, and since when. */
function checkCall(): [unknown, unknown, { shared?: boolean; since: Date }] {
  const call = vi.mocked(findErasedSubjects).mock.calls[0];
  if (!call) throw new Error('the erasure check never ran');
  return call as unknown as [unknown, unknown, { shared?: boolean; since: Date }];
}

describe('a hook delivery built from an event taken before an erasure (t-886)', () => {
  beforeEach(() => {
    erasedSince.userIds = [];
    erasedSince.fail = null;
    // The row as the dispatch created it, so the attempt checks what it stored.
    vi.mocked(prisma.aiEventHookDelivery.create).mockImplementation((async (args: {
      data: Record<string, unknown>;
    }) => makeDelivery(args.data)) as never);
  });

  /** The data of every write that stopped the row as erasure stops one. */
  function stopWrites(): Array<Record<string, unknown>> {
    return vi
      .mocked(prisma.aiEventHookDelivery.updateMany)
      .mock.calls.map(([args]) => (args as { data: Record<string, unknown> }).data)
      .filter((data) => data.stoppedByErasure === true);
  }

  it('asks about the people the payload names, since the event was emitted', async () => {
    vi.mocked(prisma.aiEventHook.findMany).mockResolvedValue([
      makeHook({ eventType: 'workflow.failed' }),
    ] as never);
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValueOnce({
      userId: 'owner-1',
    } as never);
    const before = Date.now();

    emitHookEvent('workflow.failed', { executionId: 'exec-1', approverUserIds: ['a-1'] });

    await vi.waitFor(() => expect(findErasedSubjects).toHaveBeenCalled());
    const [, subjects, { since: takenAt }] = checkCall();
    expect(subjects).toEqual({ addresses: [], userIds: ['owner-1', 'a-1'] });
    expect(takenAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(takenAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('resolves who the payload names once for an event fanning out to many hooks (t-926)', async () => {
    vi.mocked(prisma.aiEventHook.findMany).mockResolvedValue([
      makeHook({ id: 'hook-1', eventType: 'workflow.failed' }),
      makeHook({ id: 'hook-2', eventType: 'workflow.failed' }),
      makeHook({ id: 'hook-3', eventType: 'workflow.failed' }),
    ] as never);
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue({
      userId: 'owner-1',
    } as never);

    emitHookEvent('workflow.failed', { executionId: 'exec-1' });

    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(3));
    expect(prisma.aiWorkflowExecution.findUnique).toHaveBeenCalledTimes(1);
  });

  it('falls back to each attempt looking up for itself when the shared lookup fails (t-926)', async () => {
    erasedSince.userIds = ['owner-1'];
    vi.mocked(prisma.aiEventHook.findMany).mockResolvedValue([
      makeHook({ id: 'hook-1', eventType: 'workflow.failed' }),
      makeHook({ id: 'hook-2', eventType: 'workflow.failed' }),
    ] as never);
    vi.mocked(prisma.aiWorkflowExecution.findUnique)
      .mockRejectedValueOnce(new Error('pool exhausted'))
      .mockResolvedValue({ userId: 'owner-1' } as never);

    emitHookEvent('workflow.failed', { executionId: 'exec-1' });

    await vi.waitFor(() => expect(stopWrites()).toHaveLength(2));
    expect(prisma.aiWorkflowExecution.findUnique).toHaveBeenCalledTimes(3);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('does not post an event about the activity of a person erased since, and stops the row', async () => {
    erasedSince.userIds = ['u-1'];
    vi.mocked(prisma.aiEventHook.findMany).mockResolvedValue([
      makeHook({ eventType: 'message.created' }),
    ] as never);

    emitHookEvent('message.created', { agentId: 'agent-1', userId: 'u-1', content: 'their words' });

    await vi.waitFor(() => expect(stopWrites()).toHaveLength(1));
    expect(mockFetch).not.toHaveBeenCalled();
    const [stop] = stopWrites();
    expect(stop).toMatchObject({
      status: 'exhausted',
      nextRetryAt: null,
      lastError: 'Not retried: subject erased',
    });
    expect((stop.payload as { data: unknown }).data).toEqual({ agentId: 'agent-1', userId: null });
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      'Hook delivery left out: it names a person erased since its event',
      { deliveryId: 'del-1' }
    );
  });

  it('posts an admin action without who acted, and stores what it posted', async () => {
    erasedSince.userIds = ['admin-1'];
    vi.mocked(prisma.aiEventHook.findMany).mockResolvedValue([
      makeHook({ eventType: 'agent.updated' }),
    ] as never);

    emitHookEvent('agent.updated', { agentId: 'agent-1', actorUserId: 'admin-1' });

    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledOnce());
    const posted = JSON.parse((mockFetch.mock.calls[0][1] as { body: string }).body) as {
      data: Record<string, unknown>;
    };
    expect(posted.data).toEqual({ agentId: 'agent-1', actorUserId: null });
    expect(prisma.aiEventHookDelivery.updateMany).toHaveBeenCalledWith({
      where: { id: 'del-1' },
      data: {
        payload: expect.objectContaining({ data: { agentId: 'agent-1', actorUserId: null } }),
      },
    });
    expect(stopWrites()).toEqual([]);
  });

  it('CONTROL — posts the same event when nobody in it was erased since', async () => {
    vi.mocked(prisma.aiEventHook.findMany).mockResolvedValue([
      makeHook({ eventType: 'message.created' }),
    ] as never);

    emitHookEvent('message.created', { agentId: 'agent-1', userId: 'u-1' });

    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledOnce());
    const posted = JSON.parse((mockFetch.mock.calls[0][1] as { body: string }).body) as {
      data: Record<string, unknown>;
    };
    expect(posted.data).toEqual({ agentId: 'agent-1', userId: 'u-1' });
    expect(stopWrites()).toEqual([]);
  });

  it('fails the attempt, to be retried, when the check cannot run', async () => {
    erasedSince.fail = new Error('canceling statement due to lock timeout');
    vi.mocked(prisma.aiEventHook.findMany).mockResolvedValue([makeHook()] as never);

    emitHookEvent('conversation.started', { conversationId: 'conv-1', userId: 'u-1' });

    await vi.waitFor(() =>
      expect(prisma.aiEventHookDelivery.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'failed',
            lastError:
              'Could not check for an erasure before sending: canceling statement due to lock timeout',
            // Not an attempt: nothing was posted (code review round 2).
            attempts: 0,
            nextRetryAt: expect.any(Date),
          }),
        })
      )
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('anchors a manual retry on its read, and checks the payload its reset returned', async () => {
    let readAt = 0;
    vi.mocked(prisma.aiEventHookDelivery.findUnique).mockImplementationOnce((() => {
      readAt = Date.now();
      return Promise.resolve({
        ...makeDelivery({ status: 'exhausted' }),
        hook: makeHook(),
      });
    }) as never);
    vi.mocked(prisma.aiEventHookDelivery.updateManyAndReturn).mockResolvedValueOnce([
      makeDelivery({
        status: 'pending',
        payload: {
          eventType: 'conversation.started',
          timestamp: '2026-10-22T00:00:00Z',
          data: { userId: 'u-7' },
        },
      }),
    ] as never);
    erasedSince.userIds = ['u-7'];

    await retryHookDelivery('del-1');

    await vi.waitFor(() => expect(stopWrites()).toHaveLength(1));
    const [, subjects, { since: takenAt }] = checkCall();
    expect(subjects).toEqual({ addresses: [], userIds: ['u-7'] });
    expect(takenAt.getTime()).toBeLessThanOrEqual(readAt);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
