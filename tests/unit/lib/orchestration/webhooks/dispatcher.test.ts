/**
 * Webhook Dispatcher Unit Tests
 *
 * Tests for webhook delivery with HMAC signing, delivery tracking,
 * and retry logic.
 *
 * @see lib/orchestration/webhooks/dispatcher.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// `after()` records what it was handed (t-903); the real one throws outside a
// request scope.
const mockAfter = vi.hoisted(() => vi.fn());
vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/server')>()),
  after: mockAfter,
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiWebhookSubscription: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
    },
    aiWebhookDelivery: {
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      updateManyAndReturn: vi.fn(),
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
// A pass-through spy, so a test can read the props the email was rendered with.
vi.mock('@/emails/event-notification', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/emails/event-notification')>();
  return { ...actual, default: vi.fn(actual.default) };
});
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
import { DISPATCH_TIMEOUT_MS } from '@/lib/orchestration/webhooks/not-retried';
import { describeDestination } from '@/lib/orchestration/webhooks/destination';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeSub(overrides: Record<string, unknown> = {}) {
  return {
    orgId: null,
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
    orgId: null,
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
    orgId: null,
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
    destination: null,
    destinationFingerprint: null,
    previousDestinations: null,
    stoppedByErasure: false,
    sendGeneration: 0,
    ...overrides,
  };
}

/**
 * Default for a claim or a reset: it matches, and returns the row as written.
 * The row carries the fixture payload; a test that needs the claim or reset to
 * return a different payload supplies its own `mockResolvedValueOnce`.
 */
function returnTheWrittenRow(): void {
  vi.mocked(prisma.aiWebhookDelivery.updateManyAndReturn).mockImplementation((async (args: {
    where: { id: string };
    data: { status?: string; nextRetryAt?: Date | null };
  }) => [
    makeDelivery({
      id: args.where.id,
      status: args.data.status ?? 'failed',
      nextRetryAt: args.data.nextRetryAt ?? null,
    }),
  ]) as never);
}

/** Where an outcome write must match: only a row still waiting to send (t-793). */
const AWAITING = { id: 'del-1', status: { in: ['pending', 'failed'] } };

/**
 * The row an in-process retry timer re-reads: `failed`, with the `nextRetryAt`
 * the failed attempt wrote when it armed the timer. Read from the latest
 * outcome write rather than hard-coded, because the code computes it from the
 * clock. Before any outcome is written there is no value yet, so it is null.
 */
function armedRow(overrides: Record<string, unknown> = {}) {
  const calls = vi.mocked(prisma.aiWebhookDelivery.updateMany).mock.calls;
  const written = (calls.at(-1)?.[0] as { data?: { nextRetryAt?: unknown } } | undefined)?.data
    ?.nextRetryAt;
  return makeDelivery({
    status: 'failed',
    nextRetryAt: written instanceof Date ? written : null,
    ...overrides,
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

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

describe('dispatchWebhookEvent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue({ ok: true, status: 200 });
    vi.mocked(prisma.aiWebhookDelivery.create).mockResolvedValue(makeDelivery());
    vi.mocked(prisma.aiWebhookDelivery.update).mockResolvedValue(makeDelivery());
    vi.mocked(prisma.aiWebhookDelivery.updateMany).mockResolvedValue({ count: 1 });
    returnTheWrittenRow();
    vi.mocked(prisma.aiWebhookDelivery.findUnique).mockResolvedValue(makeDelivery());
  });

  it('keeps a dispatch nobody awaits alive until its delivery settles (t-903)', async () => {
    vi.mocked(prisma.aiWebhookSubscription.findMany).mockResolvedValue([makeSub()] as never);
    let answer!: (value: unknown) => void;
    mockFetch.mockReturnValueOnce(
      new Promise((resolve) => {
        answer = resolve;
      })
    );

    void dispatchWebhookEvent('budget_exceeded', { agentId: 'agent-1' });

    expect(mockAfter).toHaveBeenCalledTimes(1);
    const handed = mockAfter.mock.calls[0]?.[0] as Promise<unknown>;
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled());
    expect(await settledYet(handed)).toBe(false);

    answer({ ok: true, status: 200 });
    await handed;
    expect(prisma.aiWebhookDelivery.create).toHaveBeenCalledTimes(1);
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

  describe('destination check at the point of use', () => {
    // Deliberately here rather than on the write paths. Guarding writes meant
    // guarding a growing list of transitions — create, update, import, activate,
    // set-a-secret, flip-the-channel — and two successive cuts of that list were
    // each walked around by the one they missed. A check where the request is
    // actually made cannot be reached around, whatever sequence produced the row.
    it.each([
      ['IMDS', 'http://169.254.169.254/latest/meta-data/'],
      ['ECS task metadata', 'http://169.254.170.2/v2/credentials'],
      ['RFC1918 private', 'http://10.0.0.7:8500/v1/kv/x'],
      ['loopback', 'http://127.0.0.1:8080/hook'],
    ])('does not POST to %s, whatever wrote the row', async (_label, url) => {
      vi.mocked(prisma.aiWebhookSubscription.findMany).mockResolvedValue([
        makeSub({ url }),
      ] as never);

      await dispatchWebhookEvent('budget_exceeded', { agentId: 'agent-1' });

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('CONTROL — the identical subscription DOES deliver to a public destination', async () => {
      // Without this, the four refusals above would also pass if dispatch were
      // broken for a reason having nothing to do with the destination.
      vi.mocked(prisma.aiWebhookSubscription.findMany).mockResolvedValue([makeSub()] as never);

      await dispatchWebhookEvent('budget_exceeded', { agentId: 'agent-1' });

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  it('includes X-Webhook-Signature header with HMAC-SHA256', async () => {
    vi.mocked(prisma.aiWebhookSubscription.findMany).mockResolvedValue([makeSub()] as never);

    await dispatchWebhookEvent('budget_exceeded', { agentId: 'agent-1' });

    const headers = mockFetch.mock.calls[0][1].headers as Record<string, string>;
    expect(headers['X-Webhook-Signature']).toBeDefined();
    expect(typeof headers['X-Webhook-Signature']).toBe('string');
    expect(headers['X-Webhook-Signature'].length).toBe(64);
  });

  // #534: `sub.url` is validated by `isSafeProviderUrl` in the Zod refine at
  // create/update and never again here. `fetch` defaults to redirect: 'follow',
  // so a redirect would POST the payload AND the signature header above to an
  // unvalidated second target — reaching private space the guard would reject.
  it('refuses to follow redirects, so a signed payload cannot be forwarded off-target', async () => {
    vi.mocked(prisma.aiWebhookSubscription.findMany).mockResolvedValue([makeSub()] as never);

    await dispatchWebhookEvent('budget_exceeded', { agentId: 'agent-1' });

    expect(mockFetch.mock.calls[0][1].redirect).toBe('error');
  });

  // undici puts the reason on `cause` and leaves `message` as a bare
  // "fetch failed", so a refused redirect reads identically to a DNS failure.
  it('records the underlying cause of a failed delivery', async () => {
    vi.mocked(prisma.aiWebhookSubscription.findMany).mockResolvedValue([makeSub()] as never);
    mockFetch.mockRejectedValueOnce(
      Object.assign(new TypeError('fetch failed'), { cause: new Error('unexpected redirect') })
    );

    await dispatchWebhookEvent('budget_exceeded', { agentId: 'agent-1' });

    // `create` records the pending row; the outcome lands on `updateMany.lastError`.
    const errors = vi
      .mocked(prisma.aiWebhookDelivery.updateMany)
      .mock.calls.map((c) => (c[0] as { data?: { lastError?: string } })?.data?.lastError)
      .filter(Boolean);
    expect(errors.some((e) => e?.includes('unexpected redirect'))).toBe(true);
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

    expect(prisma.aiWebhookDelivery.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: AWAITING,
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

  it('does not log a credential carried in the subscription URL (#953)', async () => {
    const secret = 'AbCdEfGhIjKlMnOpQrStUvWx';
    vi.mocked(prisma.aiWebhookSubscription.findMany).mockResolvedValue([
      makeSub({ url: `https://example.com/services/T0000/B0000/${secret}?token=qs-secret` }),
    ] as never);
    mockFetch.mockResolvedValue({ ok: false, status: 500 });

    await dispatchWebhookEvent('budget_exceeded', { agentId: 'agent-1' });

    expect(logger.warn).toHaveBeenCalledWith(
      'Webhook delivery failed',
      expect.objectContaining({ destination: 'https://example.com/services/T0000/B0000/[param]' })
    );
    const logged = JSON.stringify(vi.mocked(logger.warn).mock.calls);
    expect(logged).not.toContain(secret);
    expect(logged).not.toContain('qs-secret');
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
    const updateCalls = vi.mocked(prisma.aiWebhookDelivery.updateMany).mock.calls;
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0][0]).toMatchObject({
      where: AWAITING,
      data: expect.objectContaining({
        status: 'exhausted',
        lastError: 'Subscription has no signing secret',
        nextRetryAt: null,
      }),
    });
    // Regression guard: no later overwrite to 'delivered' that would
    // mask a misconfigured subscription as a successful send.
    expect(updateCalls.every((c) => c[0]?.data?.status !== 'delivered')).toBe(true);
    // The outcome is not a plain `update`: that would not guard against a settled row.
    expect(prisma.aiWebhookDelivery.update).not.toHaveBeenCalled();

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
    vi.mocked(prisma.aiWebhookDelivery.updateMany).mockResolvedValue({ count: 1 });
    returnTheWrittenRow();
    vi.mocked(prisma.aiWebhookDelivery.findUnique).mockResolvedValue(makeDelivery());
  });

  it('returns false when delivery not found', async () => {
    vi.mocked(prisma.aiWebhookDelivery.findUnique).mockResolvedValue(null);

    const result = await retryDelivery('nonexistent');

    expect(result).toBe(false);
  });

  it('keeps the attempt alive past the retry route’s response (t-903)', async () => {
    vi.mocked(prisma.aiWebhookDelivery.findUnique).mockResolvedValueOnce({
      ...makeDelivery({ status: 'exhausted', attempts: 3 }),
      subscription: makeSub(),
    } as never);
    vi.mocked(prisma.aiWebhookDelivery.updateManyAndReturn).mockResolvedValueOnce([
      makeDelivery({ status: 'pending', attempts: 0 }),
    ] as never);
    let answer!: (value: unknown) => void;
    mockFetch.mockReturnValueOnce(
      new Promise((resolve) => {
        answer = resolve;
      })
    );

    expect(await retryDelivery('del-1')).toBe(true);

    expect(mockAfter).toHaveBeenCalledTimes(1);
    const handed = mockAfter.mock.calls[0]?.[0] as Promise<unknown>;
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled());
    expect(await settledYet(handed)).toBe(false);

    answer({ ok: true, status: 200 });
    await handed;
  });

  it('resets delivery state and re-attempts', async () => {
    // The read: the exhausted row. The reset returns the row it wrote.
    vi.mocked(prisma.aiWebhookDelivery.findUnique).mockResolvedValueOnce({
      ...makeDelivery({ status: 'exhausted', attempts: 3 }),
      subscription: makeSub(),
    } as never);
    vi.mocked(prisma.aiWebhookDelivery.updateManyAndReturn).mockResolvedValueOnce([
      makeDelivery({ status: 'pending', attempts: 0 }),
    ] as never);

    const result = await retryDelivery('del-1');

    // test-review:accept tobe_true — boolean return from retryDelivery; structural assertion on retry outcome
    expect(result).toBe(true);
    // The reset matches the row as it was read, so a concurrent change is not undone.
    expect(prisma.aiWebhookDelivery.updateManyAndReturn).toHaveBeenCalledWith(
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
        }),
      })
    );
  });

  it('default mode returns before the outbound HTTP resolves (fire-and-forget)', async () => {
    // Single-row retry path: caller shouldn't have to wait for the receiver.
    vi.mocked(prisma.aiWebhookDelivery.findUnique).mockResolvedValueOnce({
      ...makeDelivery({ status: 'exhausted', attempts: 3 }),
      subscription: makeSub(),
    } as never);
    vi.mocked(prisma.aiWebhookDelivery.updateManyAndReturn).mockResolvedValueOnce([
      makeDelivery({ status: 'pending', attempts: 0 }),
    ] as never);

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
    vi.mocked(prisma.aiWebhookDelivery.findUnique).mockResolvedValueOnce({
      ...makeDelivery({ status: 'exhausted', attempts: 3 }),
      subscription: makeSub(),
    } as never);
    vi.mocked(prisma.aiWebhookDelivery.updateManyAndReturn).mockResolvedValueOnce([
      makeDelivery({ status: 'pending', attempts: 0 }),
    ] as never);

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
    vi.mocked(prisma.aiWebhookDelivery.updateMany).mockResolvedValue({ count: 1 });
    returnTheWrittenRow();
    vi.mocked(prisma.aiWebhookDelivery.findUnique).mockResolvedValue(makeDelivery());
  });

  it('returns 0 when no pending retries', async () => {
    vi.mocked(prisma.aiWebhookDelivery.findMany).mockResolvedValue([]);

    const count = await processPendingRetries();

    expect(count).toBe(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('processes pending retries and returns count', async () => {
    const due = new Date(Date.now() - 1_000);
    vi.mocked(prisma.aiWebhookDelivery.findMany).mockResolvedValue([
      {
        ...makeDelivery({ id: 'del-1', status: 'failed', attempts: 1, nextRetryAt: due }),
        subscription: makeSub(),
      },
      {
        ...makeDelivery({ id: 'del-2', status: 'failed', attempts: 2, nextRetryAt: due }),
        subscription: makeSub({ id: 'sub-2' }),
      },
    ] as never);

    const count = await processPendingRetries();

    expect(count).toBe(2);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    // Each row is claimed before it is sent, so a timer firing for it now
    // does not send it as well (t-793).
    for (const id of ['del-1', 'del-2']) {
      expect(prisma.aiWebhookDelivery.updateManyAndReturn).toHaveBeenCalledWith({
        where: { id, status: 'failed', nextRetryAt: due },
        data: { nextRetryAt: expect.any(Date) },
      });
    }
  });

  it('sends nothing for a row a timer claimed first (t-793)', async () => {
    const due = new Date(Date.now() - 1_000);
    vi.mocked(prisma.aiWebhookDelivery.findMany).mockResolvedValue([
      {
        ...makeDelivery({ id: 'del-1', status: 'failed', attempts: 1, nextRetryAt: due }),
        subscription: makeSub(),
      },
    ] as never);
    vi.mocked(prisma.aiWebhookDelivery.updateManyAndReturn).mockResolvedValueOnce([]);

    await processPendingRetries();

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('sends the payload the claim returned, not the copy the tick read before claiming', async () => {
    // An erasure redacts a payload between the tick's read and its claim: the
    // read still carries the PII, the row the claim returns does not.
    const due = new Date(Date.now() - 1_000);
    vi.mocked(prisma.aiWebhookDelivery.findMany).mockResolvedValue([
      {
        ...makeDelivery({
          id: 'del-1',
          status: 'failed',
          attempts: 1,
          nextRetryAt: due,
          payload: { event: 'budget_exceeded', data: { note: 'pre-claim-copy' } },
        }),
        subscription: makeSub(),
      },
    ] as never);
    vi.mocked(prisma.aiWebhookDelivery.updateManyAndReturn).mockResolvedValueOnce([
      makeDelivery({
        status: 'failed',
        attempts: 1,
        payload: { event: 'budget_exceeded', data: { note: 'claimed-copy' } },
      }),
    ] as never);

    await processPendingRetries();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const body = String((mockFetch.mock.calls[0][1] as { body: string }).body);
    expect(body).toContain('claimed-copy');
    expect(body).not.toContain('pre-claim-copy');
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
    vi.mocked(prisma.aiWebhookDelivery.updateMany).mockResolvedValue({ count: 1 });
    returnTheWrittenRow();
  });

  it('marks delivery as exhausted when attempts reach MAX_ATTEMPTS', async () => {
    // Arrange: delivery already at attempt 2 (next attempt = 3 = MAX)
    vi.mocked(prisma.aiWebhookSubscription.findMany).mockResolvedValue([makeSub()] as never);
    vi.mocked(prisma.aiWebhookDelivery.findUnique).mockResolvedValue(makeDelivery({ attempts: 2 }));
    mockFetch.mockResolvedValue({ ok: false, status: 500 });

    await dispatchWebhookEvent('budget_exceeded', { agentId: 'agent-1' });

    expect(prisma.aiWebhookDelivery.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: AWAITING,
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

    expect(prisma.aiWebhookDelivery.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: AWAITING,
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

    expect(prisma.aiWebhookDelivery.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: AWAITING,
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
    vi.mocked(prisma.aiWebhookDelivery.updateMany).mockResolvedValue({ count: 1 });
    returnTheWrittenRow();
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

    expect(prisma.aiWebhookDelivery.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: AWAITING,
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
      .mocked(prisma.aiWebhookDelivery.updateMany)
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
      .mocked(prisma.aiWebhookDelivery.updateMany)
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
    vi.mocked(prisma.aiWebhookDelivery.updateMany).mockResolvedValue({ count: 1 });
    returnTheWrittenRow();
    vi.mocked(prisma.aiWebhookDelivery.findUnique).mockImplementation((async () =>
      armedRow({ attempts: 0 })) as never);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries delivery after delay when first attempt fails and subscription is still active', async () => {
    // Arrange: first attempt fails (attempts=0 → scheduleRetry fires after delay)
    vi.mocked(prisma.aiWebhookSubscription.findMany).mockResolvedValue([makeSub()] as never);
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
    mockFetch.mockResolvedValue({ ok: false, status: 503 });

    // Subscription is inactive when the timer fires
    vi.mocked(prisma.aiWebhookSubscription.findUnique).mockResolvedValue(
      makeSub({ isActive: false })
    );

    await dispatchWebhookEvent('budget_exceeded', { agentId: 'agent-1' });

    // Advance timer to fire the scheduled retry
    await vi.runAllTimersAsync();

    // Assert: delivery marked as exhausted because subscription is inactive
    // Conditional, so an erasure's mark on a row stopped meanwhile survives (t-793).
    expect(prisma.aiWebhookDelivery.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: AWAITING,
        data: expect.objectContaining({ status: 'exhausted', nextRetryAt: null }),
      })
    );
    expect(prisma.aiWebhookDelivery.update).not.toHaveBeenCalled();
  });

  it('marks delivery as exhausted when subscription is null during scheduled retry', async () => {
    // Arrange: subscription was deleted before retry fires
    vi.mocked(prisma.aiWebhookSubscription.findMany).mockResolvedValue([makeSub()] as never);
    mockFetch.mockResolvedValue({ ok: false, status: 503 });

    // Subscription no longer exists
    vi.mocked(prisma.aiWebhookSubscription.findUnique).mockResolvedValue(null);

    await dispatchWebhookEvent('budget_exceeded', { agentId: 'agent-1' });
    await vi.runAllTimersAsync();

    // Assert: delivery marked as exhausted
    // Conditional, so an erasure's mark on a row stopped meanwhile survives (t-793).
    expect(prisma.aiWebhookDelivery.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: AWAITING,
        data: expect.objectContaining({ status: 'exhausted', nextRetryAt: null }),
      })
    );
    expect(prisma.aiWebhookDelivery.update).not.toHaveBeenCalled();
  });

  it.each(['exhausted', 'delivered'])(
    'does not send or write when the delivery was settled as %s while the timer waited',
    async (settled) => {
      // Arrange: first attempt fails and arms the timer; the subscription is still active
      let status = 'failed';
      vi.mocked(prisma.aiWebhookSubscription.findMany).mockResolvedValue([makeSub()] as never);
      vi.mocked(prisma.aiWebhookSubscription.findUnique).mockResolvedValue(makeSub());
      vi.mocked(prisma.aiWebhookDelivery.findUnique).mockImplementation((async () =>
        armedRow({ attempts: 0, status })) as never);
      mockFetch.mockResolvedValue({ ok: false, status: 503 });

      await dispatchWebhookEvent('budget_exceeded', { agentId: 'agent-1' });
      const fetchesBefore = mockFetch.mock.calls.length;
      const updatesBefore = vi.mocked(prisma.aiWebhookDelivery.update).mock.calls.length;
      const outcomeWritesBefore = vi.mocked(prisma.aiWebhookDelivery.updateMany).mock.calls.length;
      expect(fetchesBefore).toBe(1);

      // Act: an erasure (or a manual retry) settles the row, then the timer fires
      status = settled;
      await vi.advanceTimersByTimeAsync(10_000);

      // Assert: the timer re-read the row and stopped
      expect(prisma.aiWebhookSubscription.findUnique).toHaveBeenCalled();
      expect(mockFetch).toHaveBeenCalledTimes(fetchesBefore);
      expect(prisma.aiWebhookDelivery.update).toHaveBeenCalledTimes(updatesBefore);
      expect(prisma.aiWebhookDelivery.updateMany).toHaveBeenCalledTimes(outcomeWritesBefore);
    }
  );

  it('still retries when the delivery is marked failed at timer time', async () => {
    vi.mocked(prisma.aiWebhookSubscription.findMany).mockResolvedValue([makeSub()] as never);
    vi.mocked(prisma.aiWebhookSubscription.findUnique).mockResolvedValue(makeSub());
    vi.mocked(prisma.aiWebhookDelivery.findUnique).mockImplementation((async () =>
      armedRow({ attempts: 0, status: 'failed' })) as never);
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: true, status: 200 });

    await dispatchWebhookEvent('budget_exceeded', { agentId: 'agent-1' });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('logs error and does not throw when scheduled retry throws unexpectedly', async () => {
    // Arrange: first attempt fails, then subscription lookup throws
    vi.mocked(prisma.aiWebhookSubscription.findMany).mockResolvedValue([makeSub()] as never);
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

// ─── An erasure's stop is not undone (t-793) ───────────────────────────────

describe('an erasure’s stop on a delivery (t-793)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.mocked(prisma.aiWebhookSubscription.findMany).mockResolvedValue([makeSub()] as never);
    vi.mocked(prisma.aiWebhookSubscription.findUnique).mockResolvedValue(makeSub());
    vi.mocked(prisma.aiWebhookDelivery.create).mockResolvedValue(makeDelivery());
    vi.mocked(prisma.aiWebhookDelivery.update).mockResolvedValue(makeDelivery());
    vi.mocked(prisma.aiWebhookDelivery.updateMany).mockResolvedValue({ count: 1 });
    returnTheWrittenRow();
    vi.mocked(prisma.aiWebhookDelivery.findUnique).mockResolvedValue(makeDelivery());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('an attempt in flight when the erasure commits', () => {
    it('leaves a stopped row stopped when the send succeeds, and says so', async () => {
      mockFetch.mockResolvedValue({ ok: true, status: 200 });
      // The erasure stopped the row while the POST was out: the conditional
      // write matches nothing.
      vi.mocked(prisma.aiWebhookDelivery.updateMany).mockResolvedValue({ count: 0 });

      await dispatchWebhookEvent('budget_exceeded', { agentId: 'agent-1' });

      expect(prisma.aiWebhookDelivery.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: AWAITING,
          data: expect.objectContaining({ status: 'delivered' }),
        })
      );
      expect(prisma.aiWebhookDelivery.update).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith(
        'Webhook delivery outcome not recorded: the row was settled while in flight',
        { deliveryId: 'del-1', outcome: 'delivered' }
      );
    });

    it('leaves a stopped row stopped and arms no timer when the send fails', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 503 });
      vi.mocked(prisma.aiWebhookDelivery.findUnique).mockResolvedValue(
        makeDelivery({
          status: 'exhausted',
          lastError: 'Not retried: subject erased',
        })
      );

      // The stopped row matches no awaiting status
      vi.mocked(prisma.aiWebhookDelivery.updateMany)
        .mockResolvedValueOnce({ count: 0 })
        .mockResolvedValueOnce({ count: 1 });

      await dispatchWebhookEvent('budget_exceeded', { agentId: 'agent-1' });
      await vi.advanceTimersByTimeAsync(10 * 60_000);

      expect(prisma.aiWebhookDelivery.update).not.toHaveBeenCalled();
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(prisma.aiWebhookSubscription.findUnique).not.toHaveBeenCalled();
      // The attempt that went out is still recorded, without touching the
      // status, the erasure's mark or the destination.
      expect(prisma.aiWebhookDelivery.updateMany).toHaveBeenLastCalledWith({
        where: { id: 'del-1', status: { not: 'delivered' } },
        data: {
          attempts: { increment: 1 },
          lastAttemptAt: expect.any(Date),
          lastResponseCode: 503,
        },
      });
    });

    it('records an attempt that had no status code without a lastResponseCode, so the settled row’s code is not nulled', async () => {
      // A network failure: no response, so no status code.
      mockFetch.mockRejectedValue(new Error('ECONNRESET'));
      vi.mocked(prisma.aiWebhookDelivery.findUnique).mockResolvedValue(
        makeDelivery({ status: 'exhausted', lastError: 'Not retried: subject erased' })
      );
      vi.mocked(prisma.aiWebhookDelivery.updateMany)
        .mockResolvedValueOnce({ count: 0 })
        .mockResolvedValueOnce({ count: 1 });

      await dispatchWebhookEvent('budget_exceeded', { agentId: 'agent-1' });
      await vi.advanceTimersByTimeAsync(10 * 60_000);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(prisma.aiWebhookDelivery.updateMany).toHaveBeenLastCalledWith({
        where: { id: 'del-1', status: { not: 'delivered' } },
        data: {
          attempts: { increment: 1 },
          lastAttemptAt: expect.any(Date),
        },
      });
    });

    it('arms no timer when the stop lands between the failure’s read and its write', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 503 });
      // The re-read still sees the row waiting, but the conditional write
      // finds it stopped.
      vi.mocked(prisma.aiWebhookDelivery.findUnique).mockResolvedValue(
        makeDelivery({ status: 'pending' })
      );
      vi.mocked(prisma.aiWebhookDelivery.updateMany).mockResolvedValue({ count: 0 });

      await dispatchWebhookEvent('budget_exceeded', { agentId: 'agent-1' });
      await vi.advanceTimersByTimeAsync(10 * 60_000);

      // The conditional outcome write, then the attempt recorded alone
      expect(prisma.aiWebhookDelivery.updateMany).toHaveBeenCalledTimes(2);
      expect(prisma.aiWebhookDelivery.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: AWAITING,
          data: expect.objectContaining({ status: 'failed' }),
        })
      );
      // The timer would have re-read the subscription and sent again.
      expect(prisma.aiWebhookSubscription.findUnique).not.toHaveBeenCalled();
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(logger.info).toHaveBeenCalledWith(
        'Webhook delivery outcome not recorded: the row was settled while in flight',
        { deliveryId: 'del-1', outcome: 'failed' }
      );
    });
  });

  describe('a manual retry or replay', () => {
    // The stop is the column, not the wording (t-809): a later write that
    // replaced `lastError` does not clear it, and a receiver's error text that
    // happens to end in the same words does not set it.
    it.each([
      'HTTP 503 (not retried: subject erased)',
      'Not retried: recipient erased',
      'HTTP 500 written over the erasure’s wording',
      null,
    ])(
      'refuses a row an erasure stopped, whatever its lastError (%s): nothing reset, nothing sent',
      async (lastError) => {
        mockFetch.mockResolvedValue({ ok: true, status: 200 });
        vi.mocked(prisma.aiWebhookDelivery.findUnique).mockResolvedValue({
          ...makeDelivery({ status: 'exhausted', lastError, stoppedByErasure: true }),
          subscription: makeSub(),
        } as never);

        const result = await retryDelivery('del-1', { awaitDelivery: true });

        expect(result).toBe(false);
        expect(prisma.aiWebhookDelivery.updateMany).not.toHaveBeenCalled();
        expect(prisma.aiWebhookDelivery.update).not.toHaveBeenCalled();
        expect(mockFetch).not.toHaveBeenCalled();
      }
    );

    it('retries a row whose lastError only reads like an erasure’s (t-809)', async () => {
      mockFetch.mockResolvedValue({ ok: true, status: 200 });
      const receiverText = 'HTTP 422 (not retried: subject erased)';
      vi.mocked(prisma.aiWebhookDelivery.findUnique).mockResolvedValue({
        ...makeDelivery({ status: 'exhausted', lastError: receiverText }),
        subscription: makeSub(),
      } as never);
      vi.mocked(prisma.aiWebhookDelivery.updateManyAndReturn).mockResolvedValueOnce([
        makeDelivery({ status: 'pending', attempts: 0 }),
      ] as never);

      const result = await retryDelivery('del-1', { awaitDelivery: true });

      expect(result).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    // Merges the former "row changed between the read and the reset" and "an
    // erasure stopped the row just after the reset": with the reset returning
    // the row it wrote there is no later re-read, so the one real case left is
    // a reset that matches nothing because an erasure (or any writer) changed
    // the row first.
    it('sends nothing when the row changed between the read and the reset, as an erasure does', async () => {
      mockFetch.mockResolvedValue({ ok: true, status: 200 });
      vi.mocked(prisma.aiWebhookDelivery.findUnique).mockResolvedValue({
        ...makeDelivery({ status: 'exhausted', lastError: 'HTTP 503' }),
        subscription: makeSub(),
      } as never);
      vi.mocked(prisma.aiWebhookDelivery.updateManyAndReturn).mockResolvedValue([]);

      const result = await retryDelivery('del-1', { awaitDelivery: true });

      expect(result).toBe(false);
      expect(prisma.aiWebhookDelivery.updateManyAndReturn).toHaveBeenCalledWith(
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
      expect(prisma.aiWebhookDelivery.findUnique).toHaveBeenCalledTimes(1);
      expect(prisma.aiWebhookDelivery.update).not.toHaveBeenCalled();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('sends the payload as it is after the reset, not the copy first read', async () => {
      mockFetch.mockResolvedValue({ ok: true, status: 200 });
      vi.mocked(prisma.aiWebhookDelivery.findUnique).mockResolvedValueOnce({
        ...makeDelivery({
          status: 'exhausted',
          payload: { event: 'budget_exceeded', data: { note: 'first-read-copy' } },
        }),
        subscription: makeSub(),
      } as never);
      vi.mocked(prisma.aiWebhookDelivery.updateManyAndReturn).mockResolvedValueOnce([
        makeDelivery({
          status: 'pending',
          payload: { event: 'budget_exceeded', data: { note: 'after-the-reset' } },
        }),
      ] as never);

      const result = await retryDelivery('del-1', { awaitDelivery: true });

      expect(result).toBe(true);
      const body = String((mockFetch.mock.calls[0][1] as { body: string }).body);
      expect(body).toContain('after-the-reset');
      expect(body).not.toContain('first-read-copy');
    });
  });

  describe('a retry timer armed before a manual retry', () => {
    it('does not send again once the row was reset by hand', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 503 });
      vi.mocked(prisma.aiWebhookDelivery.findUnique).mockImplementation((async () =>
        armedRow({ attempts: 0 })) as never);

      await dispatchWebhookEvent('budget_exceeded', { agentId: 'agent-1' });
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // An admin retried it while the timer waited: pending, with the manual
      // attempt still in flight. The old check (pending or failed) sent it twice.
      vi.mocked(prisma.aiWebhookDelivery.findUnique).mockResolvedValue(
        makeDelivery({ status: 'pending', attempts: 0, nextRetryAt: null })
      );
      await vi.advanceTimersByTimeAsync(10_000);

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('claims the row before sending, and sends nothing when the tick claimed it first', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 503 });
      vi.mocked(prisma.aiWebhookDelivery.findUnique).mockImplementation((async () =>
        armedRow({ attempts: 0 })) as never);

      await dispatchWebhookEvent('budget_exceeded', { agentId: 'agent-1' });
      const armedFor: unknown = armedRow().nextRetryAt;
      if (!(armedFor instanceof Date)) throw new Error('the failed attempt armed no retry');
      // The tick's claim landed first: the timer's claim matches nothing.
      vi.mocked(prisma.aiWebhookDelivery.updateManyAndReturn).mockResolvedValueOnce([]);

      await vi.advanceTimersByTimeAsync(10_000);

      expect(prisma.aiWebhookDelivery.updateManyAndReturn).toHaveBeenLastCalledWith({
        where: { id: 'del-1', status: 'failed', nextRetryAt: armedFor },
        data: { nextRetryAt: expect.any(Date) },
      });
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('sends the payload the timer’s claim returned, not the copy it read before claiming', async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: false, status: 503 })
        .mockResolvedValueOnce({ ok: true, status: 200 });
      // The timer's read still carries the payload an erasure is about to redact.
      vi.mocked(prisma.aiWebhookDelivery.findUnique).mockImplementation((async () =>
        armedRow({
          attempts: 0,
          payload: { event: 'budget_exceeded', data: { note: 'pre-claim-copy' } },
        })) as never);

      await dispatchWebhookEvent('budget_exceeded', { agentId: 'agent-1' });
      expect(mockFetch).toHaveBeenCalledTimes(1);
      // The claim returns the row as the erasure left it.
      vi.mocked(prisma.aiWebhookDelivery.updateManyAndReturn).mockResolvedValueOnce([
        makeDelivery({
          status: 'failed',
          attempts: 1,
          payload: { event: 'budget_exceeded', data: { note: 'claimed-copy' } },
        }),
      ] as never);

      await vi.advanceTimersByTimeAsync(10_000);

      expect(mockFetch).toHaveBeenCalledTimes(2);
      const body = String((mockFetch.mock.calls[1][1] as { body: string }).body);
      expect(body).toContain('claimed-copy');
      expect(body).not.toContain('pre-claim-copy');
    });

    it('does not send again once the manual attempt failed and armed its own retry', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 503 });
      vi.mocked(prisma.aiWebhookDelivery.findUnique).mockImplementation((async () =>
        armedRow({ attempts: 0 })) as never);

      await dispatchWebhookEvent('budget_exceeded', { agentId: 'agent-1' });
      const armedFor: unknown = armedRow().nextRetryAt;
      if (!(armedFor instanceof Date)) throw new Error('the failed attempt armed no retry');

      // Failed again, from the manual attempt: a later nextRetryAt, its own timer.
      vi.mocked(prisma.aiWebhookDelivery.findUnique).mockResolvedValue(
        makeDelivery({
          status: 'failed',
          attempts: 1,
          nextRetryAt: new Date(armedFor.getTime() + 5_000),
        })
      );
      await vi.advanceTimersByTimeAsync(10_000);

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });
});

// ─── Email-channel delivery ─────────────────────────────────────────────────

describe('email-channel delivery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.aiWebhookDelivery.create).mockResolvedValue(makeDelivery());
    vi.mocked(prisma.aiWebhookDelivery.update).mockResolvedValue(makeDelivery());
    vi.mocked(prisma.aiWebhookDelivery.updateMany).mockResolvedValue({ count: 1 });
    returnTheWrittenRow();
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
      }),
      // Bounded: the SDK request is handed the timeout’s signal (t-808).
      { signal: expect.any(AbortSignal), idempotencyKey: expect.any(String) }
    );
  });

  describe('the Resend idempotency key (t-822)', () => {
    const createdAt = new Date('2026-10-17T09:00:00.000Z');
    const keyOf = (call: number): string | undefined =>
      (mockResendSend.mock.calls[call]?.[1] as { idempotencyKey?: string } | undefined)
        ?.idempotencyKey;

    /** A failed email row due for the maintenance tick. */
    function dueEmailRow(overrides: Record<string, unknown> = {}) {
      return {
        ...makeDelivery({
          status: 'failed',
          attempts: 1,
          nextRetryAt: new Date(Date.now() - 1_000),
          createdAt,
          // As the dispatch below stored it.
          eventType: 'workflow_failed',
          payload: { event: 'workflow_failed', data: { error: 'step exploded' } },
          ...overrides,
        }),
        subscription: makeEmailSub(),
      };
    }

    it('is the same on an automatic retry, so a timed-out send Resend accepted is not sent twice', async () => {
      vi.mocked(prisma.aiWebhookSubscription.findMany).mockResolvedValue([makeEmailSub()] as never);
      vi.mocked(prisma.aiWebhookDelivery.create).mockResolvedValue(makeDelivery({ createdAt }));
      // First send: the answer never comes back, and the attempt times out.
      vi.useFakeTimers();
      try {
        mockResendSend.mockImplementationOnce(() => new Promise(() => undefined));
        const dispatched = dispatchWebhookEvent('workflow_failed', { error: 'step exploded' });
        await vi.advanceTimersByTimeAsync(DISPATCH_TIMEOUT_MS.email);
        await dispatched;
      } finally {
        vi.useRealTimers();
      }

      // The tick's retry of the same row, as its claim returns it.
      const row = dueEmailRow();
      vi.mocked(prisma.aiWebhookDelivery.findMany).mockResolvedValue([row] as never);
      vi.mocked(prisma.aiWebhookDelivery.updateManyAndReturn).mockResolvedValueOnce([
        { ...row, status: 'pending' },
      ] as never);
      await processPendingRetries();

      expect(mockResendSend).toHaveBeenCalledTimes(2);
      expect(keyOf(0)).toMatch(/^webhook-delivery\/del-1\/0\/[0-9a-f]{16}$/);
      expect(keyOf(1)).toBe(keyOf(0));
      // Resend refuses a reused key on a different request, so both attempts
      // render the row's own time, not the per-attempt body timestamp.
      const { default: EventNotification } = await import('@/emails/event-notification');
      const rendered = vi.mocked(EventNotification).mock.calls.map((c) => c[0].timestamp);
      expect(rendered).toEqual([createdAt.toISOString(), createdAt.toISOString()]);
      expect(mockResendSend.mock.calls[1][0]).toEqual(mockResendSend.mock.calls[0][0]);
    });

    it('changes on a manual retry or DLQ replay, whose reset bumps the send generation', async () => {
      vi.mocked(prisma.aiWebhookDelivery.findUnique).mockResolvedValueOnce({
        ...makeDelivery({ status: 'delivered', attempts: 1, createdAt }),
        subscription: makeEmailSub(),
      } as never);
      vi.mocked(prisma.aiWebhookDelivery.updateManyAndReturn).mockResolvedValueOnce([
        makeDelivery({ status: 'pending', attempts: 0, createdAt, sendGeneration: 1 }),
      ] as never);

      await retryDelivery('del-1', { awaitDelivery: true });

      expect(prisma.aiWebhookDelivery.updateManyAndReturn).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ sendGeneration: { increment: 1 } }),
        })
      );
      expect(mockResendSend).toHaveBeenCalledOnce();
      expect(keyOf(0)).toMatch(/^webhook-delivery\/del-1\/1\//);
    });

    it('changes when the subscription address was edited between attempts', async () => {
      const first = dueEmailRow();
      vi.mocked(prisma.aiWebhookDelivery.findMany).mockResolvedValueOnce([first] as never);
      vi.mocked(prisma.aiWebhookDelivery.updateManyAndReturn).mockResolvedValueOnce([
        { ...first, status: 'pending' },
      ] as never);
      await processPendingRetries();

      const second = {
        ...dueEmailRow(),
        subscription: makeEmailSub({ emailAddress: 'new@example.com' }),
      };
      vi.mocked(prisma.aiWebhookDelivery.findMany).mockResolvedValueOnce([second] as never);
      vi.mocked(prisma.aiWebhookDelivery.updateManyAndReturn).mockResolvedValueOnce([
        { ...second, status: 'pending' },
      ] as never);
      await processPendingRetries();

      expect(mockResendSend).toHaveBeenCalledTimes(2);
      expect(keyOf(1)).not.toBe(keyOf(0));
      expect(keyOf(1)).toMatch(/^webhook-delivery\/del-1\/0\//);
    });
  });

  it('marks email delivery as delivered when Resend returns no error', async () => {
    vi.mocked(prisma.aiWebhookSubscription.findMany).mockResolvedValue([makeEmailSub()] as never);

    await dispatchWebhookEvent('workflow_failed', { error: 'step exploded' });

    expect(prisma.aiWebhookDelivery.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: AWAITING,
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
      .mocked(prisma.aiWebhookDelivery.updateMany)
      .mock.calls.find((c) => (c[0]?.data as Record<string, unknown>)?.status === 'failed');
    expect(failUpdate).toBeDefined();
    expect((failUpdate?.[0]?.data as Record<string, unknown>).lastError).toBe('Invalid recipient');
  });

  describe('a send that does not finish (t-808)', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('fails as retriable once the email timeout passes, and aborts the SDK request', async () => {
      vi.mocked(prisma.aiWebhookSubscription.findMany).mockResolvedValue([makeEmailSub()] as never);
      vi.mocked(prisma.aiWebhookDelivery.findUnique).mockResolvedValue(
        makeDelivery({ attempts: 0 })
      );
      let signal: AbortSignal | undefined;
      // Never settles, and ignores the signal: only the race can end it.
      mockResendSend.mockImplementation((_payload: unknown, options?: { signal?: AbortSignal }) => {
        signal = options?.signal;
        return new Promise(() => undefined);
      });

      const dispatched = dispatchWebhookEvent('workflow_failed', { error: 'step exploded' });
      await vi.advanceTimersByTimeAsync(DISPATCH_TIMEOUT_MS.email - 1);
      expect(
        vi
          .mocked(prisma.aiWebhookDelivery.updateMany)
          .mock.calls.some((c) => (c[0]?.data as Record<string, unknown>)?.status === 'failed')
      ).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await dispatched;

      expect(signal?.aborted).toBe(true);
      const failUpdate = vi
        .mocked(prisma.aiWebhookDelivery.updateMany)
        .mock.calls.find((c) => (c[0]?.data as Record<string, unknown>)?.status === 'failed');
      expect(failUpdate?.[0]?.data).toMatchObject({
        status: 'failed',
        lastError: `Email send timed out after ${DISPATCH_TIMEOUT_MS.email} ms`,
        nextRetryAt: expect.any(Date),
      });
    });
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
    const updateCalls = vi.mocked(prisma.aiWebhookDelivery.updateMany).mock.calls;
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0][0]).toMatchObject({
      where: AWAITING,
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
      .mocked(prisma.aiWebhookDelivery.updateMany)
      .mock.calls.find((c) => (c[0]?.data as Record<string, unknown>)?.status === 'exhausted');
    expect(exhaustedUpdate).toBeDefined();
    expect((exhaustedUpdate?.[0]?.data as Record<string, unknown>).lastError).toBe(
      'Email subscription has no destination address'
    );
    // No 'delivered' overwrite should ever happen on a terminal failure.
    expect(
      vi
        .mocked(prisma.aiWebhookDelivery.updateMany)
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
      .mocked(prisma.aiWebhookDelivery.updateMany)
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
      .mocked(prisma.aiWebhookDelivery.updateMany)
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
      .mocked(prisma.aiWebhookDelivery.updateMany)
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
      }),
      { signal: expect.any(AbortSignal), idempotencyKey: expect.any(String) }
    );
  });

  it('subject line uses providerSlug when present (and no agentName/workflowName)', async () => {
    vi.mocked(prisma.aiWebhookSubscription.findMany).mockResolvedValue([makeEmailSub()] as never);

    await dispatchWebhookEvent('circuit_breaker_opened', { providerSlug: 'anthropic' });

    expect(mockResendSend).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: expect.stringContaining('Provider circuit breaker opened · anthropic'),
      }),
      { signal: expect.any(AbortSignal), idempotencyKey: expect.any(String) }
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
      }),
      { signal: expect.any(AbortSignal), idempotencyKey: expect.any(String) }
    );
  });
});

// ─── attemptWebhookDelivery edge cases ──────────────────────────────────────

describe('webhook-channel delivery edge cases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.aiWebhookDelivery.create).mockResolvedValue(makeDelivery());
    vi.mocked(prisma.aiWebhookDelivery.update).mockResolvedValue(makeDelivery());
    vi.mocked(prisma.aiWebhookDelivery.updateMany).mockResolvedValue({ count: 1 });
    returnTheWrittenRow();
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
      .mocked(prisma.aiWebhookDelivery.updateMany)
      .mock.calls.find((c) => (c[0]?.data as Record<string, unknown>)?.status === 'exhausted');
    expect(exhaustedUpdate).toBeDefined();
    expect((exhaustedUpdate?.[0]?.data as Record<string, unknown>).lastError).toBe(
      'Webhook subscription has no URL'
    );
    expect(
      vi
        .mocked(prisma.aiWebhookDelivery.updateMany)
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
    vi.mocked(prisma.aiWebhookDelivery.updateMany).mockResolvedValue({ count: 1 });
    returnTheWrittenRow();
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

// ─── Delivery destination recording (§109 t-739) ────────────────────────────

describe('delivery destination recording', () => {
  const OLD_URL = 'https://old.example.com/webhook';
  const NEW_URL = 'https://new.example.com/webhook';
  const oldPair = describeDestination('webhook', OLD_URL);
  const newPair = describeDestination('webhook', NEW_URL);

  /** The data of the last outcome update written for the delivery. */
  function lastUpdateData(): Record<string, unknown> {
    const calls = vi.mocked(prisma.aiWebhookDelivery.updateMany).mock.calls;
    return calls.at(-1)![0].data;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockFetch.mockResolvedValue({ ok: true, status: 200 });
    mockResendSend.mockResolvedValue({ data: { id: 'resend_msg_id' }, error: null });
    vi.mocked(prisma.aiWebhookDelivery.create).mockResolvedValue(makeDelivery());
    vi.mocked(prisma.aiWebhookDelivery.update).mockResolvedValue(makeDelivery());
    vi.mocked(prisma.aiWebhookDelivery.updateMany).mockResolvedValue({ count: 1 });
    returnTheWrittenRow();
    vi.mocked(prisma.aiWebhookDelivery.findUnique).mockResolvedValue(makeDelivery());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('at create', () => {
    it('records the reduced destination and fingerprint for a webhook subscription', async () => {
      const url = 'https://hooks.example.com/services/Ab3dEf6hIj9kLm2nOp5qRs8t?key=SECRETQ';
      vi.mocked(prisma.aiWebhookSubscription.findMany).mockResolvedValue([
        makeSub({ url }),
      ] as never);

      await dispatchWebhookEvent('budget_exceeded', { agentId: 'agent-1' });

      const data = vi.mocked(prisma.aiWebhookDelivery.create).mock.calls[0][0].data as Record<
        string,
        unknown
      >;
      expect(data.destination).toBe('https://hooks.example.com');
      expect(data.destinationFingerprint).toBe(
        describeDestination('webhook', url).destinationFingerprint
      );
      expect(JSON.stringify(data)).not.toContain('SECRETQ');
    });

    it('records the address verbatim for an email subscription', async () => {
      vi.mocked(prisma.aiWebhookSubscription.findMany).mockResolvedValue([makeEmailSub()] as never);

      await dispatchWebhookEvent('agent_updated', { agentName: 'Bot' });

      expect(prisma.aiWebhookDelivery.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            destination: 'alerts@example.com',
            destinationFingerprint: describeDestination('email', 'alerts@example.com')
              .destinationFingerprint,
          }),
        })
      );
    });
  });

  describe('at an attempt', () => {
    it('writes the new destination and the old one as history in the same update as a delivered outcome', async () => {
      vi.mocked(prisma.aiWebhookDelivery.findUnique).mockResolvedValue({
        ...makeDelivery({ status: 'failed', attempts: 1, ...oldPair }),
        subscription: makeSub({ url: NEW_URL }),
      } as never);
      // The reset returns the row as it wrote it: still carrying the old destination.
      vi.mocked(prisma.aiWebhookDelivery.updateManyAndReturn).mockResolvedValue([
        makeDelivery({ status: 'pending', attempts: 0, ...oldPair }),
      ] as never);

      await retryDelivery('del-1', { awaitDelivery: true });

      expect(mockFetch).toHaveBeenCalledWith(NEW_URL, expect.anything());
      const data = lastUpdateData();
      expect(data).toMatchObject({
        status: 'delivered',
        ...newPair,
        previousDestinations: [{ ...oldPair, until: expect.any(String) }],
      });
    });

    it('writes the new destination and history in the same update as a failed outcome', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 500 });
      vi.mocked(prisma.aiWebhookDelivery.findUnique).mockResolvedValue({
        ...makeDelivery({ status: 'failed', attempts: 1, ...oldPair }),
        subscription: makeSub({ url: NEW_URL }),
      } as never);
      // The reset returns the row as it wrote it: still carrying the old destination.
      vi.mocked(prisma.aiWebhookDelivery.updateManyAndReturn).mockResolvedValue([
        makeDelivery({ status: 'pending', attempts: 0, ...oldPair }),
      ] as never);

      await retryDelivery('del-1', { awaitDelivery: true });

      const data = lastUpdateData();
      expect(data).toMatchObject({
        status: 'failed',
        lastResponseCode: 500,
        ...newPair,
        previousDestinations: [{ ...oldPair, until: expect.any(String) }],
      });
    });

    it('adds no destination keys to the outcome update when the destination is unchanged', async () => {
      vi.mocked(prisma.aiWebhookDelivery.findUnique).mockResolvedValue({
        ...makeDelivery({ status: 'failed', attempts: 1, ...oldPair }),
        subscription: makeSub({ url: OLD_URL }),
      } as never);
      // The reset returns the row as it wrote it: still carrying the old destination.
      vi.mocked(prisma.aiWebhookDelivery.updateManyAndReturn).mockResolvedValue([
        makeDelivery({ status: 'pending', attempts: 0, ...oldPair }),
      ] as never);

      await retryDelivery('del-1', { awaitDelivery: true });

      // Population first: the attempt did write a delivered outcome.
      const data = lastUpdateData();
      expect(data.status).toBe('delivered');
      expect(data).not.toHaveProperty('destination');
      expect(data).not.toHaveProperty('destinationFingerprint');
      expect(data).not.toHaveProperty('previousDestinations');
    });
  });

  describe('when the subscription has been deleted', () => {
    it('retryDelivery returns false without writing or sending', async () => {
      vi.mocked(prisma.aiWebhookDelivery.findUnique).mockResolvedValue({
        ...makeDelivery({ status: 'exhausted', ...oldPair }),
        subscription: null,
      } as never);

      const result = await retryDelivery('del-1', { awaitDelivery: true });

      expect(result).toBe(false);
      expect(prisma.aiWebhookDelivery.update).not.toHaveBeenCalled();
      expect(prisma.aiWebhookDelivery.updateMany).not.toHaveBeenCalled();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('processPendingRetries marks the row exhausted with a deleted reason and does not send', async () => {
      vi.mocked(prisma.aiWebhookDelivery.findMany).mockResolvedValue([
        {
          ...makeDelivery({
            id: 'del-gone',
            status: 'failed',
            attempts: 1,
            lastError: 'HTTP 503',
          }),
          subscription: null,
        },
      ] as never);

      await processPendingRetries();

      expect(mockFetch).not.toHaveBeenCalled();
      // The real failure survives; the reason retries stopped is appended to it.
      expect(prisma.aiWebhookDelivery.updateMany).toHaveBeenCalledWith({
        where: { id: 'del-gone', status: { in: ['pending', 'failed'] } },
        data: {
          status: 'exhausted',
          nextRetryAt: null,
          lastError: 'HTTP 503 (not retried: subscription deleted)',
        },
      });
    });

    it('processPendingRetries writes only the reason when the row had no earlier error', async () => {
      vi.mocked(prisma.aiWebhookDelivery.findMany).mockResolvedValue([
        { ...makeDelivery({ id: 'del-gone', status: 'failed', attempts: 1 }), subscription: null },
      ] as never);

      await processPendingRetries();

      expect(prisma.aiWebhookDelivery.updateMany).toHaveBeenCalledWith({
        where: { id: 'del-gone', status: { in: ['pending', 'failed'] } },
        data: expect.objectContaining({ lastError: 'Not retried: subscription deleted' }),
      });
    });

    it('processPendingRetries keeps "Subscription deactivated" for an inactive subscription', async () => {
      vi.mocked(prisma.aiWebhookDelivery.findMany).mockResolvedValue([
        {
          ...makeDelivery({ id: 'del-off', status: 'failed', attempts: 1 }),
          subscription: makeSub({ isActive: false }),
        },
      ] as never);

      await processPendingRetries();

      expect(mockFetch).not.toHaveBeenCalled();
      expect(prisma.aiWebhookDelivery.updateMany).toHaveBeenCalledWith({
        where: { id: 'del-off', status: { in: ['pending', 'failed'] } },
        data: expect.objectContaining({
          status: 'exhausted',
          lastError: 'Subscription deactivated',
        }),
      });
    });

    it('the in-process retry marks the row exhausted with a deleted reason', async () => {
      vi.mocked(prisma.aiWebhookSubscription.findMany).mockResolvedValue([makeSub()] as never);
      mockFetch.mockResolvedValue({ ok: false, status: 503 });
      vi.mocked(prisma.aiWebhookSubscription.findUnique).mockResolvedValue(null);
      // The row the retry timer re-reads carries the failure the first attempt recorded.
      // It is the row as the failed attempt left it: `failed`, armed for this timer.
      vi.mocked(prisma.aiWebhookDelivery.findUnique).mockImplementation((async () =>
        armedRow({ lastError: 'HTTP 503' })) as never);

      await dispatchWebhookEvent('budget_exceeded', { agentId: 'agent-1' });
      await vi.runAllTimersAsync();

      // Only the initial attempt reached the network; the retry did not.
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(prisma.aiWebhookDelivery.updateMany).toHaveBeenLastCalledWith({
        where: AWAITING,
        data: {
          status: 'exhausted',
          nextRetryAt: null,
          lastError: 'HTTP 503 (not retried: subscription deleted)',
        },
      });
    });

    it('the in-process retry on an inactive subscription says deactivated, not deleted', async () => {
      vi.mocked(prisma.aiWebhookSubscription.findMany).mockResolvedValue([makeSub()] as never);
      mockFetch.mockResolvedValue({ ok: false, status: 503 });
      vi.mocked(prisma.aiWebhookSubscription.findUnique).mockResolvedValue(
        makeSub({ isActive: false })
      );
      vi.mocked(prisma.aiWebhookDelivery.findUnique).mockImplementation((async () =>
        armedRow()) as never);

      await dispatchWebhookEvent('budget_exceeded', { agentId: 'agent-1' });
      await vi.runAllTimersAsync();

      expect(prisma.aiWebhookDelivery.updateMany).toHaveBeenLastCalledWith({
        where: AWAITING,
        data: expect.objectContaining({
          status: 'exhausted',
          lastError: 'Subscription deactivated',
        }),
      });
    });
  });
});
