/**
 * Tests: the outbound fetches a customer org chooses connect through the safe dispatcher (§111 t-811)
 *
 * `safe-dispatcher.test.ts` proves the dispatcher refuses an unsafe address.
 * This proves the call sites an org admin can aim — the knowledge URL import,
 * webhook delivery, the webhook test button, and the allowlisted outbound call
 * behind `external_call` / `call_external_api` — hand it to `fetch`
 * when acting for a customer org at `multi`, and leave the fetch as it was
 * for the install org.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return { ...actual, env: { ...actual.env, TENANCY_MODE: 'multi' } };
});
vi.mock('@/lib/logging', () => {
  const log = { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() };
  return { logger: { ...log, withContext: vi.fn(() => log) } };
});
vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiWebhookSubscription: { findMany: vi.fn() },
    aiWebhookDelivery: {
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      updateManyAndReturn: vi.fn(),
    },
  },
}));

import { prisma } from '@/lib/db/client';
import { fetchDocumentFromUrl } from '@/lib/orchestration/knowledge/url-fetcher';
import { dispatchWebhookEvent } from '@/lib/orchestration/webhooks/dispatcher';
import { executeHttpRequest } from '@/lib/orchestration/http';
import { resetAllowlistCache } from '@/lib/orchestration/http/allowlist';
import { runAsOrg } from '@/lib/tenancy/context';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';

const ORG_B = 'cmorg0000000000000000orgb';
const mockFetch = vi.fn();

/** Whether the init `fetch` was last called with carried a dispatcher. */
const lastHadDispatcher = (): boolean => {
  const init = mockFetch.mock.calls.at(-1)?.[1] as Record<string, unknown> | undefined;
  return init?.dispatcher !== undefined;
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', mockFetch);
});
afterEach(() => vi.unstubAllGlobals());

describe('the knowledge URL import', () => {
  beforeEach(() => {
    mockFetch.mockResolvedValue(
      new Response('hello', { status: 200, headers: { 'Content-Type': 'text/plain' } })
    );
  });

  it('fetches through the dispatcher for a customer org', async () => {
    await runAsOrg(ORG_B, () => fetchDocumentFromUrl('https://docs.example.com/a.txt'));
    expect(mockFetch).toHaveBeenCalled();
    expect(lastHadDispatcher()).toBe(true);
  });

  it('control: fetches as before for the install org', async () => {
    await runAsOrg(INSTALL_ORG_ID, () => fetchDocumentFromUrl('https://docs.example.com/a.txt'));
    expect(mockFetch).toHaveBeenCalled();
    expect(lastHadDispatcher()).toBe(false);
  });
});

describe('webhook delivery', () => {
  const sub = {
    orgId: ORG_B,
    id: 'sub-1',
    channel: 'webhook',
    url: 'https://hooks.example.com/in',
    secret: 'test-secret-key-1234567890',
    emailAddress: null,
    events: ['workflow_failed'],
    agentIds: [] as string[],
    workflowIds: [] as string[],
    isActive: true,
    description: null,
    maxAttempts: 3,
    retryBackoffMs: [10_000],
    createdBy: 'u1',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(() => {
    vi.mocked(prisma.aiWebhookSubscription.findMany).mockResolvedValue([sub] as never);
    vi.mocked(prisma.aiWebhookDelivery.create).mockResolvedValue({ id: 'del-1' } as never);
    vi.mocked(prisma.aiWebhookDelivery.update).mockResolvedValue({} as never);
    vi.mocked(prisma.aiWebhookDelivery.updateMany).mockResolvedValue({ count: 1 });
    mockFetch.mockResolvedValue(new Response('ok', { status: 200 }));
  });

  it('delivers through the dispatcher for a customer org', async () => {
    await runAsOrg(ORG_B, () => dispatchWebhookEvent('workflow_failed', { workflowId: 'w1' }));
    expect(mockFetch).toHaveBeenCalled();
    expect(lastHadDispatcher()).toBe(true);
  });

  it('marks a delivery the dispatcher refused as terminal, worded without the host', async () => {
    const { UnsafeResolvedAddressError } = await import('@/lib/security/safe-dispatcher');
    mockFetch.mockRejectedValue(
      new TypeError('fetch failed', {
        cause: new UnsafeResolvedAddressError('hooks.example.com', '10.0.0.5', 'private_ip'),
      })
    );
    vi.mocked(prisma.aiWebhookDelivery.findUnique).mockResolvedValue({ attempts: 0 } as never);
    await runAsOrg(ORG_B, () => dispatchWebhookEvent('workflow_failed', { workflowId: 'w1' }));
    const writes = [
      ...vi.mocked(prisma.aiWebhookDelivery.update).mock.calls,
      ...vi.mocked(prisma.aiWebhookDelivery.updateMany).mock.calls,
    ].map((c) => JSON.stringify(c[0]));
    expect(writes.some((w) => w.includes('"status":"exhausted"') || w.includes('"failed"'))).toBe(
      true
    );
    expect(writes.some((w) => w.includes('10.0.0.5'))).toBe(false);
  });

  it('control: delivers as before for the install org', async () => {
    await runAsOrg(INSTALL_ORG_ID, () =>
      dispatchWebhookEvent('workflow_failed', { workflowId: 'w1' })
    );
    expect(mockFetch).toHaveBeenCalled();
    expect(lastHadDispatcher()).toBe(false);
  });
});

describe('the allowlisted outbound call (external_call, call_external_api)', () => {
  beforeEach(() => {
    process.env.ORCHESTRATION_ALLOWED_HOSTS = 'api.allowed.com';
    resetAllowlistCache();
    mockFetch.mockResolvedValue(
      new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
    );
  });
  afterEach(() => {
    delete process.env.ORCHESTRATION_ALLOWED_HOSTS;
    resetAllowlistCache();
  });

  it('connects through the dispatcher for a customer org — the allowlist is install-wide', async () => {
    await runAsOrg(ORG_B, () =>
      executeHttpRequest({ url: 'https://api.allowed.com/x', method: 'GET' })
    );
    expect(mockFetch).toHaveBeenCalled();
    expect(lastHadDispatcher()).toBe(true);
  });

  it('control: connects as before for the install org', async () => {
    await runAsOrg(INSTALL_ORG_ID, () =>
      executeHttpRequest({ url: 'https://api.allowed.com/x', method: 'GET' })
    );
    expect(lastHadDispatcher()).toBe(false);
  });

  it('refuses an allowlisted private IP literal for a customer org, before any fetch', async () => {
    process.env.ORCHESTRATION_ALLOWED_HOSTS = '10.0.0.12';
    resetAllowlistCache();
    await expect(
      runAsOrg(ORG_B, () => executeHttpRequest({ url: 'http://10.0.0.12/x', method: 'GET' }))
    ).rejects.toMatchObject({ code: 'host_not_allowed' });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('control: the install org still reaches the allowlisted literal', async () => {
    process.env.ORCHESTRATION_ALLOWED_HOSTS = '10.0.0.12';
    resetAllowlistCache();
    await runAsOrg(INSTALL_ORG_ID, () =>
      executeHttpRequest({ url: 'http://10.0.0.12/x', method: 'GET' })
    );
    expect(mockFetch).toHaveBeenCalled();
  });
});
