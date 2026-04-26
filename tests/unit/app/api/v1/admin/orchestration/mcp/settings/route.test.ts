/**
 * Tests: MCP Settings Singleton Endpoints
 *
 * GET   /api/v1/admin/orchestration/mcp/settings — read MCP server config
 * PATCH /api/v1/admin/orchestration/mcp/settings — partial update
 *
 * Test Coverage:
 * - Authentication (401/403 guards)
 * - GET: returns current MCP server config
 * - PATCH: upserts settings with provided fields
 * - PATCH: invalidates config cache after update
 * - PATCH: rejects empty body (at least one field required)
 * - PATCH: rejects out-of-range values
 * - Rate limiting (429 when limit exceeded)
 *
 * @see app/api/v1/admin/orchestration/mcp/settings/route.ts
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
    mcpServerConfig: {
      upsert: vi.fn(),
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
  getMcpServerConfig: vi.fn(),
  invalidateMcpConfigCache: vi.fn(),
}));

// ─── Imports ─────────────────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getMcpServerConfig, invalidateMcpConfigCache } from '@/lib/orchestration/mcp';
import {
  mockAdminUser,
  mockUnauthenticatedUser,
  mockAuthenticatedUser,
} from '@/tests/helpers/auth';
import { GET, PATCH } from '@/app/api/v1/admin/orchestration/mcp/settings/route';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

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

function makeGetRequest(): NextRequest {
  return new NextRequest('http://localhost:3000/api/v1/admin/orchestration/mcp/settings');
}

function makePatchRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost:3000/api/v1/admin/orchestration/mcp/settings', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
});

describe('GET /mcp/settings', () => {
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

    // test-review:accept no_arg_called — zero-arg side-effect trigger
    expect(createRateLimitResponse).toHaveBeenCalled();
    expect(response.status).toBe(429);
  });

  it('returns current MCP server config', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(getMcpServerConfig).mockResolvedValue(makeMcpConfig() as never);

    const response = await GET(makeGetRequest());

    expect(response.status).toBe(200);
    const body = await parseJson<{
      data: { isEnabled: boolean; serverName: string; auditRetentionDays: number };
    }>(response);
    // test-review:accept tobe_true — structural boolean assertion on API response field
    expect(body.data.isEnabled).toBe(true);
    expect(body.data.serverName).toBe('Sunrise MCP Server');
    expect(body.data.auditRetentionDays).toBe(90);
  });

  it('calls getMcpServerConfig to retrieve settings', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(getMcpServerConfig).mockResolvedValue(makeMcpConfig() as never);

    await GET(makeGetRequest());

    // test-review:accept no_arg_called — zero-arg side-effect trigger
    expect(getMcpServerConfig).toHaveBeenCalled();
  });
});

describe('PATCH /mcp/settings', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

    const response = await PATCH(makePatchRequest({ isEnabled: false }));

    expect(response.status).toBe(401);
  });

  it('returns 403 when authenticated as non-admin', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

    const response = await PATCH(makePatchRequest({ isEnabled: false }));

    expect(response.status).toBe(403);
  });

  it('returns 429 when rate limit exceeded', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(adminLimiter.check).mockReturnValue({ success: false } as never);

    const response = await PATCH(makePatchRequest({ isEnabled: false }));

    // test-review:accept no_arg_called — zero-arg side-effect trigger
    expect(createRateLimitResponse).toHaveBeenCalled();
    expect(response.status).toBe(429);
  });

  it('returns 400 when no fields provided', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    const response = await PATCH(makePatchRequest({}));

    expect(response.status).toBe(400);
  });

  it('updates isEnabled to false', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.mcpServerConfig.upsert).mockResolvedValue(
      makeMcpConfig({ isEnabled: false }) as never
    );

    const response = await PATCH(makePatchRequest({ isEnabled: false }));

    expect(response.status).toBe(200);
    expect(prisma.mcpServerConfig.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { slug: 'global' },
        update: expect.objectContaining({ isEnabled: false }),
      })
    );
  });

  it('updates multiple fields', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.mcpServerConfig.upsert).mockResolvedValue(
      makeMcpConfig({ serverName: 'My MCP', maxSessionsPerKey: 10 }) as never
    );

    const response = await PATCH(makePatchRequest({ serverName: 'My MCP', maxSessionsPerKey: 10 }));

    expect(response.status).toBe(200);
    expect(prisma.mcpServerConfig.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          serverName: 'My MCP',
          maxSessionsPerKey: 10,
        }),
      })
    );
  });

  it('invalidates config cache after update', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.mcpServerConfig.upsert).mockResolvedValue(makeMcpConfig() as never);

    await PATCH(makePatchRequest({ isEnabled: true }));

    // test-review:accept no_arg_called — zero-arg side-effect trigger
    expect(invalidateMcpConfigCache).toHaveBeenCalled();
  });

  it('returns updated config in response', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.mcpServerConfig.upsert).mockResolvedValue(
      makeMcpConfig({ auditRetentionDays: 30 }) as never
    );

    const response = await PATCH(makePatchRequest({ auditRetentionDays: 30 }));

    const body = await parseJson<{ data: { auditRetentionDays: number } }>(response);
    expect(body.data.auditRetentionDays).toBe(30);
  });

  it('rejects maxSessionsPerKey above 100', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    const response = await PATCH(makePatchRequest({ maxSessionsPerKey: 999 }));

    expect(response.status).toBe(400);
  });

  it('rejects empty serverName', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    const response = await PATCH(makePatchRequest({ serverName: '' }));

    expect(response.status).toBe(400);
  });

  it('upserts with default create values when slug does not exist', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.mcpServerConfig.upsert).mockResolvedValue(makeMcpConfig() as never);

    await PATCH(makePatchRequest({ isEnabled: true }));

    expect(prisma.mcpServerConfig.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          slug: 'global',
          serverName: 'Sunrise MCP Server',
          isEnabled: true,
        }),
      })
    );
  });
});
