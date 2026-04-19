/**
 * Webhook Dispatcher Unit Tests
 *
 * Tests for webhook delivery with HMAC signing, delivery tracking,
 * and retry logic.
 *
 * @see lib/orchestration/webhooks/dispatcher.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiWebhookSubscription: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
    },
    aiWebhookDelivery: {
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
    error: vi.fn(),
    info: vi.fn(),
  },
}));

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import {
  dispatchWebhookEvent,
  retryDelivery,
  processPendingRetries,
} from '@/lib/orchestration/webhooks/dispatcher';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeSub(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sub-1',
    url: 'https://example.com/webhook',
    secret: 'test-secret-key-1234567890',
    events: ['budget_exceeded', 'workflow_failed'],
    isActive: true,
    description: null,
    createdBy: 'user-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeDelivery(overrides: Record<string, unknown> = {}) {
  return {
    id: 'del-1',
    subscriptionId: 'sub-1',
    eventType: 'budget_exceeded',
    payload: { event: 'budget_exceeded', data: {} },
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

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('dispatchWebhookEvent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue({ ok: true, status: 200 });
    vi.mocked(prisma.aiWebhookDelivery.create).mockResolvedValue(makeDelivery() as never);
    vi.mocked(prisma.aiWebhookDelivery.update).mockResolvedValue(makeDelivery() as never);
    vi.mocked(prisma.aiWebhookDelivery.findUnique).mockResolvedValue(makeDelivery() as never);
  });

  it('does nothing when no subscriptions match', async () => {
    vi.mocked(prisma.aiWebhookSubscription.findMany).mockResolvedValue([]);

    await dispatchWebhookEvent('budget_exceeded', { agentId: 'agent-1' });

    expect(mockFetch).not.toHaveBeenCalled();
    expect(prisma.aiWebhookDelivery.create).not.toHaveBeenCalled();
  });

  it('creates a delivery record and sends POST to matching subscription', async () => {
    vi.mocked(prisma.aiWebhookSubscription.findMany).mockResolvedValue([makeSub()] as never);

    await dispatchWebhookEvent('budget_exceeded', { agentId: 'agent-1' });

    expect(prisma.aiWebhookDelivery.create).toHaveBeenCalledTimes(1);
    expect(prisma.aiWebhookDelivery.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          subscriptionId: 'sub-1',
          eventType: 'budget_exceeded',
          status: 'pending',
        }),
      })
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://example.com/webhook',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          'X-Webhook-Event': 'budget_exceeded',
        }),
      })
    );
  });

  it('includes X-Webhook-Signature header with HMAC-SHA256', async () => {
    vi.mocked(prisma.aiWebhookSubscription.findMany).mockResolvedValue([makeSub()] as never);

    await dispatchWebhookEvent('budget_exceeded', { agentId: 'agent-1' });

    const headers = mockFetch.mock.calls[0][1].headers as Record<string, string>;
    expect(headers['X-Webhook-Signature']).toBeDefined();
    expect(typeof headers['X-Webhook-Signature']).toBe('string');
    expect(headers['X-Webhook-Signature'].length).toBe(64);
  });

  it('sends JSON body with event, timestamp, and data', async () => {
    vi.mocked(prisma.aiWebhookSubscription.findMany).mockResolvedValue([makeSub()] as never);

    await dispatchWebhookEvent('workflow_failed', { error: 'step 3 failed' });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string) as Record<string, unknown>;
    expect(body.event).toBe('workflow_failed');
    expect(body.timestamp).toBeDefined();
    expect(body.data).toEqual({ error: 'step 3 failed' });
  });

  it('dispatches to multiple subscriptions', async () => {
    vi.mocked(prisma.aiWebhookSubscription.findMany).mockResolvedValue([
      makeSub({ id: 'sub-1', url: 'https://a.com/hook' }),
      makeSub({ id: 'sub-2', url: 'https://b.com/hook', secret: 'different-secret-key-1234' }),
    ] as never);

    await dispatchWebhookEvent('budget_exceeded', { agentId: 'agent-1' });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(prisma.aiWebhookDelivery.create).toHaveBeenCalledTimes(2);
  });

  it('marks delivery as delivered on success', async () => {
    vi.mocked(prisma.aiWebhookSubscription.findMany).mockResolvedValue([makeSub()] as never);
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    await dispatchWebhookEvent('budget_exceeded', { agentId: 'agent-1' });

    expect(prisma.aiWebhookDelivery.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'delivered',
          lastResponseCode: 200,
        }),
      })
    );
  });

  it('marks delivery as failed and logs warning on non-ok response', async () => {
    vi.mocked(prisma.aiWebhookSubscription.findMany).mockResolvedValue([makeSub()] as never);
    mockFetch.mockResolvedValue({ ok: false, status: 500 });

    await dispatchWebhookEvent('budget_exceeded', { agentId: 'agent-1' });

    expect(logger.warn).toHaveBeenCalledWith(
      'Webhook delivery failed',
      expect.objectContaining({
        deliveryId: 'del-1',
        error: 'HTTP 500',
      })
    );
  });

  it('does not throw when fetch rejects (fire-and-forget)', async () => {
    vi.mocked(prisma.aiWebhookSubscription.findMany).mockResolvedValue([makeSub()] as never);
    mockFetch.mockRejectedValue(new Error('Network error'));

    await expect(
      dispatchWebhookEvent('budget_exceeded', { agentId: 'agent-1' })
    ).resolves.toBeUndefined();
  });

  it('queries for active subscriptions with matching event type', async () => {
    vi.mocked(prisma.aiWebhookSubscription.findMany).mockResolvedValue([]);

    await dispatchWebhookEvent('circuit_breaker_opened', { providerSlug: 'anthropic' });

    expect(prisma.aiWebhookSubscription.findMany).toHaveBeenCalledWith({
      where: {
        isActive: true,
        events: { has: 'circuit_breaker_opened' },
      },
    });
  });
});

describe('retryDelivery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue({ ok: true, status: 200 });
    vi.mocked(prisma.aiWebhookDelivery.update).mockResolvedValue(makeDelivery() as never);
    vi.mocked(prisma.aiWebhookDelivery.findUnique).mockResolvedValue(makeDelivery() as never);
  });

  it('returns false when delivery not found', async () => {
    vi.mocked(prisma.aiWebhookDelivery.findUnique).mockResolvedValue(null);

    const result = await retryDelivery('nonexistent');

    expect(result).toBe(false);
  });

  it('resets delivery state and re-attempts', async () => {
    vi.mocked(prisma.aiWebhookDelivery.findUnique).mockResolvedValue({
      ...makeDelivery({ status: 'exhausted', attempts: 3 }),
      subscription: makeSub(),
    } as never);

    const result = await retryDelivery('del-1');

    expect(result).toBe(true);
    expect(prisma.aiWebhookDelivery.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'del-1' },
        data: expect.objectContaining({
          status: 'pending',
          attempts: 0,
        }),
      })
    );
  });
});

describe('processPendingRetries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue({ ok: true, status: 200 });
    vi.mocked(prisma.aiWebhookDelivery.update).mockResolvedValue(makeDelivery() as never);
    vi.mocked(prisma.aiWebhookDelivery.findUnique).mockResolvedValue(makeDelivery() as never);
  });

  it('returns 0 when no pending retries', async () => {
    vi.mocked(prisma.aiWebhookDelivery.findMany).mockResolvedValue([]);

    const count = await processPendingRetries();

    expect(count).toBe(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('processes pending retries and returns count', async () => {
    vi.mocked(prisma.aiWebhookDelivery.findMany).mockResolvedValue([
      { ...makeDelivery({ id: 'del-1', attempts: 1 }), subscription: makeSub() },
      { ...makeDelivery({ id: 'del-2', attempts: 2 }), subscription: makeSub({ id: 'sub-2' }) },
    ] as never);

    const count = await processPendingRetries();

    expect(count).toBe(2);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
