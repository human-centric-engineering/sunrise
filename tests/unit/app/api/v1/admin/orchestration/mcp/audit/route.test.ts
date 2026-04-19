/**
 * Tests: MCP Audit Log Endpoints
 *
 * GET    /api/v1/admin/orchestration/mcp/audit — query audit logs with filters
 * DELETE /api/v1/admin/orchestration/mcp/audit — purge logs older than retention period
 *
 * Test Coverage:
 * - Authentication (401 for unauthenticated, 403 for non-admin)
 * - GET: returns paginated audit logs
 * - GET: passes filters to queryMcpAuditLogs
 * - DELETE: skips purge when auditRetentionDays is 0
 * - DELETE: purges logs older than retention cutoff
 * - Rate limiting (429 when limit exceeded)
 *
 * @see app/api/v1/admin/orchestration/mcp/audit/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

// ─── Module mocks ────────────────────────────────────────────────────────────

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    mcpAuditLog: {
      deleteMany: vi.fn(),
    },
  },
}));

vi.mock('@/lib/security/rate-limit', () => ({
  adminLimiter: { check: vi.fn(() => ({ success: true })) },
  createRateLimitResponse: vi.fn(
    () => new Response(JSON.stringify({ error: 'rate limited' }), { status: 429 })
  ),
}));

vi.mock('@/lib/security/ip', () => ({
  getClientIP: vi.fn(() => '127.0.0.1'),
}));

vi.mock('@/lib/api/context', () => ({
  getRouteLogger: vi.fn(() => Promise.resolve({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
}));

vi.mock('@/lib/orchestration/mcp', () => ({
  queryMcpAuditLogs: vi.fn(),
  getMcpServerConfig: vi.fn(),
}));

// ─── Imports ─────────────────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { queryMcpAuditLogs, getMcpServerConfig } from '@/lib/orchestration/mcp';
import {
  mockAdminUser,
  mockUnauthenticatedUser,
  mockAuthenticatedUser,
} from '@/tests/helpers/auth';
import { GET, DELETE } from '@/app/api/v1/admin/orchestration/mcp/audit/route';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeAuditLog(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cmjbv4i3x00003wsloputgwu1',
    apiKeyId: 'cmjbv4i3x00003wsloputgwu2',
    method: 'tools/call',
    toolSlug: 'search_knowledge',
    resourceUri: null,
    responseCode: 'success',
    errorMessage: null,
    durationMs: 120,
    clientIp: '127.0.0.1',
    userAgent: 'MCP-Client/1.0',
    createdAt: new Date('2025-01-01'),
    ...overrides,
  };
}

function makeMcpConfig(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cmjbv4i3x00003wsloputgwu3',
    slug: 'global',
    isEnabled: true,
    serverName: 'Sunrise MCP Server',
    serverVersion: '1.0.0',
    maxSessionsPerKey: 5,
    globalRateLimit: 60,
    auditRetentionDays: 90,
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    ...overrides,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeGetRequest(params: Record<string, string> = {}): NextRequest {
  const url = new URL('http://localhost:3000/api/v1/admin/orchestration/mcp/audit');
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  return new NextRequest(url);
}

function makeDeleteRequest(): NextRequest {
  return new NextRequest('http://localhost:3000/api/v1/admin/orchestration/mcp/audit', {
    method: 'DELETE',
  });
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  // Restore default rate limit behaviour after any test that overrides it
  vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
});

describe('GET /mcp/audit', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

    const response = await GET(makeGetRequest());

    expect(response.status).toBe(401);
  });

  it('returns 403 when authenticated as non-admin', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

    const response = await GET(makeGetRequest());

    expect(response.status).toBe(403);
  });

  it('returns 429 when rate limit exceeded', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(adminLimiter.check).mockReturnValue({ success: false } as never);

    const response = await GET(makeGetRequest());

    expect(createRateLimitResponse).toHaveBeenCalled();
    expect(response.status).toBe(429);
  });

  it('returns paginated audit logs', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(queryMcpAuditLogs).mockResolvedValue({
      items: [makeAuditLog()],
      total: 1,
    });

    const response = await GET(makeGetRequest());

    expect(response.status).toBe(200);
    const body = await parseJson<{ data: unknown[]; meta: { total: number } }>(response);
    expect(body.data).toHaveLength(1);
    expect(body.meta.total).toBe(1);
  });

  it('passes method filter to queryMcpAuditLogs', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(queryMcpAuditLogs).mockResolvedValue({ items: [], total: 0 });

    await GET(makeGetRequest({ method: 'tools/call' }));

    expect(queryMcpAuditLogs).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'tools/call' })
    );
  });

  it('passes responseCode filter to queryMcpAuditLogs', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(queryMcpAuditLogs).mockResolvedValue({ items: [], total: 0 });

    await GET(makeGetRequest({ responseCode: 'error' }));

    expect(queryMcpAuditLogs).toHaveBeenCalledWith(
      expect.objectContaining({ responseCode: 'error' })
    );
  });

  it('returns empty list when no logs exist', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(queryMcpAuditLogs).mockResolvedValue({ items: [], total: 0 });

    const response = await GET(makeGetRequest());

    expect(response.status).toBe(200);
    const body = await parseJson<{ data: unknown[]; meta: { total: number } }>(response);
    expect(body.data).toHaveLength(0);
    expect(body.meta.total).toBe(0);
  });
});

describe('DELETE /mcp/audit', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

    const response = await DELETE(makeDeleteRequest());

    expect(response.status).toBe(401);
  });

  it('returns 403 when authenticated as non-admin', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

    const response = await DELETE(makeDeleteRequest());

    expect(response.status).toBe(403);
  });

  it('returns 429 when rate limit exceeded', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(adminLimiter.check).mockReturnValue({ success: false } as never);

    const response = await DELETE(makeDeleteRequest());

    expect(createRateLimitResponse).toHaveBeenCalled();
    expect(response.status).toBe(429);
  });

  it('skips purge and returns deleted:0 when auditRetentionDays is 0', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(getMcpServerConfig).mockResolvedValue(
      makeMcpConfig({ auditRetentionDays: 0 }) as never
    );

    const response = await DELETE(makeDeleteRequest());

    expect(response.status).toBe(200);
    const body = await parseJson<{ data: { deleted: number; message: string } }>(response);
    expect(body.data.deleted).toBe(0);
    expect(body.data.message).toContain('keep forever');
    expect(prisma.mcpAuditLog.deleteMany).not.toHaveBeenCalled();
  });

  it('purges logs older than retention cutoff', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(getMcpServerConfig).mockResolvedValue(
      makeMcpConfig({ auditRetentionDays: 30 }) as never
    );
    vi.mocked(prisma.mcpAuditLog.deleteMany).mockResolvedValue({ count: 5 });

    const response = await DELETE(makeDeleteRequest());

    expect(response.status).toBe(200);
    expect(prisma.mcpAuditLog.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { createdAt: { lt: expect.any(Date) } },
      })
    );
    const body = await parseJson<{ data: { deleted: number; retentionDays: number } }>(response);
    expect(body.data.deleted).toBe(5);
    expect(body.data.retentionDays).toBe(30);
  });

  it('returns cutoff ISO string in response', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(getMcpServerConfig).mockResolvedValue(
      makeMcpConfig({ auditRetentionDays: 90 }) as never
    );
    vi.mocked(prisma.mcpAuditLog.deleteMany).mockResolvedValue({ count: 0 });

    const response = await DELETE(makeDeleteRequest());

    const body = await parseJson<{ data: { cutoff: string } }>(response);
    expect(body.data.cutoff).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
