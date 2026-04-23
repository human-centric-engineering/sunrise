/**
 * Tests: Event Hook Secret Rotation
 *
 * POST   /api/v1/admin/orchestration/hooks/:id/rotate-secret
 * DELETE /api/v1/admin/orchestration/hooks/:id/rotate-secret
 *
 * @see app/api/v1/admin/orchestration/hooks/[id]/rotate-secret/route.ts
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

vi.mock('@/lib/security/rate-limit', () => ({
  adminLimiter: { check: vi.fn(() => ({ success: true })) },
  createRateLimitResponse: vi.fn(() =>
    Response.json({ success: false, error: { code: 'RATE_LIMITED' } }, { status: 429 })
  ),
}));

vi.mock('@/lib/security/ip', () => ({
  getClientIP: vi.fn(() => '127.0.0.1'),
}));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiEventHook: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock('@/lib/orchestration/hooks/registry', () => ({
  invalidateHookCache: vi.fn(),
}));

vi.mock('@/lib/orchestration/hooks/signing', () => ({
  generateHookSecret: vi.fn(() => 'deadbeef'.repeat(8)),
}));

vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({
  logAdminAction: vi.fn(),
  computeChanges: vi.fn(() => null),
}));

// ─── Imports ────────────────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { adminLimiter } from '@/lib/security/rate-limit';
import { prisma } from '@/lib/db/client';
import { invalidateHookCache } from '@/lib/orchestration/hooks/registry';
import { generateHookSecret } from '@/lib/orchestration/hooks/signing';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';
import { POST, DELETE } from '@/app/api/v1/admin/orchestration/hooks/[id]/rotate-secret/route';

// ─── Helpers ────────────────────────────────────────────────────────────────

const VALID_ID = 'cmjbv4i3x00003wsloputgwu2';

function makePostRequest(): NextRequest {
  return new NextRequest(
    `http://localhost:3000/api/v1/admin/orchestration/hooks/${VALID_ID}/rotate-secret`,
    { method: 'POST' }
  );
}

function makeDeleteRequest(): NextRequest {
  return new NextRequest(
    `http://localhost:3000/api/v1/admin/orchestration/hooks/${VALID_ID}/rotate-secret`,
    { method: 'DELETE' }
  );
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

const EXISTING_HOOK_NO_SECRET = {
  id: VALID_ID,
  name: 'Test Hook',
  secret: null,
};

const EXISTING_HOOK_WITH_SECRET = {
  id: VALID_ID,
  name: 'Test Hook',
  secret: 'old-secret-abc',
};

// ─── POST tests ─────────────────────────────────────────────────────────────

describe('POST /api/v1/admin/orchestration/hooks/:id/rotate-secret', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
    vi.mocked(prisma.aiEventHook.findUnique).mockResolvedValue(EXISTING_HOOK_NO_SECRET as never);
    vi.mocked(prisma.aiEventHook.update).mockResolvedValue({
      id: VALID_ID,
      updatedAt: new Date('2026-04-23T00:00:00Z'),
    } as never);
  });

  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());
    const response = await POST(makePostRequest(), makeParams(VALID_ID));
    expect(response.status).toBe(401);
  });

  it('returns 403 for non-admin users', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));
    const response = await POST(makePostRequest(), makeParams(VALID_ID));
    expect(response.status).toBe(403);
  });

  it('returns 429 when rate limit exceeded', async () => {
    vi.mocked(adminLimiter.check).mockReturnValue({
      success: false,
      limit: 30,
      remaining: 0,
      reset: Date.now() + 60_000,
    } as never);
    const response = await POST(makePostRequest(), makeParams(VALID_ID));
    expect(response.status).toBe(429);
  });

  it('returns 400 for a non-CUID id', async () => {
    const response = await POST(makePostRequest(), makeParams('not-a-cuid'));
    expect(response.status).toBe(400);
  });

  it('returns 404 when hook not found', async () => {
    vi.mocked(prisma.aiEventHook.findUnique).mockResolvedValue(null);
    const response = await POST(makePostRequest(), makeParams(VALID_ID));
    expect(response.status).toBe(404);
  });

  it('returns a fresh secret on success', async () => {
    const response = await POST(makePostRequest(), makeParams(VALID_ID));
    const body = await parseJson<{
      success: boolean;
      data: { id: string; secret: string; rotatedAt: string };
    }>(response);

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.id).toBe(VALID_ID);
    expect(body.data.secret).toBe('deadbeef'.repeat(8));
    expect(generateHookSecret).toHaveBeenCalledTimes(1);
  });

  it('persists the generated secret', async () => {
    await POST(makePostRequest(), makeParams(VALID_ID));

    const updateCall = vi.mocked(prisma.aiEventHook.update).mock.calls[0]?.[0];
    expect(updateCall?.where).toEqual({ id: VALID_ID });
    expect(updateCall?.data).toMatchObject({ secret: 'deadbeef'.repeat(8) });
  });

  it('invalidates the hook cache after rotation', async () => {
    await POST(makePostRequest(), makeParams(VALID_ID));
    expect(invalidateHookCache).toHaveBeenCalledTimes(1);
  });

  it('audit-logs hook.secret.rotated with hadPrevious=false when no prior secret', async () => {
    vi.mocked(prisma.aiEventHook.findUnique).mockResolvedValue(EXISTING_HOOK_NO_SECRET as never);

    await POST(makePostRequest(), makeParams(VALID_ID));

    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'hook.secret.rotated',
        entityType: 'webhook',
        entityId: VALID_ID,
        metadata: { hadPrevious: false },
      })
    );
  });

  it('audit-logs hook.secret.rotated with hadPrevious=true when rotating an existing secret', async () => {
    vi.mocked(prisma.aiEventHook.findUnique).mockResolvedValue(EXISTING_HOOK_WITH_SECRET as never);

    await POST(makePostRequest(), makeParams(VALID_ID));

    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'hook.secret.rotated',
        metadata: { hadPrevious: true },
      })
    );
  });
});

// ─── DELETE tests ───────────────────────────────────────────────────────────

describe('DELETE /api/v1/admin/orchestration/hooks/:id/rotate-secret', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
    vi.mocked(prisma.aiEventHook.findUnique).mockResolvedValue(EXISTING_HOOK_WITH_SECRET as never);
    vi.mocked(prisma.aiEventHook.update).mockResolvedValue({ id: VALID_ID } as never);
  });

  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());
    const response = await DELETE(makeDeleteRequest(), makeParams(VALID_ID));
    expect(response.status).toBe(401);
  });

  it('returns 404 when hook not found', async () => {
    vi.mocked(prisma.aiEventHook.findUnique).mockResolvedValue(null);
    const response = await DELETE(makeDeleteRequest(), makeParams(VALID_ID));
    expect(response.status).toBe(404);
  });

  it('clears an existing secret and returns cleared=true', async () => {
    const response = await DELETE(makeDeleteRequest(), makeParams(VALID_ID));
    const body = await parseJson<{ data: { cleared: boolean } }>(response);

    expect(response.status).toBe(200);
    expect(body.data.cleared).toBe(true);
    const updateCall = vi.mocked(prisma.aiEventHook.update).mock.calls[0]?.[0];
    expect(updateCall?.data).toMatchObject({ secret: null });
    expect(invalidateHookCache).toHaveBeenCalledTimes(1);
  });

  it('is idempotent when no secret is set — returns cleared=false and skips the DB write', async () => {
    vi.mocked(prisma.aiEventHook.findUnique).mockResolvedValue(EXISTING_HOOK_NO_SECRET as never);

    const response = await DELETE(makeDeleteRequest(), makeParams(VALID_ID));
    const body = await parseJson<{ data: { cleared: boolean } }>(response);

    expect(response.status).toBe(200);
    expect(body.data.cleared).toBe(false);
    expect(prisma.aiEventHook.update).not.toHaveBeenCalled();
    expect(invalidateHookCache).not.toHaveBeenCalled();
  });

  it('audit-logs hook.secret.cleared on successful clear', async () => {
    await DELETE(makeDeleteRequest(), makeParams(VALID_ID));

    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'hook.secret.cleared',
        entityType: 'webhook',
        entityId: VALID_ID,
      })
    );
  });

  it('does not audit-log the no-op idempotent clear', async () => {
    vi.mocked(prisma.aiEventHook.findUnique).mockResolvedValue(EXISTING_HOOK_NO_SECRET as never);

    await DELETE(makeDeleteRequest(), makeParams(VALID_ID));
    expect(logAdminAction).not.toHaveBeenCalled();
  });

  it('returns 429 when rate limit exceeded', async () => {
    // Arrange: rate limit exceeded
    vi.mocked(adminLimiter.check).mockReturnValue({
      success: false,
      limit: 30,
      remaining: 0,
      reset: Date.now() + 60_000,
    } as never);

    // Act
    const response = await DELETE(makeDeleteRequest(), makeParams(VALID_ID));

    // Assert
    expect(response.status).toBe(429);
  });

  it('returns 400 for a non-CUID id', async () => {
    // Act
    const response = await DELETE(makeDeleteRequest(), makeParams('not-a-cuid'));

    // Assert
    expect(response.status).toBe(400);
  });
});
