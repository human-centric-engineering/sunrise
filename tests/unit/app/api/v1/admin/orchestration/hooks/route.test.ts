/**
 * Tests: Event Hook CRUD Endpoints
 *
 * GET  /api/v1/admin/orchestration/hooks
 * POST /api/v1/admin/orchestration/hooks
 * GET    /api/v1/admin/orchestration/hooks/:id
 * PATCH  /api/v1/admin/orchestration/hooks/:id
 * DELETE /api/v1/admin/orchestration/hooks/:id
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

// ─── Module mocks ───────────────────────────────────────────────────────

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiEventHook: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  },
}));

vi.mock('@/lib/security/rate-limit', () => ({
  adminLimiter: { check: vi.fn(() => ({ success: true })) },
  createRateLimitResponse: vi.fn(),
}));

vi.mock('@/lib/orchestration/hooks/registry', () => ({
  invalidateHookCache: vi.fn(),
}));

vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({
  logAdminAction: vi.fn(),
  computeChanges: vi.fn(),
}));

// ─── Imports ────────────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { invalidateHookCache } from '@/lib/orchestration/hooks/registry';
import { mockAdminUser, mockUnauthenticatedUser } from '@/tests/helpers/auth';
import { GET as ListHooks, POST as CreateHook } from '@/app/api/v1/admin/orchestration/hooks/route';
import {
  GET as GetHook,
  PATCH as UpdateHook,
  DELETE as DeleteHook,
} from '@/app/api/v1/admin/orchestration/hooks/[id]/route';

// ─── Fixtures ───────────────────────────────────────────────────────────

const HOOK_ID = 'cmjbv4i3x00003wsloputgwu2';

function makeHook(overrides: Record<string, unknown> = {}) {
  return {
    id: HOOK_ID,
    name: 'Test Hook',
    eventType: 'conversation.started',
    action: { type: 'webhook', url: 'https://example.com/hook' },
    filter: null,
    isEnabled: true,
    secret: null,
    createdBy: 'user-1',
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    ...overrides,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────

function makeListRequest(params: Record<string, string> = {}): NextRequest {
  const url = new URL('http://localhost:3000/api/v1/admin/orchestration/hooks');
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  return new NextRequest(url);
}

function makeCreateRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost:3000/api/v1/admin/orchestration/hooks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function makePatchRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest(`http://localhost:3000/api/v1/admin/orchestration/hooks/${HOOK_ID}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function makeDetailRequest(): NextRequest {
  return new NextRequest(`http://localhost:3000/api/v1/admin/orchestration/hooks/${HOOK_ID}`);
}

function makeDeleteRequest(): NextRequest {
  return new NextRequest(`http://localhost:3000/api/v1/admin/orchestration/hooks/${HOOK_ID}`, {
    method: 'DELETE',
  });
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests ──────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  // Default session: admin authenticated. Tests that need a different user override this.
  vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
  // Reset rate limiter to allow-by-default after each test
  vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
  vi.mocked(createRateLimitResponse).mockReturnValue(
    Response.json({ success: false, error: { code: 'RATE_LIMITED' } }, { status: 429 })
  );
});

describe('GET /hooks', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());
    const response = await ListHooks(makeListRequest());
    expect(response.status).toBe(401);
  });

  it('returns paginated hooks', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiEventHook.findMany).mockResolvedValue([makeHook()] as never);
    vi.mocked(prisma.aiEventHook.count).mockResolvedValue(1);

    const response = await ListHooks(makeListRequest());
    expect(response.status).toBe(200);

    const body = await parseJson<{ data: unknown[]; meta: { total: number } }>(response);
    expect(body.data).toHaveLength(1);
    expect(body.meta.total).toBe(1);
  });

  it('strips `secret` and exposes `hasSecret: false` when no secret is set', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiEventHook.findMany).mockResolvedValue([makeHook({ secret: null })] as never);
    vi.mocked(prisma.aiEventHook.count).mockResolvedValue(1);

    const response = await ListHooks(makeListRequest());
    const body = await parseJson<{ data: Array<Record<string, unknown>> }>(response);

    expect(body.data[0]).toHaveProperty('hasSecret', false);
    expect(body.data[0]).not.toHaveProperty('secret');
  });

  it('strips `secret` and exposes `hasSecret: true` when a secret is set', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiEventHook.findMany).mockResolvedValue([
      makeHook({ secret: 'a'.repeat(64) }),
    ] as never);
    vi.mocked(prisma.aiEventHook.count).mockResolvedValue(1);

    const response = await ListHooks(makeListRequest());
    const body = await parseJson<{ data: Array<Record<string, unknown>> }>(response);

    expect(body.data[0]).toHaveProperty('hasSecret', true);
    expect(body.data[0]).not.toHaveProperty('secret');
  });

  it('filters by eventType', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiEventHook.findMany).mockResolvedValue([]);
    vi.mocked(prisma.aiEventHook.count).mockResolvedValue(0);

    await ListHooks(makeListRequest({ eventType: 'workflow.completed' }));

    expect(prisma.aiEventHook.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { eventType: 'workflow.completed' },
      })
    );
  });
});

describe('POST /hooks', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());
    const response = await CreateHook(
      makeCreateRequest({
        name: 'Test',
        eventType: 'conversation.started',
        action: { type: 'webhook', url: 'https://example.com' },
      })
    );
    expect(response.status).toBe(401);
  });

  it('creates a webhook hook', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiEventHook.create).mockResolvedValue(makeHook() as never);

    const response = await CreateHook(
      makeCreateRequest({
        name: 'Webhook Hook',
        eventType: 'conversation.started',
        action: { type: 'webhook', url: 'https://example.com/hook' },
      })
    );

    expect(response.status).toBe(201);
    expect(prisma.aiEventHook.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          name: 'Webhook Hook',
          eventType: 'conversation.started',
          action: { type: 'webhook', url: 'https://example.com/hook' },
        }),
      })
    );

    const body = await parseJson<{
      success: boolean;
      data: { id: string; name: string; hasSecret: boolean };
    }>(response);
    expect(body.success).toBe(true);
    expect(body.data.hasSecret).toBe(false);
    expect(body.data).not.toHaveProperty('secret');
  });

  it('rejects internal-action hooks (schema only accepts webhook)', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    const response = await CreateHook(
      makeCreateRequest({
        name: 'Internal Hook',
        eventType: 'workflow.completed',
        action: { type: 'internal', handler: 'logToAnalytics' },
      })
    );

    expect(response.status).toBe(400);
    expect(prisma.aiEventHook.create).not.toHaveBeenCalled();
  });

  it('rejects invalid event type', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    const response = await CreateHook(
      makeCreateRequest({
        name: 'Bad Hook',
        eventType: 'invalid.event',
        action: { type: 'webhook', url: 'https://example.com' },
      })
    );

    expect(response.status).toBe(400);
  });

  it('rejects invalid webhook URL', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    const response = await CreateHook(
      makeCreateRequest({
        name: 'Bad URL',
        eventType: 'conversation.started',
        action: { type: 'webhook', url: 'not-a-url' },
      })
    );

    expect(response.status).toBe(400);
  });

  it('returns 429 when rate limited on POST', async () => {
    // Arrange: rate limit exceeded
    vi.mocked(adminLimiter.check).mockReturnValue({
      success: false,
      limit: 10,
      remaining: 0,
      reset: Date.now() + 60_000,
    } as never);

    // Act
    const response = await CreateHook(
      makeCreateRequest({
        name: 'Rate Limited Hook',
        eventType: 'conversation.started',
        action: { type: 'webhook', url: 'https://example.com/hook' },
      })
    );

    // Assert
    expect(response.status).toBe(429);
  });

  it('rejects custom action.headers that collide with reserved signing header names', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    const response = await CreateHook(
      makeCreateRequest({
        name: 'Reserved header',
        eventType: 'conversation.started',
        action: {
          type: 'webhook',
          url: 'https://example.com/hook',
          headers: { 'x-sunrise-signature': 'sha256=deadbeef' },
        },
      })
    );

    expect(response.status).toBe(400);
    expect(prisma.aiEventHook.create).not.toHaveBeenCalled();
  });

  it('drops admin-supplied `secret` from POST body (not persisted via create route)', async () => {
    // Arrange: body includes a `secret` field that must not reach the DB
    vi.mocked(prisma.aiEventHook.create).mockResolvedValue(makeHook() as never);

    // Act
    await CreateHook(
      makeCreateRequest({
        name: 'Smuggled Secret',
        eventType: 'conversation.started',
        action: { type: 'webhook', url: 'https://example.com/hook' },
        secret: 'evil-user-secret',
      })
    );

    // Assert: secret was stripped before the DB write
    const createCall = vi.mocked(prisma.aiEventHook.create).mock.calls[0]?.[0];
    expect(createCall?.data).not.toHaveProperty('secret');
  });
});

describe('GET /hooks/:id', () => {
  it('returns 404 when hook not found', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiEventHook.findUnique).mockResolvedValue(null);

    const response = await GetHook(makeDetailRequest(), makeParams(HOOK_ID));
    expect(response.status).toBe(404);
  });

  it('returns hook details', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiEventHook.findUnique).mockResolvedValue(makeHook() as never);

    const response = await GetHook(makeDetailRequest(), makeParams(HOOK_ID));
    expect(response.status).toBe(200);

    const body = await parseJson<{ data: { id: string } }>(response);
    expect(body.data.id).toBe(HOOK_ID);
  });

  it('strips `secret` from the response and exposes `hasSecret`', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiEventHook.findUnique).mockResolvedValue(
      makeHook({ secret: 'deadbeef' }) as never
    );

    const response = await GetHook(makeDetailRequest(), makeParams(HOOK_ID));
    const body = await parseJson<{ data: Record<string, unknown> }>(response);

    expect(body.data).toHaveProperty('hasSecret', true);
    expect(body.data).not.toHaveProperty('secret');
  });
});

describe('PATCH /hooks/:id', () => {
  it('updates hook fields', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiEventHook.findUnique).mockResolvedValue(makeHook() as never);
    vi.mocked(prisma.aiEventHook.update).mockResolvedValue(makeHook({ name: 'Updated' }) as never);

    const response = await UpdateHook(
      makePatchRequest({ name: 'Updated', isEnabled: false }),
      makeParams(HOOK_ID)
    );

    expect(response.status).toBe(200);
    expect(prisma.aiEventHook.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ name: 'Updated', isEnabled: false }),
      })
    );
  });

  it('returns 404 when hook does not exist on PATCH', async () => {
    // Arrange: hook not found
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiEventHook.findUnique).mockResolvedValue(null);

    // Act
    const response = await UpdateHook(makePatchRequest({ name: 'Updated' }), makeParams(HOOK_ID));

    // Assert
    expect(response.status).toBe(404);
    expect(prisma.aiEventHook.update).not.toHaveBeenCalled();
  });

  it('returns 400 for invalid eventType in PATCH body', async () => {
    // Arrange: hook exists but body contains invalid eventType
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiEventHook.findUnique).mockResolvedValue(makeHook() as never);

    // Act
    const response = await UpdateHook(
      makePatchRequest({ eventType: 'not.a.valid.event' }),
      makeParams(HOOK_ID)
    );

    // Assert
    expect(response.status).toBe(400);
    expect(prisma.aiEventHook.update).not.toHaveBeenCalled();
  });

  it('returns 400 for invalid webhook URL in PATCH body', async () => {
    // Arrange: hook exists but action contains a bad URL
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiEventHook.findUnique).mockResolvedValue(makeHook() as never);

    // Act
    const response = await UpdateHook(
      makePatchRequest({ action: { type: 'webhook', url: 'not-a-url' } }),
      makeParams(HOOK_ID)
    );

    // Assert
    expect(response.status).toBe(400);
    expect(prisma.aiEventHook.update).not.toHaveBeenCalled();
  });

  it('returns 400 for invalid hook id on PATCH', async () => {
    // Arrange: non-CUID id
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    // Act
    const response = await UpdateHook(makePatchRequest({ name: 'Updated' }), makeParams('bad-id'));

    // Assert
    expect(response.status).toBe(400);
  });

  it('returns 429 when rate limited on PATCH', async () => {
    // Arrange: rate limit exceeded
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(adminLimiter.check).mockReturnValue({
      success: false,
      limit: 10,
      remaining: 0,
      reset: Date.now() + 60_000,
    } as never);

    // Act
    const response = await UpdateHook(makePatchRequest({ name: 'Updated' }), makeParams(HOOK_ID));

    // Assert
    expect(response.status).toBe(429);
  });

  it('updates only eventType and passes it through to prisma.update', async () => {
    // Arrange: only eventType provided — all other optional fields absent
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiEventHook.findUnique).mockResolvedValue(makeHook() as never);
    vi.mocked(prisma.aiEventHook.update).mockResolvedValue(
      makeHook({ eventType: 'message.created' }) as never
    );

    // Act
    const response = await UpdateHook(
      makePatchRequest({ eventType: 'message.created' }),
      makeParams(HOOK_ID)
    );

    // Assert: status and that prisma received exactly the eventType field
    expect(response.status).toBe(200);
    const updateCall = vi.mocked(prisma.aiEventHook.update).mock.calls[0][0];
    expect(updateCall.data).toEqual(expect.objectContaining({ eventType: 'message.created' }));
    // Selective patch: name, action, filter, isEnabled must NOT be included in the data object
    expect(updateCall.data).not.toHaveProperty('name');
    expect(updateCall.data).not.toHaveProperty('action');
    expect(updateCall.data).not.toHaveProperty('filter');
    expect(updateCall.data).not.toHaveProperty('isEnabled');
  });

  it('updates only action (valid webhook URL) and passes it through to prisma.update', async () => {
    // Arrange: only action provided
    const newAction = { type: 'webhook', url: 'https://hooks.example.com/x' };
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiEventHook.findUnique).mockResolvedValue(makeHook() as never);
    vi.mocked(prisma.aiEventHook.update).mockResolvedValue(
      makeHook({ action: newAction }) as never
    );

    // Act
    const response = await UpdateHook(makePatchRequest({ action: newAction }), makeParams(HOOK_ID));

    // Assert: status 200, action propagated to DB, other fields absent
    expect(response.status).toBe(200);
    const updateCall = vi.mocked(prisma.aiEventHook.update).mock.calls[0][0];
    expect(updateCall.data).toEqual(expect.objectContaining({ action: newAction }));
    expect(updateCall.data).not.toHaveProperty('name');
    expect(updateCall.data).not.toHaveProperty('eventType');
    expect(updateCall.data).not.toHaveProperty('filter');
    expect(updateCall.data).not.toHaveProperty('isEnabled');
  });

  it('sets filter to an object and passes it through to prisma.update', async () => {
    // Arrange: filter is a non-null object (agentSlug selector)
    const filterValue = { agentSlug: 'support-bot' };
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiEventHook.findUnique).mockResolvedValue(makeHook() as never);
    vi.mocked(prisma.aiEventHook.update).mockResolvedValue(
      makeHook({ filter: filterValue }) as never
    );

    // Act
    const response = await UpdateHook(
      makePatchRequest({ filter: filterValue }),
      makeParams(HOOK_ID)
    );

    // Assert: status 200, filter propagated to DB with the object value
    expect(response.status).toBe(200);
    const updateCall = vi.mocked(prisma.aiEventHook.update).mock.calls[0][0];
    expect(updateCall.data).toEqual(expect.objectContaining({ filter: filterValue }));
    expect(updateCall.data).not.toHaveProperty('name');
    expect(updateCall.data).not.toHaveProperty('eventType');
    expect(updateCall.data).not.toHaveProperty('action');
    expect(updateCall.data).not.toHaveProperty('isEnabled');
  });

  it('sets filter to null (nullable clear) and passes null through to prisma.update', async () => {
    // Arrange: filter is explicitly null — clears any previously set filter
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiEventHook.findUnique).mockResolvedValue(
      makeHook({ filter: { agentSlug: 'old-bot' } }) as never
    );
    vi.mocked(prisma.aiEventHook.update).mockResolvedValue(makeHook({ filter: null }) as never);

    // Act
    const response = await UpdateHook(makePatchRequest({ filter: null }), makeParams(HOOK_ID));

    // Assert: status 200, null filter propagated to DB
    expect(response.status).toBe(200);
    const updateCall = vi.mocked(prisma.aiEventHook.update).mock.calls[0][0];
    expect(updateCall.data).toEqual(expect.objectContaining({ filter: null }));
    expect(updateCall.data).not.toHaveProperty('name');
    expect(updateCall.data).not.toHaveProperty('eventType');
    expect(updateCall.data).not.toHaveProperty('action');
    expect(updateCall.data).not.toHaveProperty('isEnabled');
  });

  it('calls invalidateHookCache after a successful update', async () => {
    // Arrange: happy-path PATCH
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiEventHook.findUnique).mockResolvedValue(makeHook() as never);
    vi.mocked(prisma.aiEventHook.update).mockResolvedValue(
      makeHook({ name: 'Cache Test' }) as never
    );

    // Act
    const response = await UpdateHook(
      makePatchRequest({ name: 'Cache Test' }),
      makeParams(HOOK_ID)
    );

    // Assert: cache invalidated exactly once after the successful update
    expect(response.status).toBe(200);
    expect(vi.mocked(invalidateHookCache)).toHaveBeenCalledTimes(1);
  });

  it('drops admin-supplied `secret` from PATCH body', async () => {
    // Arrange: body includes a `secret` field that must not reach the DB
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiEventHook.findUnique).mockResolvedValue(makeHook() as never);
    vi.mocked(prisma.aiEventHook.update).mockResolvedValue(makeHook() as never);

    // Act
    await UpdateHook(
      makePatchRequest({ name: 'still-no-secret', secret: 'sneaky' }),
      makeParams(HOOK_ID)
    );

    // Assert: secret was stripped before the DB write
    const updateCall = vi.mocked(prisma.aiEventHook.update).mock.calls[0]?.[0];
    expect(updateCall?.data).not.toHaveProperty('secret');
  });
});

describe('DELETE /hooks/:id', () => {
  it('deletes a hook', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiEventHook.findUnique).mockResolvedValue(makeHook() as never);
    vi.mocked(prisma.aiEventHook.delete).mockResolvedValue(makeHook() as never);

    const response = await DeleteHook(makeDeleteRequest(), makeParams(HOOK_ID));
    expect(response.status).toBe(200);

    const body = await parseJson<{ data: { deleted: boolean } }>(response);
    expect(body.data.deleted).toBe(true);
  });

  it('returns 404 when hook not found', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiEventHook.findUnique).mockResolvedValue(null);

    const response = await DeleteHook(makeDeleteRequest(), makeParams(HOOK_ID));
    expect(response.status).toBe(404);
  });

  it('returns 400 for invalid hook id on DELETE', async () => {
    // Arrange: non-CUID id
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    // Act
    const response = await DeleteHook(makeDeleteRequest(), makeParams('not-valid'));

    // Assert
    expect(response.status).toBe(400);
  });

  it('returns 429 when rate limited on DELETE', async () => {
    // Arrange: rate limit exceeded
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(adminLimiter.check).mockReturnValue({
      success: false,
      limit: 10,
      remaining: 0,
      reset: Date.now() + 60_000,
    } as never);

    // Act
    const response = await DeleteHook(makeDeleteRequest(), makeParams(HOOK_ID));

    // Assert
    expect(response.status).toBe(429);
  });

  it('calls invalidateHookCache after a successful delete', async () => {
    // Arrange: happy-path DELETE
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiEventHook.findUnique).mockResolvedValue(makeHook() as never);
    vi.mocked(prisma.aiEventHook.delete).mockResolvedValue(makeHook() as never);

    // Act
    const response = await DeleteHook(makeDeleteRequest(), makeParams(HOOK_ID));

    // Assert: cache invalidated exactly once after the successful delete
    expect(response.status).toBe(200);
    expect(vi.mocked(invalidateHookCache)).toHaveBeenCalledTimes(1);
  });
});
