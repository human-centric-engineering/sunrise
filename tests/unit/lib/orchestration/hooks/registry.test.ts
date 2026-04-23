/**
 * Tests: Event Hook Registry & Dispatcher
 *
 * Covers: emit → dispatch → webhook delivery (with persisted delivery records
 * and retry scheduling) and internal-handler paths. Also covers
 * `retryHookDelivery` and `processPendingHookRetries`.
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
  registerInternalHandler,
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

  it('dispatches internal handlers by name without creating a delivery record', async () => {
    const handler = vi.fn();
    registerInternalHandler('test-handler', handler);

    vi.mocked(prisma.aiEventHook.findMany).mockResolvedValue([
      makeHook({
        id: 'hook-2',
        eventType: 'workflow.completed',
        action: { type: 'internal', handler: 'test-handler' },
      }),
    ] as never);

    emitHookEvent('workflow.completed', { workflowId: 'wf-1' });

    await vi.waitFor(() => {
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'workflow.completed',
          data: { workflowId: 'wf-1' },
        })
      );
    });
    expect(prisma.aiEventHookDelivery.create).not.toHaveBeenCalled();
  });

  it('logs warning when internal handler is not registered', async () => {
    vi.mocked(prisma.aiEventHook.findMany).mockResolvedValue([
      makeHook({
        id: 'hook-3',
        eventType: 'agent.updated',
        action: { type: 'internal', handler: 'nonexistent' },
      }),
    ] as never);

    emitHookEvent('agent.updated', { agentId: 'agent-1' });

    await vi.waitFor(() => {
      expect(logger.warn).toHaveBeenCalledWith(
        'Hook internal handler not found',
        expect.objectContaining({ handler: 'nonexistent' })
      );
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

  it('returns false when hook is not a webhook action', async () => {
    vi.mocked(prisma.aiEventHookDelivery.findUnique).mockResolvedValue({
      ...makeDelivery({ status: 'exhausted' }),
      hook: makeHook({ action: { type: 'internal', handler: 'x' } }),
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
});
