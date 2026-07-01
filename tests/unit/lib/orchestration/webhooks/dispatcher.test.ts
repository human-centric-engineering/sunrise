/**
 * Webhook Dispatcher Unit Tests
 *
 * Tests for webhook delivery with HMAC signing, delivery tracking,
 * and retry logic.
 *
 * @see lib/orchestration/webhooks/dispatcher.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

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
    debug: vi.fn(),
  },
}));

// Email-channel delivery routes through Resend. Stub the client + the
// React Email render so dispatcher tests stay hermetic.
const mockResendSend = vi.fn();
vi.mock('@/lib/email/client', () => ({
  getResendClient: vi.fn(() => ({ emails: { send: mockResendSend } })),
  getDefaultSender: vi.fn(() => 'Sunrise <noreply@example.com>'),
  isEmailEnabled: vi.fn(() => true),
}));
vi.mock('@react-email/render', () => ({
  render: vi.fn().mockResolvedValue('<html>rendered</html>'),
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
    channel: 'webhook',
    url: 'https://example.com/webhook',
    secret: 'test-secret-key-1234567890',
    emailAddress: null,
    events: ['budget_exceeded', 'workflow_failed'],
    agentIds: [] as string[],
    workflowIds: [] as string[],
    isActive: true,
    description: null,
    maxAttempts: 3,
    retryBackoffMs: [10_000, 60_000, 300_000],
    createdBy: 'user-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeEmailSub(overrides: Record<string, unknown> = {}) {
  return makeSub({
    id: 'sub-email',
    channel: 'email',
    url: null,
    secret: null,
    emailAddress: 'alerts@example.com',
    ...overrides,
  });
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
    vi.mocked(prisma.aiWebhookDelivery.create).mockResolvedValue(makeDelivery());
    vi.mocked(prisma.aiWebhookDelivery.update).mockResolvedValue(makeDelivery());
    vi.mocked(prisma.aiWebhookDelivery.findUnique).mockResolvedValue(makeDelivery());
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

  it('skips dispatch and marks delivery exhausted when subscription has no signing secret', async () => {
    vi.mocked(prisma.aiWebhookSubscription.findMany).mockResolvedValue([
      makeSub({ secret: '' }),
    ] as never);

    await dispatchWebhookEvent('budget_exceeded', { agentId: 'agent-1' });

    expect(mockFetch).not.toHaveBeenCalled();

    // Exactly one delivery update — terminal failure with exhausted status
    // and the diagnostic error preserved.
    const updateCalls = vi.mocked(prisma.aiWebhookDelivery.update).mock.calls;
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0][0]).toMatchObject({
      data: expect.objectContaining({
        status: 'exhausted',
        lastError: 'Subscription has no signing secret',
        nextRetryAt: null,
      }),
    });
    // Regression guard: no later overwrite to 'delivered' that would
    // mask a misconfigured subscription as a successful send.
    expect(updateCalls.every((c) => c[0]?.data?.status !== 'delivered')).toBe(true);

    expect(logger.warn).toHaveBeenCalledWith(
      'Webhook delivery failed',
      expect.objectContaining({
        deliveryId: 'del-1',
        exhausted: true,
        terminal: true,
        error: 'Subscription has no signing secret',
      })
    );
  });
});

describe('retryDelivery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue({ ok: true, status: 200 });
    vi.mocked(prisma.aiWebhookDelivery.update).mockResolvedValue(makeDelivery());
    vi.mocked(prisma.aiWebhookDelivery.findUnique).mockResolvedValue(makeDelivery());
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

    // test-review:accept tobe_true — boolean return from retryDelivery; structural assertion on retry outcome
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

  it('default mode returns before the outbound HTTP resolves (fire-and-forget)', async () => {
    // Single-row retry path: caller shouldn't have to wait for the receiver.
    vi.mocked(prisma.aiWebhookDelivery.findUnique).mockResolvedValue({
      ...makeDelivery({ status: 'exhausted', attempts: 3 }),
      subscription: makeSub(),
    } as never);

    // Deferred fetch — only resolves when we explicitly say so.
    let resolveFetch!: (v: { ok: boolean; status: number }) => void;
    mockFetch.mockReturnValueOnce(
      new Promise((r) => {
        resolveFetch = r;
      })
    );

    const promise = retryDelivery('del-1');
    // Without awaitDelivery, the call resolves before the fetch promise does.
    await expect(promise).resolves.toBe(true);

    // Drain the still-in-flight fetch so the test doesn't leave a dangling promise.
    resolveFetch({ ok: true, status: 200 });
  });

  it('awaitDelivery: true blocks until the outbound HTTP resolves', async () => {
    // Bulk-replay path: the chunked Promise.all needs the retry to await the
    // network so the stated concurrency cap actually throttles outbound HTTPs.
    vi.mocked(prisma.aiWebhookDelivery.findUnique).mockResolvedValue({
      ...makeDelivery({ status: 'exhausted', attempts: 3 }),
      subscription: makeSub(),
    } as never);

    let resolveFetch!: (v: { ok: boolean; status: number }) => void;
    let fetchResolved = false;
    mockFetch.mockReturnValueOnce(
      new Promise((r) => {
        resolveFetch = (v) => {
          fetchResolved = true;
          r(v);
        };
      })
    );

    const promise = retryDelivery('del-1', { awaitDelivery: true });

    // Give the microtask queue a chance — if the call weren't awaiting fetch,
    // it would have settled by now.
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchResolved).toBe(false);

    resolveFetch({ ok: true, status: 200 });
    await expect(promise).resolves.toBe(true);
    expect(fetchResolved).toBe(true);
  });
});

describe('processPendingRetries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue({ ok: true, status: 200 });
    vi.mocked(prisma.aiWebhookDelivery.update).mockResolvedValue(makeDelivery());
    vi.mocked(prisma.aiWebhookDelivery.findUnique).mockResolvedValue(makeDelivery());
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

  it('queries for failed deliveries past their nextRetryAt without an attempts cap', async () => {
    // With per-subscription maxAttempts the cap is enforced in code, not SQL —
    // `status='failed'` already implies attempts < maxAttempts since the
    // dispatcher transitions to `exhausted` at the cap.
    vi.mocked(prisma.aiWebhookDelivery.findMany).mockResolvedValue([]);

    await processPendingRetries();

    const callArg = vi.mocked(prisma.aiWebhookDelivery.findMany).mock.calls[0][0];
    expect(callArg?.where).toMatchObject({ status: 'failed' });
    expect((callArg?.where as Record<string, unknown>).attempts).toBeUndefined();
  });
});

// ─── Delivery failure / retry exhaustion ────────────────────────────────────

describe('delivery failure behaviour', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.aiWebhookDelivery.create).mockResolvedValue(makeDelivery());
    vi.mocked(prisma.aiWebhookDelivery.update).mockResolvedValue(makeDelivery());
  });

  it('marks delivery as exhausted when attempts reach MAX_ATTEMPTS', async () => {
    // Arrange: delivery already at attempt 2 (next attempt = 3 = MAX)
    vi.mocked(prisma.aiWebhookSubscription.findMany).mockResolvedValue([makeSub()] as never);
    vi.mocked(prisma.aiWebhookDelivery.findUnique).mockResolvedValue(makeDelivery({ attempts: 2 }));
    mockFetch.mockResolvedValue({ ok: false, status: 500 });

    await dispatchWebhookEvent('budget_exceeded', { agentId: 'agent-1' });

    expect(prisma.aiWebhookDelivery.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'exhausted',
        }),
      })
    );
  });

  it('marks delivery as failed (not exhausted) on first failure', async () => {
    // Arrange: fresh delivery (0 attempts)
    vi.mocked(prisma.aiWebhookSubscription.findMany).mockResolvedValue([makeSub()] as never);
    vi.mocked(prisma.aiWebhookDelivery.findUnique).mockResolvedValue(makeDelivery({ attempts: 0 }));
    mockFetch.mockResolvedValue({ ok: false, status: 500 });

    await dispatchWebhookEvent('budget_exceeded', { agentId: 'agent-1' });

    expect(prisma.aiWebhookDelivery.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'failed',
        }),
      })
    );
  });

  it('skips update gracefully when delivery record is gone after failure', async () => {
    // Arrange: findUnique returns null after the fetch fails
    vi.mocked(prisma.aiWebhookSubscription.findMany).mockResolvedValue([makeSub()] as never);
    vi.mocked(prisma.aiWebhookDelivery.findUnique).mockResolvedValue(null);
    mockFetch.mockResolvedValue({ ok: false, status: 500 });

    // Should not throw
    await expect(
      dispatchWebhookEvent('budget_exceeded', { agentId: 'agent-1' })
    ).resolves.toBeUndefined();
  });

  it('logs top-level error when prisma subscription query throws', async () => {
    vi.mocked(prisma.aiWebhookSubscription.findMany).mockRejectedValue(
      new Error('DB connection lost')
    );

    await dispatchWebhookEvent('budget_exceeded', { agentId: 'a' });

    expect(logger.error).toHaveBeenCalledWith(
      'Webhook dispatch error',
      expect.objectContaining({ error: 'DB connection lost' })
    );
  });

  it('records lastResponseCode on non-ok response', async () => {
    vi.mocked(prisma.aiWebhookSubscription.findMany).mockResolvedValue([makeSub()] as never);
    vi.mocked(prisma.aiWebhookDelivery.findUnique).mockResolvedValue(makeDelivery({ attempts: 0 }));
    mockFetch.mockResolvedValue({ ok: false, status: 422 });

    await dispatchWebhookEvent('budget_exceeded', {});

    expect(prisma.aiWebhookDelivery.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ lastResponseCode: 422 }),
      })
    );
  });

  it('records AbortError (timeout) as string error message', async () => {
    vi.mocked(prisma.aiWebhookSubscription.findMany).mockResolvedValue([makeSub()] as never);
    vi.mocked(prisma.aiWebhookDelivery.findUnique).mockResolvedValue(makeDelivery({ attempts: 0 }));
    // Simulate abort from timeout
    const abortErr = new DOMException('The operation was aborted.', 'AbortError');
    mockFetch.mockRejectedValue(abortErr);

    await dispatchWebhookEvent('budget_exceeded', {});

    expect(logger.warn).toHaveBeenCalledWith(
      'Webhook delivery failed',
      expect.objectContaining({ error: expect.stringContaining('aborted') })
    );
  });
});

// ─── Per-subscription retry policy ──────────────────────────────────────────

describe('per-subscription retry policy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.mocked(prisma.aiWebhookDelivery.create).mockResolvedValue(makeDelivery());
    vi.mocked(prisma.aiWebhookDelivery.update).mockResolvedValue(makeDelivery());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('marks delivery exhausted after the subscription-configured maxAttempts is reached', async () => {
    // Subscription configured with maxAttempts=2 → after attempt 2 fails, exhausted.
    vi.mocked(prisma.aiWebhookSubscription.findMany).mockResolvedValue([
      makeSub({ maxAttempts: 2, retryBackoffMs: [5_000] }),
    ] as never);
    // Delivery already has 1 attempt — next attempt becomes #2.
    vi.mocked(prisma.aiWebhookDelivery.findUnique).mockResolvedValue(makeDelivery({ attempts: 1 }));
    mockFetch.mockResolvedValue({ ok: false, status: 500 });

    await dispatchWebhookEvent('budget_exceeded', { agentId: 'a' });

    expect(prisma.aiWebhookDelivery.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'exhausted' }),
      })
    );
  });

  it('uses the subscription retryBackoffMs schedule for nextRetryAt', async () => {
    // Custom schedule [5s, 30s] — verify the FIRST failure schedules the 5s delay.
    vi.mocked(prisma.aiWebhookSubscription.findMany).mockResolvedValue([
      makeSub({ maxAttempts: 3, retryBackoffMs: [5_000, 30_000] }),
    ] as never);
    vi.mocked(prisma.aiWebhookDelivery.findUnique).mockResolvedValue(makeDelivery({ attempts: 0 }));
    const beforeMs = Date.now();
    mockFetch.mockResolvedValue({ ok: false, status: 500 });

    await dispatchWebhookEvent('budget_exceeded', {});

    // Locate the update call that records the failure with a nextRetryAt.
    const failUpdate = vi
      .mocked(prisma.aiWebhookDelivery.update)
      .mock.calls.find((c) => (c[0]?.data as Record<string, unknown>)?.status === 'failed');
    expect(failUpdate).toBeDefined();
    const nextRetryAt = (failUpdate?.[0]?.data as Record<string, unknown>)?.nextRetryAt as Date;
    expect(nextRetryAt).toBeInstanceOf(Date);
    // Should land ~5s after the dispatch start (with a wide tolerance for fake-timer clocks).
    expect(nextRetryAt.getTime() - beforeMs).toBeGreaterThanOrEqual(4_000);
    expect(nextRetryAt.getTime() - beforeMs).toBeLessThan(10_000);
  });

  it('falls back to the last backoff entry when the array is shorter than maxAttempts-1', async () => {
    // maxAttempts=4 needs 3 backoff entries; provide only 1.
    vi.mocked(prisma.aiWebhookSubscription.findMany).mockResolvedValue([
      makeSub({ maxAttempts: 4, retryBackoffMs: [7_000] }),
    ] as never);
    // Delivery has 2 attempts; next failure is attempt #3 → would normally
    // need retryBackoffMs[2], but we only have index 0.
    vi.mocked(prisma.aiWebhookDelivery.findUnique).mockResolvedValue(makeDelivery({ attempts: 2 }));
    mockFetch.mockResolvedValue({ ok: false, status: 500 });
    const beforeMs = Date.now();

    await dispatchWebhookEvent('budget_exceeded', {});

    const failUpdate = vi
      .mocked(prisma.aiWebhookDelivery.update)
      .mock.calls.find((c) => (c[0]?.data as Record<string, unknown>)?.status === 'failed');
    const nextRetryAt = (failUpdate?.[0]?.data as Record<string, unknown>)?.nextRetryAt as Date;
    // Should fall back to the single configured entry (7s).
    expect(nextRetryAt.getTime() - beforeMs).toBeGreaterThanOrEqual(6_000);
    expect(nextRetryAt.getTime() - beforeMs).toBeLessThan(15_000);
  });
});

// ─── scheduleRetry internal callback ────────────────────────────────────────

describe('scheduleRetry (in-process timer-based retry)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockFetch.mockResolvedValue({ ok: true, status: 200 });
    vi.mocked(prisma.aiWebhookDelivery.create).mockResolvedValue(makeDelivery());
    vi.mocked(prisma.aiWebhookDelivery.update).mockResolvedValue(makeDelivery());
    vi.mocked(prisma.aiWebhookDelivery.findUnique).mockResolvedValue(makeDelivery({ attempts: 0 }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries delivery after delay when first attempt fails and subscription is still active', async () => {
    // Arrange: first attempt fails (attempts=0 → scheduleRetry fires after delay)
    vi.mocked(prisma.aiWebhookSubscription.findMany).mockResolvedValue([makeSub()] as never);
    vi.mocked(prisma.aiWebhookDelivery.findUnique).mockResolvedValue(makeDelivery({ attempts: 0 }));
    // First fetch fails, retry fetch succeeds
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: true, status: 200 });

    // findUnique for subscription lookup inside scheduleRetry
    vi.mocked(prisma.aiWebhookSubscription.findUnique).mockResolvedValue(makeSub());

    // Trigger initial dispatch (which internally calls scheduleRetry via setTimeout)
    await dispatchWebhookEvent('budget_exceeded', { agentId: 'agent-1' });

    // Advance timer past the first retry delay (10s)
    await vi.runAllTimersAsync();

    // Assert: subscription was looked up and delivery re-attempted
    expect(prisma.aiWebhookSubscription.findUnique).toHaveBeenCalledWith({
      where: { id: 'sub-1' },
    });
    // fetch was called twice: initial attempt + retry
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('marks delivery as exhausted when subscription is inactive during scheduled retry', async () => {
    // Arrange: first attempt fails, subscription deactivated before retry fires
    vi.mocked(prisma.aiWebhookSubscription.findMany).mockResolvedValue([makeSub()] as never);
    vi.mocked(prisma.aiWebhookDelivery.findUnique).mockResolvedValue(makeDelivery({ attempts: 0 }));
    mockFetch.mockResolvedValue({ ok: false, status: 503 });

    // Subscription is inactive when the timer fires
    vi.mocked(prisma.aiWebhookSubscription.findUnique).mockResolvedValue(
      makeSub({ isActive: false })
    );

    await dispatchWebhookEvent('budget_exceeded', { agentId: 'agent-1' });

    // Advance timer to fire the scheduled retry
    await vi.runAllTimersAsync();

    // Assert: delivery marked as exhausted because subscription is inactive
    expect(prisma.aiWebhookDelivery.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'exhausted', nextRetryAt: null }),
      })
    );
  });

  it('marks delivery as exhausted when subscription is null during scheduled retry', async () => {
    // Arrange: subscription was deleted before retry fires
    vi.mocked(prisma.aiWebhookSubscription.findMany).mockResolvedValue([makeSub()] as never);
    vi.mocked(prisma.aiWebhookDelivery.findUnique).mockResolvedValue(makeDelivery({ attempts: 0 }));
    mockFetch.mockResolvedValue({ ok: false, status: 503 });

    // Subscription no longer exists
    vi.mocked(prisma.aiWebhookSubscription.findUnique).mockResolvedValue(null);

    await dispatchWebhookEvent('budget_exceeded', { agentId: 'agent-1' });
    await vi.runAllTimersAsync();

    // Assert: delivery marked as exhausted
    expect(prisma.aiWebhookDelivery.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'exhausted', nextRetryAt: null }),
      })
    );
  });

  it('logs error and does not throw when scheduled retry throws unexpectedly', async () => {
    // Arrange: first attempt fails, then subscription lookup throws
    vi.mocked(prisma.aiWebhookSubscription.findMany).mockResolvedValue([makeSub()] as never);
    vi.mocked(prisma.aiWebhookDelivery.findUnique).mockResolvedValue(makeDelivery({ attempts: 0 }));
    mockFetch.mockResolvedValue({ ok: false, status: 503 });

    // Subscription lookup inside scheduleRetry throws
    vi.mocked(prisma.aiWebhookSubscription.findUnique).mockRejectedValue(
      new Error('DB connection lost')
    );

    await dispatchWebhookEvent('budget_exceeded', { agentId: 'agent-1' });
    await vi.runAllTimersAsync();

    // Assert: error is logged, process doesn't crash
    expect(logger.error).toHaveBeenCalledWith(
      'Webhook scheduled retry error',
      expect.objectContaining({ error: 'DB connection lost' })
    );
  });
});

// ─── Email-channel delivery ─────────────────────────────────────────────────

describe('email-channel delivery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.aiWebhookDelivery.create).mockResolvedValue(makeDelivery());
    vi.mocked(prisma.aiWebhookDelivery.update).mockResolvedValue(makeDelivery());
    vi.mocked(prisma.aiWebhookDelivery.findUnique).mockResolvedValue(makeDelivery());
    mockResendSend.mockResolvedValue({ data: { id: 'resend_msg_id' }, error: null });
  });

  it('routes email-channel subscriptions to Resend, not fetch', async () => {
    vi.mocked(prisma.aiWebhookSubscription.findMany).mockResolvedValue([makeEmailSub()] as never);

    await dispatchWebhookEvent('agent_updated', { agentName: 'Support Bot' });

    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockResendSend).toHaveBeenCalledWith(
      expect.objectContaining({
        from: 'Sunrise <noreply@example.com>',
        to: 'alerts@example.com',
        // Subject is built from the friendly event title + an identifier
        // in the payload — "Support Bot" is the agentName here.
        subject: expect.stringContaining('Agent updated'),
        html: expect.stringContaining('rendered'),
      })
    );
  });

  it('marks email delivery as delivered when Resend returns no error', async () => {
    vi.mocked(prisma.aiWebhookSubscription.findMany).mockResolvedValue([makeEmailSub()] as never);

    await dispatchWebhookEvent('workflow_failed', { error: 'step exploded' });

    expect(prisma.aiWebhookDelivery.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'delivered',
          lastError: null,
        }),
      })
    );
  });

  it('marks email delivery as failed when Resend returns an error', async () => {
    vi.mocked(prisma.aiWebhookSubscription.findMany).mockResolvedValue([makeEmailSub()] as never);
    mockResendSend.mockResolvedValue({ data: null, error: { message: 'Invalid recipient' } });

    await dispatchWebhookEvent('workflow_failed', { error: 'step exploded' });

    // First update from `create` sets status pending; second update flips
    // to failed once the Resend error returns.
    const failUpdate = vi
      .mocked(prisma.aiWebhookDelivery.update)
      .mock.calls.find((c) => (c[0]?.data as Record<string, unknown>)?.status === 'failed');
    expect(failUpdate).toBeDefined();
    expect((failUpdate?.[0]?.data as Record<string, unknown>).lastError).toBe('Invalid recipient');
  });

  it('marks email exhausted when email is not configured (RESEND_API_KEY missing)', async () => {
    const { isEmailEnabled } = await import('@/lib/email/client');
    vi.mocked(isEmailEnabled).mockReturnValueOnce(false);
    vi.mocked(prisma.aiWebhookSubscription.findMany).mockResolvedValue([makeEmailSub()] as never);

    await dispatchWebhookEvent('workflow_failed', { error: 'step exploded' });

    expect(mockResendSend).not.toHaveBeenCalled();

    // Single update — terminal failure marks the row exhausted with the
    // diagnostic error and no retry scheduled. Regression guard ensures
    // it's never overwritten to 'delivered' by a later write.
    const updateCalls = vi.mocked(prisma.aiWebhookDelivery.update).mock.calls;
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0][0]).toMatchObject({
      data: expect.objectContaining({
        status: 'exhausted',
        lastError: expect.stringContaining('Email is not configured'),
        nextRetryAt: null,
      }),
    });
    expect(updateCalls.every((c) => c[0]?.data?.status !== 'delivered')).toBe(true);
  });

  it('marks email delivery exhausted when subscription has no emailAddress (terminal)', async () => {
    // Defensive branch: row was created as email channel but its destination
    // is null. Treated as terminal — retrying won't conjure an address.
    vi.mocked(prisma.aiWebhookSubscription.findMany).mockResolvedValue([
      makeEmailSub({ emailAddress: null }),
    ] as never);
    vi.mocked(prisma.aiWebhookDelivery.findUnique).mockResolvedValue(makeDelivery({ attempts: 0 }));

    await dispatchWebhookEvent('workflow_failed', {});

    expect(mockResendSend).not.toHaveBeenCalled();
    const exhaustedUpdate = vi
      .mocked(prisma.aiWebhookDelivery.update)
      .mock.calls.find((c) => (c[0]?.data as Record<string, unknown>)?.status === 'exhausted');
    expect(exhaustedUpdate).toBeDefined();
    expect((exhaustedUpdate?.[0]?.data as Record<string, unknown>).lastError).toBe(
      'Email subscription has no destination address'
    );
    // No 'delivered' overwrite should ever happen on a terminal failure.
    expect(
      vi
        .mocked(prisma.aiWebhookDelivery.update)
        .mock.calls.every((c) => c[0]?.data?.status !== 'delivered')
    ).toBe(true);
  });

  it('marks email delivery failed when getResendClient returns null', async () => {
    // isEmailEnabled returns true (env says configured) but the client
    // initialiser still returns null — surface the failure cleanly so the
    // retry policy can decide what to do.
    const { getResendClient } = await import('@/lib/email/client');
    vi.mocked(getResendClient).mockReturnValueOnce(null);
    vi.mocked(prisma.aiWebhookSubscription.findMany).mockResolvedValue([makeEmailSub()] as never);
    vi.mocked(prisma.aiWebhookDelivery.findUnique).mockResolvedValue(makeDelivery({ attempts: 0 }));

    await dispatchWebhookEvent('workflow_failed', {});

    expect(mockResendSend).not.toHaveBeenCalled();
    const failUpdate = vi
      .mocked(prisma.aiWebhookDelivery.update)
      .mock.calls.find((c) => (c[0]?.data as Record<string, unknown>)?.status === 'failed');
    expect(failUpdate).toBeDefined();
    expect((failUpdate?.[0]?.data as Record<string, unknown>).lastError).toBe(
      'Resend client unavailable'
    );
  });

  it('marks email delivery failed when render() throws', async () => {
    const { render } = await import('@react-email/render');
    vi.mocked(render).mockRejectedValueOnce(new Error('template blew up'));
    vi.mocked(prisma.aiWebhookSubscription.findMany).mockResolvedValue([makeEmailSub()] as never);
    vi.mocked(prisma.aiWebhookDelivery.findUnique).mockResolvedValue(makeDelivery({ attempts: 0 }));

    await dispatchWebhookEvent('workflow_failed', {});

    const failUpdate = vi
      .mocked(prisma.aiWebhookDelivery.update)
      .mock.calls.find((c) => (c[0]?.data as Record<string, unknown>)?.status === 'failed');
    expect(failUpdate).toBeDefined();
    expect((failUpdate?.[0]?.data as Record<string, unknown>).lastError).toBe('template blew up');
  });

  it('marks email delivery failed with fallback message when Resend error has no message', async () => {
    mockResendSend.mockResolvedValue({ data: null, error: {} });
    vi.mocked(prisma.aiWebhookSubscription.findMany).mockResolvedValue([makeEmailSub()] as never);
    vi.mocked(prisma.aiWebhookDelivery.findUnique).mockResolvedValue(makeDelivery({ attempts: 0 }));

    await dispatchWebhookEvent('workflow_failed', {});

    const failUpdate = vi
      .mocked(prisma.aiWebhookDelivery.update)
      .mock.calls.find((c) => (c[0]?.data as Record<string, unknown>)?.status === 'failed');
    expect((failUpdate?.[0]?.data as Record<string, unknown>).lastError).toBe(
      'Resend rejected the email'
    );
  });

  it('subject line uses workflowName when present (and no agentName)', async () => {
    vi.mocked(prisma.aiWebhookSubscription.findMany).mockResolvedValue([makeEmailSub()] as never);

    await dispatchWebhookEvent('workflow_failed', { workflowName: 'Nightly Refresh' });

    expect(mockResendSend).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: expect.stringContaining('Workflow failed · Nightly Refresh'),
      })
    );
  });

  it('subject line uses providerSlug when present (and no agentName/workflowName)', async () => {
    vi.mocked(prisma.aiWebhookSubscription.findMany).mockResolvedValue([makeEmailSub()] as never);

    await dispatchWebhookEvent('circuit_breaker_opened', { providerSlug: 'anthropic' });

    expect(mockResendSend).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: expect.stringContaining('Provider circuit breaker opened · anthropic'),
      })
    );
  });

  it('subject line falls back to "Sunrise event: <type>" for unknown event types', async () => {
    vi.mocked(prisma.aiWebhookSubscription.findMany).mockResolvedValue([
      makeEmailSub({ events: ['custom_unknown'] }),
    ] as never);

    await dispatchWebhookEvent('custom_unknown', {});

    expect(mockResendSend).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: '[Sunrise] Sunrise event: custom_unknown',
      })
    );
  });
});

// ─── attemptWebhookDelivery edge cases ──────────────────────────────────────

describe('webhook-channel delivery edge cases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.aiWebhookDelivery.create).mockResolvedValue(makeDelivery());
    vi.mocked(prisma.aiWebhookDelivery.update).mockResolvedValue(makeDelivery());
    vi.mocked(prisma.aiWebhookDelivery.findUnique).mockResolvedValue(makeDelivery({ attempts: 0 }));
  });

  it('marks delivery exhausted when webhook subscription has a secret but no URL (terminal)', async () => {
    // Defensive: schema allows url=null only for email channel, but a
    // misconfigured row should still fail cleanly rather than crashing.
    // Treated as terminal — retrying won't conjure a URL.
    vi.mocked(prisma.aiWebhookSubscription.findMany).mockResolvedValue([
      makeSub({ url: null }),
    ] as never);

    await dispatchWebhookEvent('budget_exceeded', {});

    expect(mockFetch).not.toHaveBeenCalled();
    const exhaustedUpdate = vi
      .mocked(prisma.aiWebhookDelivery.update)
      .mock.calls.find((c) => (c[0]?.data as Record<string, unknown>)?.status === 'exhausted');
    expect(exhaustedUpdate).toBeDefined();
    expect((exhaustedUpdate?.[0]?.data as Record<string, unknown>).lastError).toBe(
      'Webhook subscription has no URL'
    );
    expect(
      vi
        .mocked(prisma.aiWebhookDelivery.update)
        .mock.calls.every((c) => c[0]?.data?.status !== 'delivered')
    ).toBe(true);
  });
});

// ─── Entity-scoped matching ──────────────────────────────────────────────────
//
// Verifies the dimension-specific filter rule introduced alongside the
// `agentIds` / `workflowIds` columns. See
// lib/orchestration/webhooks/event-entity-keys.ts for the contract.
describe('dispatchWebhookEvent: entity-scoped matching', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue({ ok: true, status: 200 });
    vi.mocked(prisma.aiWebhookDelivery.create).mockResolvedValue(makeDelivery());
    vi.mocked(prisma.aiWebhookDelivery.update).mockResolvedValue(makeDelivery());
    vi.mocked(prisma.aiWebhookDelivery.findUnique).mockResolvedValue(makeDelivery());
  });

  it('delivers to a sub with empty filters (backward compat)', async () => {
    vi.mocked(prisma.aiWebhookSubscription.findMany).mockResolvedValue([makeSub()] as never);

    await dispatchWebhookEvent('budget_exceeded', { agentId: 'agent-X' });

    expect(prisma.aiWebhookDelivery.create).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('delivers when payload agentId matches the agentIds filter', async () => {
    vi.mocked(prisma.aiWebhookSubscription.findMany).mockResolvedValue([
      makeSub({ agentIds: ['agent-X', 'agent-Y'] }),
    ] as never);

    await dispatchWebhookEvent('budget_exceeded', { agentId: 'agent-X' });

    expect(prisma.aiWebhookDelivery.create).toHaveBeenCalledTimes(1);
  });

  it('skips a sub when payload agentId is NOT in the agentIds filter', async () => {
    vi.mocked(prisma.aiWebhookSubscription.findMany).mockResolvedValue([
      makeSub({ agentIds: ['agent-X'] }),
    ] as never);

    await dispatchWebhookEvent('budget_exceeded', { agentId: 'agent-Z' });

    expect(prisma.aiWebhookDelivery.create).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('delivers a workflow-typed event regardless of an agent-only filter (dimension-specific)', async () => {
    // The sub cares about agents, but workflow_failed is a workflow event.
    // Agent filter doesn't apply → event still fires.
    vi.mocked(prisma.aiWebhookSubscription.findMany).mockResolvedValue([
      makeSub({ agentIds: ['agent-X'], events: ['workflow_failed'] }),
    ] as never);

    await dispatchWebhookEvent('workflow_failed', { workflowId: 'wf-1', error: 'boom' });

    expect(prisma.aiWebhookDelivery.create).toHaveBeenCalledTimes(1);
  });

  it('delivers an agent-typed event regardless of a workflow-only filter', async () => {
    vi.mocked(prisma.aiWebhookSubscription.findMany).mockResolvedValue([
      makeSub({ workflowIds: ['wf-1'], events: ['budget_exceeded'] }),
    ] as never);

    await dispatchWebhookEvent('budget_exceeded', { agentId: 'agent-X' });

    expect(prisma.aiWebhookDelivery.create).toHaveBeenCalledTimes(1);
  });

  it('delivers when both dimensions match', async () => {
    vi.mocked(prisma.aiWebhookSubscription.findMany).mockResolvedValue([
      makeSub({
        agentIds: ['agent-X'],
        workflowIds: ['wf-1'],
        events: ['budget_exceeded', 'workflow_failed'],
      }),
    ] as never);

    await dispatchWebhookEvent('workflow_failed', { workflowId: 'wf-1', error: 'boom' });
    await dispatchWebhookEvent('budget_exceeded', { agentId: 'agent-X' });

    expect(prisma.aiWebhookDelivery.create).toHaveBeenCalledTimes(2);
  });

  it('fails closed: scoped sub does NOT match when payload is missing the expected ID', async () => {
    // Defensive: if an upstream dispatch site forgets to include agentId in
    // a `budget_exceeded` payload, a scoped sub should NOT leak — better
    // to drop the event than send it to the wrong subscriber.
    vi.mocked(prisma.aiWebhookSubscription.findMany).mockResolvedValue([
      makeSub({ agentIds: ['agent-X'] }),
    ] as never);

    await dispatchWebhookEvent('budget_exceeded', {/* missing agentId */});

    expect(prisma.aiWebhookDelivery.create).not.toHaveBeenCalled();
  });

  it('routes only to the matching sub when one sub is scoped and another is global', async () => {
    vi.mocked(prisma.aiWebhookSubscription.findMany).mockResolvedValue([
      makeSub({ id: 'sub-scoped', agentIds: ['agent-X'] }),
      makeSub({ id: 'sub-global' }),
    ] as never);

    await dispatchWebhookEvent('budget_exceeded', { agentId: 'agent-Y' });

    // Only the global sub gets a delivery; the scoped one is filtered out.
    expect(prisma.aiWebhookDelivery.create).toHaveBeenCalledTimes(1);
    const createdSubIds = vi
      .mocked(prisma.aiWebhookDelivery.create)
      .mock.calls.map((c) => (c[0]?.data as Record<string, unknown>)?.subscriptionId);
    expect(createdSubIds).toEqual(['sub-global']);
  });
});
