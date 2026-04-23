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
    secret: null,
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
    expect(allUpdateCalls.length).toBe(2);
    expect(allUpdateCalls.at(-1)![0]).toMatchObject({
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
    expect(allUpdateCalls.length).toBe(2);
    expect(allUpdateCalls.at(-1)![0]).toMatchObject({
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

    // parseDeliveryForDispatch issues an exhausted update for the invalid action row,
    // so there are now 2 update calls total: the initial failure update + the exhausted update.
    const allUpdates = vi.mocked(prisma.aiEventHookDelivery.update).mock.calls;
    expect(allUpdates.length).toBe(2);
    const exhaustedUpdate = allUpdates[1];
    expect(exhaustedUpdate?.[0]).toMatchObject({
      where: { id: deliveryId },
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
      makeDelivery({ hookId: validHookId }) as never
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
    expect(prisma.aiEventHookDelivery.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'del-bad-action' },
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
    expect(prisma.aiEventHookDelivery.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'del-bad-payload' },
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

    vi.mocked(prisma.aiEventHookDelivery.findUnique).mockResolvedValue({
      ...makeDelivery({ id: deliveryId, status: 'failed', attempts: 1, payload: validPayload }),
      hook: makeHook({
        isEnabled: true,
        action: { type: 'webhook', url: webhookUrl },
      }),
    } as never);

    // Act
    const result = await retryHookDelivery(deliveryId);

    // Assert — returns true
    expect(result).toBe(true);

    // First update call sets status: 'pending' (the reset before re-dispatch)
    const updateCalls = vi.mocked(prisma.aiEventHookDelivery.update).mock.calls;
    const pendingUpdate = updateCalls[0];
    expect(pendingUpdate?.[0]).toMatchObject({
      where: { id: deliveryId },
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
        ...makeDelivery({ id: validId, attempts: 1, payload: validPayload }),
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
    expect(prisma.aiEventHookDelivery.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: invalidId },
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
      makeDelivery({ id: 'del-null-guard' }) as never
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
      makeDelivery({ id: deliveryId, hookId, attempts: 0 }) as never
    );

    // First attempt fails → schedules retry 10s out
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
    // Retry attempt succeeds
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200 });

    vi.mocked(prisma.aiEventHookDelivery.findUnique).mockResolvedValueOnce(
      makeDelivery({ id: deliveryId, attempts: 0 }) as never
    );
    vi.mocked(prisma.aiEventHookDelivery.findUnique).mockResolvedValueOnce({
      ...makeDelivery({ id: deliveryId, attempts: 1 }),
      hook: makeHook({
        id: hookId,
        eventType: 'workflow.completed',
        action: { type: 'webhook', url: 'https://example.com/signed-retry' },
        secret,
      }),
    } as never);

    emitHookEvent('workflow.completed', { workflowId: 'wf-1' });

    await vi.waitFor(() => {
      expect(prisma.aiEventHookDelivery.update).toHaveBeenCalledTimes(1);
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
});
