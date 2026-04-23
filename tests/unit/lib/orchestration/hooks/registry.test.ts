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

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiEventHook: {
      findMany: vi.fn(),
    },
    aiEventHookDelivery: {
      create: vi.fn(),
      update: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
  },
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

// ─── Fixtures ───────────────────────────────────────────────────────────

function makeHook(overrides: Record<string, unknown> = {}) {
  return {
    id: 'hook-1',
    name: 'Test Hook',
    eventType: 'conversation.started',
    action: { type: 'webhook', url: 'https://example.com/hook' },
    filter: null,
    isEnabled: true,
    createdBy: 'user-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeDelivery(overrides: Record<string, unknown> = {}) {
  return {
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
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  invalidateHookCache();
  mockFetch.mockResolvedValue({ ok: true, status: 200 });
  vi.mocked(prisma.aiEventHookDelivery.create).mockResolvedValue(makeDelivery() as never);
  vi.mocked(prisma.aiEventHookDelivery.update).mockResolvedValue(makeDelivery() as never);
  vi.mocked(prisma.aiEventHookDelivery.findUnique).mockResolvedValue(makeDelivery() as never);
});

afterEach(() => {
  invalidateHookCache();
});

describe('emitHookEvent', () => {
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
      expect(prisma.aiEventHookDelivery.update).toHaveBeenCalledWith(
        expect.objectContaining({
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
      makeDelivery({ attempts: 2 }) as never
    );

    emitHookEvent('conversation.started', { conversationId: 'conv-1' });

    await vi.waitFor(() => {
      expect(prisma.aiEventHookDelivery.update).toHaveBeenCalledWith(
        expect.objectContaining({
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
      expect(prisma.aiEventHookDelivery.update).toHaveBeenCalledWith(
        expect.objectContaining({
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
  });

  it('returns false when hook action is not a webhook (defensive against legacy data)', async () => {
    vi.mocked(prisma.aiEventHookDelivery.findUnique).mockResolvedValue({
      ...makeDelivery({ status: 'exhausted' }),
      hook: makeHook({ action: { type: 'legacy-internal', handler: 'x' } }),
    } as never);

    const result = await retryHookDelivery('del-1');

    expect(result).toBe(false);
  });

  it('resets delivery state and re-attempts', async () => {
    vi.mocked(prisma.aiEventHookDelivery.findUnique).mockResolvedValue({
      ...makeDelivery({ status: 'exhausted', attempts: 3 }),
      hook: makeHook(),
    } as never);

    const result = await retryHookDelivery('del-1');

    expect(result).toBe(true);
    expect(prisma.aiEventHookDelivery.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'del-1' },
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
      makeDelivery({ id: deliveryId, hookId, attempts: 0 }) as never
    );

    // First fetch fails — triggers scheduleRetry
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
    // Second fetch succeeds — triggered by the retry timer
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200 });

    // findUnique call 1 (in attemptDelivery failure path, no include) — returns attempts: 0
    vi.mocked(prisma.aiEventHookDelivery.findUnique).mockResolvedValueOnce(
      makeDelivery({ id: deliveryId, attempts: 0 }) as never
    );

    // findUnique call 2 (in scheduleRetry timer, with include: { hook: true }) — returns delivery with enabled hook
    vi.mocked(prisma.aiEventHookDelivery.findUnique).mockResolvedValueOnce({
      ...makeDelivery({ id: deliveryId, attempts: 1 }),
      hook: makeHook({
        id: hookId,
        eventType: 'workflow.completed',
        action: { type: 'webhook', url: webhookUrl },
      }),
    } as never);

    // Act — emit event; initial attempt fails, schedules 10s retry
    emitHookEvent('workflow.completed', { workflowId: 'wf-1' });

    // Wait for the initial dispatch to complete (fetch + findUnique + update all settle)
    await vi.waitFor(() => {
      expect(prisma.aiEventHookDelivery.update).toHaveBeenCalledTimes(1);
    });

    // Verify initial failure update
    const updateCalls = vi.mocked(prisma.aiEventHookDelivery.update).mock.calls;
    const firstUpdate = updateCalls[0]?.[0];
    expect(firstUpdate).toMatchObject({
      where: { id: deliveryId },
      data: expect.objectContaining({ status: 'failed' }),
    });

    // Advance timers to fire the scheduleRetry callback (10_000ms delay)
    await vi.advanceTimersByTimeAsync(10_000);

    // Assert — the retry fired, second fetch was called, and delivery flipped to delivered
    expect(mockFetch).toHaveBeenCalledTimes(2);

    const allUpdateCalls = vi.mocked(prisma.aiEventHookDelivery.update).mock.calls;
    const deliveredCall = allUpdateCalls.find(
      (call) => (call[0] as { data: { status?: string } }).data?.status === 'delivered'
    );
    expect(deliveredCall).toBeDefined();
    expect(deliveredCall?.[0]).toMatchObject({
      where: { id: deliveryId },
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
      makeDelivery({ id: deliveryId, hookId, attempts: 0 }) as never
    );

    // Initial fetch fails — triggers scheduleRetry
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503 });

    // findUnique call 1 (in attemptDelivery failure path) — returns attempts: 0
    vi.mocked(prisma.aiEventHookDelivery.findUnique).mockResolvedValueOnce(
      makeDelivery({ id: deliveryId, attempts: 0 }) as never
    );

    // findUnique call 2 (in scheduleRetry timer) — hook is now disabled
    vi.mocked(prisma.aiEventHookDelivery.findUnique).mockResolvedValueOnce({
      ...makeDelivery({ id: deliveryId, attempts: 1 }),
      hook: makeHook({ id: hookId, isEnabled: false }),
    } as never);

    // Act
    emitHookEvent('workflow.completed', { workflowId: 'wf-2' });
    await vi.waitFor(() => {
      expect(prisma.aiEventHookDelivery.update).toHaveBeenCalledTimes(1);
    });

    // Advance timers to fire retry callback
    await vi.advanceTimersByTimeAsync(10_000);

    // Assert — fetch was NOT called again (no re-dispatch)
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // An exhausted update was issued for the disabled hook
    const allUpdateCalls = vi.mocked(prisma.aiEventHookDelivery.update).mock.calls;
    const exhaustedCall = allUpdateCalls.find(
      (call) => (call[0] as { data: { status?: string } }).data?.status === 'exhausted'
    );
    expect(exhaustedCall).toBeDefined();
    expect(exhaustedCall?.[0]).toMatchObject({
      where: { id: deliveryId },
      data: expect.objectContaining({ status: 'exhausted', nextRetryAt: null }),
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
      makeDelivery({ id: deliveryId, hookId, attempts: 0 }) as never
    );

    // Initial fetch fails — triggers scheduleRetry
    mockFetch.mockResolvedValueOnce({ ok: false, status: 502 });

    // findUnique call 1 (in attemptDelivery failure path) — returns attempts: 0
    vi.mocked(prisma.aiEventHookDelivery.findUnique).mockResolvedValueOnce(
      makeDelivery({ id: deliveryId, attempts: 0 }) as never
    );

    // findUnique call 2 (in scheduleRetry timer) — hook action is no longer a webhook
    vi.mocked(prisma.aiEventHookDelivery.findUnique).mockResolvedValueOnce({
      ...makeDelivery({ id: deliveryId, attempts: 1 }),
      hook: makeHook({ id: hookId, action: { type: 'internal', handler: 'some-handler' } }),
    } as never);

    // Act
    emitHookEvent('workflow.completed', { workflowId: 'wf-3' });
    await vi.waitFor(() => {
      expect(prisma.aiEventHookDelivery.update).toHaveBeenCalledTimes(1);
    });

    // Advance timers to fire retry callback
    await vi.advanceTimersByTimeAsync(10_000);

    // Assert — fetch was NOT called again (returned early for non-webhook action)
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // No further update calls beyond the initial failure update
    expect(prisma.aiEventHookDelivery.update).toHaveBeenCalledTimes(1);
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
    vi.mocked(prisma.aiEventHookDelivery.findMany).mockResolvedValue([
      { ...makeDelivery({ id: 'del-1', attempts: 1 }), hook: makeHook() },
      { ...makeDelivery({ id: 'del-2', attempts: 2 }), hook: makeHook({ id: 'hook-2' }) },
    ] as never);

    const count = await processPendingHookRetries();

    expect(count).toBe(2);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('marks deliveries exhausted when their hook has been disabled', async () => {
    vi.mocked(prisma.aiEventHookDelivery.findMany).mockResolvedValue([
      { ...makeDelivery({ id: 'del-1' }), hook: makeHook({ isEnabled: false }) },
    ] as never);

    await processPendingHookRetries();

    expect(mockFetch).not.toHaveBeenCalled();
    expect(prisma.aiEventHookDelivery.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'del-1' },
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

    await vi.waitFor(() => {
      expect(prisma.aiEventHook.findMany).toHaveBeenCalled();
    });

    // Assert — filter did not match, so no delivery record was created and no fetch fired
    expect(prisma.aiEventHookDelivery.create).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
