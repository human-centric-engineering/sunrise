/**
 * Webhook Dispatcher Unit Tests
 *
 * Tests for fire-and-forget webhook delivery with HMAC signing.
 *
 * @see lib/orchestration/webhooks/dispatcher.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiWebhookSubscription: {
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
import { dispatchWebhookEvent } from '@/lib/orchestration/webhooks/dispatcher';

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

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('dispatchWebhookEvent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue({ ok: true });
  });

  it('does nothing when no subscriptions match', async () => {
    vi.mocked(prisma.aiWebhookSubscription.findMany).mockResolvedValue([]);

    await dispatchWebhookEvent('budget_exceeded', { agentId: 'agent-1' });

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('sends POST to matching subscription URLs', async () => {
    vi.mocked(prisma.aiWebhookSubscription.findMany).mockResolvedValue([makeSub()] as never);

    await dispatchWebhookEvent('budget_exceeded', { agentId: 'agent-1' });

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

    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers['X-Webhook-Signature']).toBeDefined();
    expect(typeof headers['X-Webhook-Signature']).toBe('string');
    expect(headers['X-Webhook-Signature'].length).toBe(64); // SHA256 hex = 64 chars
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
  });

  it('logs warning when delivery fails with non-ok response', async () => {
    vi.mocked(prisma.aiWebhookSubscription.findMany).mockResolvedValue([makeSub()] as never);
    mockFetch.mockResolvedValue({ ok: false, status: 500 });

    await dispatchWebhookEvent('budget_exceeded', { agentId: 'agent-1' });

    expect(logger.warn).toHaveBeenCalledWith(
      'Webhook delivery failed',
      expect.objectContaining({ statusCode: 500 })
    );
  });

  it('does not throw when fetch rejects (fire-and-forget)', async () => {
    vi.mocked(prisma.aiWebhookSubscription.findMany).mockResolvedValue([makeSub()] as never);
    mockFetch.mockRejectedValue(new Error('Network error'));

    // Should not throw
    await expect(
      dispatchWebhookEvent('budget_exceeded', { agentId: 'agent-1' })
    ).resolves.toBeUndefined();
  });

  it('logs failures count when some dispatches reject', async () => {
    vi.mocked(prisma.aiWebhookSubscription.findMany).mockResolvedValue([
      makeSub({ id: 'sub-1' }),
      makeSub({ id: 'sub-2', url: 'https://failing.com/hook' }),
    ] as never);
    mockFetch.mockResolvedValueOnce({ ok: true }).mockRejectedValueOnce(new Error('timeout'));

    await dispatchWebhookEvent('budget_exceeded', {});

    expect(logger.warn).toHaveBeenCalledWith(
      'Webhook dispatch failures',
      expect.objectContaining({ total: 2, failed: 1 })
    );
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
