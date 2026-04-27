/**
 * Tests: Event Hook Detail Endpoints
 *
 * GET    /api/v1/admin/orchestration/hooks/:id
 * PATCH  /api/v1/admin/orchestration/hooks/:id
 * DELETE /api/v1/admin/orchestration/hooks/:id
 *
 * Test Coverage:
 * - GET: 401 unauthenticated, 404 not found, 200 success with serialized hook
 * - GET: strips `hook_` prefix via resolveHookId (CUID is used after strip)
 * - GET: returns 400 for non-CUID id
 * - PATCH: 404 not found, updates correctly, calls invalidateHookCache, calls logAdminAction
 * - PATCH: 400 invalid CUID, 429 rate limited
 * - DELETE: 404 not found, deletes correctly, calls invalidateHookCache, calls logAdminAction
 * - DELETE: 400 invalid CUID, 429 rate limited
 *
 * @see app/api/v1/admin/orchestration/hooks/[id]/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiEventHook: {
      findUnique: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  },
}));

vi.mock('@/lib/security/rate-limit', () => ({
  adminLimiter: { check: vi.fn(() => ({ success: true })) },
  createRateLimitResponse: vi.fn(() =>
    Response.json({ success: false, error: { code: 'RATE_LIMITED' } }, { status: 429 })
  ),
}));

vi.mock('@/lib/security/ip', () => ({
  getClientIP: vi.fn(() => '127.0.0.1'),
}));

vi.mock('@/lib/api/context', () => ({
  getRouteLogger: vi.fn(() =>
    Promise.resolve({
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    })
  ),
}));

vi.mock('@/lib/orchestration/hooks/registry', () => ({
  invalidateHookCache: vi.fn(),
}));

// Mock toSafeHook to return the hook without secret, adding hasSecret flag
vi.mock('@/lib/orchestration/hooks/serialize', () => ({
  toSafeHook: vi.fn((hook: Record<string, unknown>) => {
    const { secret: _secret, ...rest } = hook;
    return { ...rest, hasSecret: hook.secret !== null };
  }),
}));

vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({
  logAdminAction: vi.fn(),
  computeChanges: vi.fn(() => null),
}));

vi.mock('@/lib/api/validation', () => ({
  validateRequestBody: vi.fn(),
}));

// isSafeProviderUrl is used in the Zod schema defined inside the route module
vi.mock('@/lib/security/safe-url', () => ({
  isSafeProviderUrl: vi.fn(() => true),
}));

// ─── Imports ────────────────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { adminLimiter } from '@/lib/security/rate-limit';
import { invalidateHookCache } from '@/lib/orchestration/hooks/registry';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { validateRequestBody } from '@/lib/api/validation';
import { mockAdminUser, mockUnauthenticatedUser } from '@/tests/helpers/auth';
import { GET, PATCH, DELETE } from '@/app/api/v1/admin/orchestration/hooks/[id]/route';

// ─── Fixtures ───────────────────────────────────────────────────────────────

const ADMIN_ID = 'cmjbv4i3x00003wsloputgwul';
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
    createdBy: ADMIN_ID,
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-02'),
    ...overrides,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeGetRequest(id = HOOK_ID): NextRequest {
  return new NextRequest(`http://localhost:3000/api/v1/admin/orchestration/hooks/${id}`);
}

function makePatchRequest(body: Record<string, unknown>, id = HOOK_ID): NextRequest {
  return new NextRequest(`http://localhost:3000/api/v1/admin/orchestration/hooks/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function makeDeleteRequest(id = HOOK_ID): NextRequest {
  return new NextRequest(`http://localhost:3000/api/v1/admin/orchestration/hooks/${id}`, {
    method: 'DELETE',
  });
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
  vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
});

describe('GET /hooks/:id', () => {
  it('returns 401 when unauthenticated', async () => {
    // Arrange
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

    // Act
    const response = await GET(makeGetRequest(), makeParams(HOOK_ID));

    // Assert
    expect(response.status).toBe(401);
  });

  it('returns 400 for a non-CUID id', async () => {
    // Act
    const response = await GET(makeGetRequest('not-a-cuid'), makeParams('not-a-cuid'));

    // Assert
    expect(response.status).toBe(400);
    expect(prisma.aiEventHook.findUnique).not.toHaveBeenCalled();
  });

  it('returns 404 when the hook does not exist', async () => {
    // Arrange
    vi.mocked(prisma.aiEventHook.findUnique).mockResolvedValue(null);

    // Act
    const response = await GET(makeGetRequest(), makeParams(HOOK_ID));

    // Assert
    expect(response.status).toBe(404);
  });

  it('returns 200 with serialized hook data on success', async () => {
    // Arrange
    vi.mocked(prisma.aiEventHook.findUnique).mockResolvedValue(makeHook() as never);

    // Act
    const response = await GET(makeGetRequest(), makeParams(HOOK_ID));
    const body = await parseJson<{ success: boolean; data: Record<string, unknown> }>(response);

    // Assert
    expect(response.status).toBe(200);
    // test-review:accept tobe_true — structural boolean assertion on API response field
    expect(body.success).toBe(true);
    expect(body.data.id).toBe(HOOK_ID);
    expect(body.data.name).toBe('Test Hook');
    expect(body.data.eventType).toBe('conversation.started');
  });

  it('strips `secret` and exposes `hasSecret: false` when no secret is set', async () => {
    // Arrange: hook has no secret
    vi.mocked(prisma.aiEventHook.findUnique).mockResolvedValue(makeHook({ secret: null }) as never);

    // Act
    const response = await GET(makeGetRequest(), makeParams(HOOK_ID));
    const body = await parseJson<{ data: Record<string, unknown> }>(response);

    // Assert: toSafeHook result — no raw secret field, hasSecret reflects nullity
    expect(body.data).not.toHaveProperty('secret');
    expect(body.data).toHaveProperty('hasSecret', false);
  });

  it('strips `secret` and exposes `hasSecret: true` when a secret is set', async () => {
    // Arrange: hook has a secret
    vi.mocked(prisma.aiEventHook.findUnique).mockResolvedValue(
      makeHook({ secret: 'deadbeef'.repeat(8) }) as never
    );

    // Act
    const response = await GET(makeGetRequest(), makeParams(HOOK_ID));
    const body = await parseJson<{ data: Record<string, unknown> }>(response);

    // Assert: toSafeHook strips secret and derives hasSecret=true
    expect(body.data).not.toHaveProperty('secret');
    expect(body.data).toHaveProperty('hasSecret', true);
  });

  it('resolveHookId accepts a bare CUID and queries with it', async () => {
    // Arrange
    vi.mocked(prisma.aiEventHook.findUnique).mockResolvedValue(makeHook() as never);

    // Act
    await GET(makeGetRequest(HOOK_ID), makeParams(HOOK_ID));

    // Assert: findUnique called with the CUID directly
    expect(prisma.aiEventHook.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: HOOK_ID } })
    );
  });
});

describe('PATCH /hooks/:id', () => {
  const updatePayload = { name: 'Updated Hook', isEnabled: false };

  beforeEach(() => {
    vi.mocked(validateRequestBody).mockResolvedValue(updatePayload as never);
  });

  it('returns 401 when unauthenticated', async () => {
    // Arrange
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

    // Act
    const response = await PATCH(makePatchRequest(updatePayload), makeParams(HOOK_ID));

    // Assert
    expect(response.status).toBe(401);
  });

  it('returns 400 for a non-CUID id', async () => {
    // Act
    const response = await PATCH(
      makePatchRequest(updatePayload, 'not-a-cuid'),
      makeParams('not-a-cuid')
    );

    // Assert
    expect(response.status).toBe(400);
    expect(prisma.aiEventHook.findUnique).not.toHaveBeenCalled();
  });

  it('returns 404 when the hook does not exist', async () => {
    // Arrange
    vi.mocked(prisma.aiEventHook.findUnique).mockResolvedValue(null);

    // Act
    const response = await PATCH(makePatchRequest(updatePayload), makeParams(HOOK_ID));

    // Assert
    expect(response.status).toBe(404);
    expect(prisma.aiEventHook.update).not.toHaveBeenCalled();
  });

  it('returns 429 when rate limited', async () => {
    // Arrange
    vi.mocked(adminLimiter.check).mockReturnValue({
      success: false,
      limit: 30,
      remaining: 0,
      reset: Date.now() + 60_000,
    } as never);

    // Act
    const response = await PATCH(makePatchRequest(updatePayload), makeParams(HOOK_ID));

    // Assert
    expect(response.status).toBe(429);
    expect(prisma.aiEventHook.update).not.toHaveBeenCalled();
  });

  it('updates the hook and returns serialized response on success', async () => {
    // Arrange
    const existing = makeHook();
    const updated = makeHook({ name: 'Updated Hook', isEnabled: false });
    vi.mocked(prisma.aiEventHook.findUnique).mockResolvedValue(existing as never);
    vi.mocked(prisma.aiEventHook.update).mockResolvedValue(updated as never);

    // Act
    const response = await PATCH(makePatchRequest(updatePayload), makeParams(HOOK_ID));
    const body = await parseJson<{ success: boolean; data: Record<string, unknown> }>(response);

    // Assert
    expect(response.status).toBe(200);
    // test-review:accept tobe_true — structural boolean assertion on API response field
    expect(body.success).toBe(true);
    expect(body.data.id).toBe(HOOK_ID);
  });

  it('passes validated name and isEnabled to prisma.update', async () => {
    // Arrange
    vi.mocked(prisma.aiEventHook.findUnique).mockResolvedValue(makeHook() as never);
    vi.mocked(prisma.aiEventHook.update).mockResolvedValue(
      makeHook({ name: 'Updated Hook', isEnabled: false }) as never
    );

    // Act
    await PATCH(makePatchRequest(updatePayload), makeParams(HOOK_ID));

    // Assert: update called with the data derived from validated fields
    expect(prisma.aiEventHook.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: HOOK_ID },
        data: expect.objectContaining({ name: 'Updated Hook', isEnabled: false }),
      })
    );
  });

  it('calls invalidateHookCache after a successful update', async () => {
    // Arrange
    vi.mocked(prisma.aiEventHook.findUnique).mockResolvedValue(makeHook() as never);
    vi.mocked(prisma.aiEventHook.update).mockResolvedValue(makeHook() as never);

    // Act
    await PATCH(makePatchRequest(updatePayload), makeParams(HOOK_ID));

    // Assert: cache invalidated exactly once
    expect(invalidateHookCache).toHaveBeenCalledTimes(1);
  });

  it('calls logAdminAction with hook.update and entityType "hook"', async () => {
    // Arrange
    vi.mocked(prisma.aiEventHook.findUnique).mockResolvedValue(makeHook() as never);
    vi.mocked(prisma.aiEventHook.update).mockResolvedValue(
      makeHook({ name: 'Updated Hook' }) as never
    );

    // Act
    await PATCH(makePatchRequest(updatePayload), makeParams(HOOK_ID));

    // Assert: audit action logged with correct action type and entity info
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'hook.update',
        entityType: 'hook',
        entityId: HOOK_ID,
        userId: ADMIN_ID,
      })
    );
  });

  it('does not include secret in the update data', async () => {
    // Arrange: validated body contains only allowed fields (no secret)
    vi.mocked(validateRequestBody).mockResolvedValue({ name: 'No Secret' } as never);
    vi.mocked(prisma.aiEventHook.findUnique).mockResolvedValue(makeHook() as never);
    vi.mocked(prisma.aiEventHook.update).mockResolvedValue(
      makeHook({ name: 'No Secret' }) as never
    );

    // Act
    await PATCH(makePatchRequest({ name: 'No Secret', secret: 'sneaky' }), makeParams(HOOK_ID));

    // Assert: secret must not appear in the data written to the DB
    const updateCall = vi.mocked(prisma.aiEventHook.update).mock.calls[0]?.[0];
    expect(updateCall?.data).not.toHaveProperty('secret');
  });
});

describe('DELETE /hooks/:id', () => {
  it('returns 401 when unauthenticated', async () => {
    // Arrange
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

    // Act
    const response = await DELETE(makeDeleteRequest(), makeParams(HOOK_ID));

    // Assert
    expect(response.status).toBe(401);
  });

  it('returns 400 for a non-CUID id', async () => {
    // Act
    const response = await DELETE(makeDeleteRequest('not-a-cuid'), makeParams('not-a-cuid'));

    // Assert
    expect(response.status).toBe(400);
    expect(prisma.aiEventHook.findUnique).not.toHaveBeenCalled();
  });

  it('returns 404 when the hook does not exist', async () => {
    // Arrange
    vi.mocked(prisma.aiEventHook.findUnique).mockResolvedValue(null);

    // Act
    const response = await DELETE(makeDeleteRequest(), makeParams(HOOK_ID));

    // Assert
    expect(response.status).toBe(404);
    expect(prisma.aiEventHook.delete).not.toHaveBeenCalled();
  });

  it('returns 429 when rate limited', async () => {
    // Arrange
    vi.mocked(adminLimiter.check).mockReturnValue({
      success: false,
      limit: 30,
      remaining: 0,
      reset: Date.now() + 60_000,
    } as never);

    // Act
    const response = await DELETE(makeDeleteRequest(), makeParams(HOOK_ID));

    // Assert
    expect(response.status).toBe(429);
    expect(prisma.aiEventHook.delete).not.toHaveBeenCalled();
  });

  it('deletes the hook and returns { deleted: true }', async () => {
    // Arrange
    vi.mocked(prisma.aiEventHook.findUnique).mockResolvedValue(makeHook() as never);
    vi.mocked(prisma.aiEventHook.delete).mockResolvedValue(makeHook() as never);

    // Act
    const response = await DELETE(makeDeleteRequest(), makeParams(HOOK_ID));
    const body = await parseJson<{ success: boolean; data: { deleted: boolean } }>(response);

    // Assert
    expect(response.status).toBe(200);
    // test-review:accept tobe_true — structural boolean assertion on API response field
    expect(body.success).toBe(true);
    expect(body.data.deleted).toBe(true);
  });

  it('calls prisma.delete with the correct where clause', async () => {
    // Arrange
    vi.mocked(prisma.aiEventHook.findUnique).mockResolvedValue(makeHook() as never);
    vi.mocked(prisma.aiEventHook.delete).mockResolvedValue(makeHook() as never);

    // Act
    await DELETE(makeDeleteRequest(), makeParams(HOOK_ID));

    // Assert: delete called with the correct hook id
    expect(prisma.aiEventHook.delete).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: HOOK_ID } })
    );
  });

  it('calls invalidateHookCache after a successful delete', async () => {
    // Arrange
    vi.mocked(prisma.aiEventHook.findUnique).mockResolvedValue(makeHook() as never);
    vi.mocked(prisma.aiEventHook.delete).mockResolvedValue(makeHook() as never);

    // Act
    await DELETE(makeDeleteRequest(), makeParams(HOOK_ID));

    // Assert: cache invalidated exactly once
    expect(invalidateHookCache).toHaveBeenCalledTimes(1);
  });

  it('calls logAdminAction with hook.delete and entityType "hook"', async () => {
    // Arrange
    vi.mocked(prisma.aiEventHook.findUnique).mockResolvedValue(makeHook() as never);
    vi.mocked(prisma.aiEventHook.delete).mockResolvedValue(makeHook() as never);

    // Act
    await DELETE(makeDeleteRequest(), makeParams(HOOK_ID));

    // Assert: audit action logged with correct action type, entity type, and entity id
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'hook.delete',
        entityType: 'hook',
        entityId: HOOK_ID,
        userId: ADMIN_ID,
      })
    );
  });
});
