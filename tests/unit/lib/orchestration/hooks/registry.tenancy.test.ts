/**
 * Tests: the event-hook cache is partitioned per org (§108 t-712)
 *
 * `AiEventHook` is tenant-owned and `eventType` is a label two orgs both use.
 * The cache used to be one process-wide `Map<eventType, hooks>` filled by
 * whichever org emitted first, so for the next minute every org dispatched
 * that org's hooks: org B's event POSTed its payload to org A's URL, signed
 * with org A's secret, and B's own hooks never fired.
 *
 * The load is also the assertion that matters for the scope: the mocked
 * `findMany` records the tenant context it was called in, so a read that
 * escaped the emitting org's scope fails here rather than at `multi` in
 * production.
 *
 * @see lib/orchestration/hooks/registry.ts
 * @see lib/tenancy/process-state.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ─── Module mocks ───────────────────────────────────────────────────────

// Only `TENANCY_MODE` is read from `env` anywhere in this module's import
// graph (`lib/tenancy/context.ts`), so a one-field stand-in is complete.
const mockEnv = vi.hoisted(() => ({ TENANCY_MODE: 'single' }));
vi.mock('@/lib/env', () => ({ env: mockEnv }));

const mockFindMany = vi.hoisted(() => vi.fn());
vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiEventHook: { findMany: mockFindMany },
    aiEventHookDelivery: {
      create: vi.fn().mockResolvedValue({ id: 'del-1' }),
      update: vi.fn().mockResolvedValue({ id: 'del-1' }),
    },
  },
}));

const mockLogger = vi.hoisted(() => ({
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock('@/lib/logging', () => ({ logger: mockLogger }));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// ─── Imports ────────────────────────────────────────────────────────────

import { emitHookEvent, invalidateHookCache } from '@/lib/orchestration/hooks/registry';
import { requireTenantContext, runAsOrg } from '@/lib/tenancy/context';
import {
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  verifyHookSignature,
  type VerifyResult,
} from '@/lib/orchestration/hooks/signing';
import { prisma } from '@/lib/db/client';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';

const ORG_A = 'cmorg00000000000000000orga';
const ORG_B = 'cmorg00000000000000000orgb';

/** The org each hook row belongs to, and the URL that proves whose it was. */
const HOOKS_BY_ORG: Record<string, { id: string; url: string; secret: string }> = {
  [ORG_A]: { id: 'hook-a', url: 'https://a.example.com/hook', secret: 'secret-a' },
  [ORG_B]: { id: 'hook-b', url: 'https://b.example.com/hook', secret: 'secret-b' },
  [INSTALL_ORG_ID]: { id: 'hook-install', url: 'https://install.example.com/hook', secret: 's' },
};

/** Org ids the mocked `findMany` was called under, in call order. */
let readScopes: (string | null | undefined)[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  invalidateHookCache();
  readScopes = [];
  mockEnv.TENANCY_MODE = 'multi';
  mockFetch.mockResolvedValue({ ok: true, status: 200 });

  // Stands in for the policies: the rows returned are the ones the calling
  // org can see. It resolves the org exactly as the data layer does — the
  // entered context, or the install org at `single` — so a read that reached
  // the database without a scope is visible as a wrong org id here.
  mockFindMany.mockImplementation(() => {
    const orgId = requireTenantContext().orgId;
    readScopes.push(orgId);
    const hook = orgId === null ? undefined : HOOKS_BY_ORG[orgId];
    if (!hook) return Promise.resolve([]);
    return Promise.resolve([
      {
        id: hook.id,
        eventType: 'conversation.started',
        action: { type: 'webhook', url: hook.url },
        filter: null,
        secret: hook.secret,
      },
    ]);
  });
});

/** Emit inside `orgId` and wait for the fire-and-forget dispatch to settle. */
async function emitAs(orgId: string, expectedFetches: number): Promise<void> {
  await runAsOrg(orgId, async () => {
    emitHookEvent('conversation.started', { conversationId: 'conv-1' });
  });
  if (expectedFetches === 0) return;
  await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(expectedFetches));
}

function urlsPosted(): string[] {
  return mockFetch.mock.calls.map((call) => String(call[0]));
}

interface Dispatch {
  body: string;
  headers: Record<string, string>;
}

/** Each outbound POST, in order, as body + headers. */
function dispatches(): Dispatch[] {
  return mockFetch.mock.calls.map((call) => call[1] as Dispatch);
}

/** Does this dispatch verify under `secret`, by the real signing scheme? */
function verify(dispatch: Dispatch, secret: string): VerifyResult {
  return verifyHookSignature(
    secret,
    dispatch.body,
    dispatch.headers[TIMESTAMP_HEADER],
    dispatch.headers[SIGNATURE_HEADER]
  );
}

describe('the hook cache at multi', () => {
  it('dispatches each org to its own hook, even when the other org warmed the cache', async () => {
    await emitAs(ORG_A, 1);
    await emitAs(ORG_B, 2);

    expect(urlsPosted()).toEqual(['https://a.example.com/hook', 'https://b.example.com/hook']);
  });

  it('signs each org with its own secret', async () => {
    await emitAs(ORG_A, 1);
    await emitAs(ORG_B, 2);

    // Verified against the real scheme rather than compared to each other: the
    // payload carries a fresh timestamp per dispatch, so two bodies signed with
    // the SAME key already differ, and "the signatures are not equal" would
    // pass while org B was being signed with org A's secret.
    const [callA, callB] = dispatches();
    expect(verify(callA, HOOKS_BY_ORG[ORG_A].secret)).toEqual({ valid: true });
    expect(verify(callB, HOOKS_BY_ORG[ORG_B].secret)).toEqual({ valid: true });
    expect(verify(callB, HOOKS_BY_ORG[ORG_A].secret)).toMatchObject({ valid: false });
  });

  it('writes each delivery row against the hook the emitting org owns', async () => {
    await emitAs(ORG_A, 1);
    await emitAs(ORG_B, 2);

    expect(
      vi.mocked(prisma.aiEventHookDelivery.create).mock.calls.map((c) => c[0].data.hookId)
    ).toEqual(['hook-a', 'hook-b']);
  });

  it('reads each org inside that org, and reads an org only once per TTL', async () => {
    await emitAs(ORG_A, 1);
    await emitAs(ORG_A, 2);
    await emitAs(ORG_B, 3);

    // Two reads, not three: A's second emit is served from A's partition.
    expect(readScopes).toEqual([ORG_A, ORG_B]);
  });

  it('drops every org partition on invalidate, so a disabled hook cannot keep firing', async () => {
    await emitAs(ORG_A, 1);
    await emitAs(ORG_B, 2);
    expect(readScopes).toEqual([ORG_A, ORG_B]);

    invalidateHookCache();

    await emitAs(ORG_A, 3);
    await emitAs(ORG_B, 4);
    expect(readScopes).toEqual([ORG_A, ORG_B, ORG_A, ORG_B]);
  });

  it('refuses to read at all when nothing entered an org, and says so', async () => {
    emitHookEvent('conversation.started', { conversationId: 'conv-1' });

    await vi.waitFor(() =>
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Hook dispatch error',
        expect.objectContaining({ error: expect.stringContaining('No tenant context') })
      )
    );
    expect(mockFindMany).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('the hook cache at single', () => {
  beforeEach(() => {
    mockEnv.TENANCY_MODE = 'single';
  });

  it('needs no context: one partition, the install org, read once', async () => {
    emitHookEvent('conversation.started', { conversationId: 'conv-1' });
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));

    emitHookEvent('conversation.started', { conversationId: 'conv-2' });
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));

    expect(readScopes).toEqual([INSTALL_ORG_ID]);
    expect(urlsPosted()).toEqual([
      'https://install.example.com/hook',
      'https://install.example.com/hook',
    ]);
  });
});
