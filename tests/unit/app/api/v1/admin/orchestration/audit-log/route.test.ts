/**
 * Tests: Admin Orchestration — Audit Log
 *
 * GET /api/v1/admin/orchestration/audit-log
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
    aiAdminAuditLog: {
      findMany: vi.fn(),
      count: vi.fn(),
    },
  },
}));

vi.mock('@/lib/security/rate-limit', () => ({
  adminLimiter: {
    check: vi.fn(() => ({ success: true, limit: 100, remaining: 99, reset: 0 })),
  },
  createRateLimitResponse: vi.fn(),
}));

// ─── Imports ────────────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { mockAdminUser, mockUnauthenticatedUser } from '@/tests/helpers/auth';
import { GET } from '@/app/api/v1/admin/orchestration/audit-log/route';

// ─── Fixtures ───────────────────────────────────────────────────────────

function makeEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: 'entry-1',
    userId: 'user-1',
    action: 'agent.create',
    entityType: 'agent',
    entityId: 'agent-1',
    entityName: 'Support Bot',
    changes: null,
    metadata: null,
    clientIp: '127.0.0.1',
    createdAt: new Date('2026-01-15T10:00:00.000Z'),
    user: { id: 'user-1', name: 'Alice', email: 'alice@example.com' },
    ...overrides,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────

function makeRequest(query = ''): NextRequest {
  return new NextRequest(
    `http://localhost:3000/api/v1/admin/orchestration/audit-log${query ? `?${query}` : ''}`
  );
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests ──────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.aiAdminAuditLog.findMany).mockResolvedValue([]);
  vi.mocked(prisma.aiAdminAuditLog.count).mockResolvedValue(0);
});

describe('GET /audit-log', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

    const response = await GET(makeRequest());

    expect(response.status).toBe(401);
  });

  it('returns 403 when user is not admin', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue({
      session: {
        id: 'session_1',
        userId: 'user_1',
        token: 'tok',
        expiresAt: new Date(Date.now() + 86400000),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      user: {
        id: 'user_1',
        name: 'Regular User',
        email: 'user@example.com',
        emailVerified: true,
        image: null,
        role: 'USER' as const,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

    const response = await GET(makeRequest());

    expect(response.status).toBe(403);
  });

  it('returns 200 with paginated audit entries', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiAdminAuditLog.findMany).mockResolvedValue([makeEntry()] as never);
    vi.mocked(prisma.aiAdminAuditLog.count).mockResolvedValue(1);

    const response = await GET(makeRequest());

    expect(response.status).toBe(200);
    const body = await parseJson<{ success: boolean; data: unknown[]; meta: unknown }>(response);
    expect(body.success).toBe(true);
    expect(body.data).toHaveLength(1);
  });

  it('returns empty list when no entries exist', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    const response = await GET(makeRequest());

    expect(response.status).toBe(200);
    const body = await parseJson<{ data: unknown[] }>(response);
    expect(body.data).toHaveLength(0);
  });

  it('passes action filter to Prisma where clause', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    await GET(makeRequest('action=agent.create'));

    expect(prisma.aiAdminAuditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ action: 'agent.create' }),
      })
    );
  });

  it('passes entityType filter to Prisma where clause', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    await GET(makeRequest('entityType=agent'));

    expect(prisma.aiAdminAuditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ entityType: 'agent' }),
      })
    );
  });

  it('applies pagination with page and limit params', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    await GET(makeRequest('page=2&limit=10'));

    expect(prisma.aiAdminAuditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 10, take: 10 })
    );
  });

  it('includes user relation in results', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    await GET(makeRequest());

    expect(prisma.aiAdminAuditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          user: expect.any(Object),
        }),
      })
    );
  });

  it('orders results by createdAt descending', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    await GET(makeRequest());

    expect(prisma.aiAdminAuditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: { createdAt: 'desc' },
      })
    );
  });

  it('returns meta with total count', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiAdminAuditLog.count).mockResolvedValue(42);

    const response = await GET(makeRequest());

    const body = await parseJson<{ meta: { total: number } }>(response);
    expect(body.meta).toMatchObject({ total: 42 });
  });

  it('passes entityId filter to Prisma where clause', async () => {
    // Arrange
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    // Act
    await GET(makeRequest('entityId=agent-42'));

    // Assert — route must pass entityId into the where object
    expect(prisma.aiAdminAuditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ entityId: 'agent-42' }),
      })
    );
  });

  it('passes userId filter to Prisma where clause', async () => {
    // Arrange
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    // Act
    await GET(makeRequest('userId=user-99'));

    // Assert — route must pass userId into the where object
    expect(prisma.aiAdminAuditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: 'user-99' }),
      })
    );
  });

  it('sets createdAt.gte when only dateFrom is provided', async () => {
    // Arrange
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    // Act — dateFrom only; dateTo absent so lte must not be set
    await GET(makeRequest('dateFrom=2026-01-01'));

    // Assert — gte is set, lte is NOT set on the where clause
    const callArg = vi.mocked(prisma.aiAdminAuditLog.findMany).mock.calls[0]?.[0];
    expect(callArg).toBeDefined();
    expect(callArg?.where?.createdAt).toBeDefined();
    const createdAt = callArg?.where?.createdAt as Record<string, unknown>;
    expect(createdAt['gte']).toEqual(new Date('2026-01-01'));
    expect(createdAt['lte']).toBeUndefined();
  });

  it('sets createdAt.lte when only dateTo is provided', async () => {
    // Arrange
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    // Act — dateTo only; dateFrom absent so gte must not be set
    await GET(makeRequest('dateTo=2026-12-31'));

    // Assert — lte is set, gte is NOT set on the where clause
    const callArg = vi.mocked(prisma.aiAdminAuditLog.findMany).mock.calls[0]?.[0];
    expect(callArg).toBeDefined();
    expect(callArg?.where?.createdAt).toBeDefined();
    const createdAt = callArg?.where?.createdAt as Record<string, unknown>;
    expect(createdAt['lte']).toEqual(new Date('2026-12-31'));
    expect(createdAt['gte']).toBeUndefined();
  });

  it('sets both createdAt.gte and createdAt.lte when dateFrom and dateTo are both provided', async () => {
    // Arrange
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    // Act — both bounds present
    await GET(makeRequest('dateFrom=2026-01-01&dateTo=2026-12-31'));

    // Assert — both gte and lte are set
    const callArg = vi.mocked(prisma.aiAdminAuditLog.findMany).mock.calls[0]?.[0];
    expect(callArg).toBeDefined();
    expect(callArg?.where?.createdAt).toBeDefined();
    const createdAt = callArg?.where?.createdAt as Record<string, unknown>;
    expect(createdAt['gte']).toEqual(new Date('2026-01-01'));
    expect(createdAt['lte']).toEqual(new Date('2026-12-31'));
  });

  it('returns 429 when rate limited', async () => {
    const { adminLimiter, createRateLimitResponse } = await import('@/lib/security/rate-limit');
    vi.mocked(adminLimiter.check).mockReturnValue({
      success: false,
      limit: 100,
      remaining: 0,
      reset: Date.now() + 60_000,
    });
    vi.mocked(createRateLimitResponse).mockReturnValue(
      new Response(null, { status: 429 }) as never
    );
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    const response = await GET(makeRequest());

    expect(response.status).toBe(429);
  });

  it('allows the request through when rate limiter reports success', async () => {
    const { adminLimiter } = await import('@/lib/security/rate-limit');
    vi.mocked(adminLimiter.check).mockReturnValue({
      success: true,
      limit: 100,
      remaining: 99,
      reset: Date.now() + 60_000,
    });
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    const response = await GET(makeRequest());

    expect(response.status).toBe(200);
  });
});
