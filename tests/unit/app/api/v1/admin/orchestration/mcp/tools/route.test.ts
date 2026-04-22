/**
 * Tests: MCP Exposed Tools Endpoints
 *
 * GET  /api/v1/admin/orchestration/mcp/tools — list exposed tools
 * POST /api/v1/admin/orchestration/mcp/tools — create exposed tool
 *
 * Test Coverage:
 * - Authentication (401/403 guards)
 * - GET: returns paginated tools with capability included
 * - GET: filters by isEnabled
 * - POST: creates tool, clears cache, broadcasts change
 * - POST: rejects invalid capabilityId (non-CUID)
 * - POST: rejects invalid customName (must match tool name pattern)
 * - Rate limiting (429 when limit exceeded)
 *
 * @see app/api/v1/admin/orchestration/mcp/tools/route.ts
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
    mcpExposedTool: {
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
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
  clearMcpToolCache: vi.fn(),
  broadcastMcpToolsChanged: vi.fn(),
}));

// ─── Imports ─────────────────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { clearMcpToolCache, broadcastMcpToolsChanged } from '@/lib/orchestration/mcp';
import {
  mockAdminUser,
  mockUnauthenticatedUser,
  mockAuthenticatedUser,
} from '@/tests/helpers/auth';
import { GET, POST } from '@/app/api/v1/admin/orchestration/mcp/tools/route';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const TOOL_ID = 'cmjbv4i3x00003wsloputgwu1';
const CAPABILITY_ID = 'cmjbv4i3x00003wsloputgwu2';

function makeCapability(overrides: Record<string, unknown> = {}) {
  return {
    id: CAPABILITY_ID,
    slug: 'search_knowledge',
    name: 'Search Knowledge',
    description: 'Search the knowledge base',
    type: 'BUILTIN',
    isEnabled: true,
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    ...overrides,
  };
}

function makeTool(overrides: Record<string, unknown> = {}) {
  return {
    id: TOOL_ID,
    capabilityId: CAPABILITY_ID,
    isEnabled: true,
    customName: null,
    customDescription: null,
    rateLimitPerKey: null,
    requiresScope: null,
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    capability: makeCapability(),
    ...overrides,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeGetRequest(params: Record<string, string> = {}): NextRequest {
  const url = new URL('http://localhost:3000/api/v1/admin/orchestration/mcp/tools');
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  return new NextRequest(url);
}

function makePostRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost:3000/api/v1/admin/orchestration/mcp/tools', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

const VALID_TOOL_BODY = {
  capabilityId: CAPABILITY_ID,
  isEnabled: false,
};

// ─── Tests ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
});

describe('GET /mcp/tools', () => {
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

  it('returns paginated tools with capability included', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.mcpExposedTool.findMany).mockResolvedValue([makeTool()] as never);
    vi.mocked(prisma.mcpExposedTool.count).mockResolvedValue(1);

    const response = await GET(makeGetRequest());

    expect(response.status).toBe(200);
    const body = await parseJson<{ data: unknown[]; meta: { total: number } }>(response);
    expect(body.data).toHaveLength(1);
    expect(body.meta.total).toBe(1);
  });

  it('filters by isEnabled=true', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.mcpExposedTool.findMany).mockResolvedValue([]);
    vi.mocked(prisma.mcpExposedTool.count).mockResolvedValue(0);

    await GET(makeGetRequest({ isEnabled: 'true' }));

    expect(prisma.mcpExposedTool.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { isEnabled: true } })
    );
  });

  it('returns all tools when no isEnabled filter provided', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.mcpExposedTool.findMany).mockResolvedValue([]);
    vi.mocked(prisma.mcpExposedTool.count).mockResolvedValue(0);

    await GET(makeGetRequest());

    expect(prisma.mcpExposedTool.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: {} })
    );
  });
});

describe('POST /mcp/tools', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

    const response = await POST(makePostRequest(VALID_TOOL_BODY));

    expect(response.status).toBe(401);
  });

  it('returns 403 when authenticated as non-admin', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

    const response = await POST(makePostRequest(VALID_TOOL_BODY));

    expect(response.status).toBe(403);
  });

  it('returns 429 when rate limit exceeded', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(adminLimiter.check).mockReturnValue({ success: false } as never);

    const response = await POST(makePostRequest(VALID_TOOL_BODY));

    expect(createRateLimitResponse).toHaveBeenCalled();
    expect(response.status).toBe(429);
  });

  it('creates tool and returns 201', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.mcpExposedTool.create).mockResolvedValue(makeTool() as never);

    const response = await POST(makePostRequest(VALID_TOOL_BODY));

    expect(response.status).toBe(201);
    const body = await parseJson<{ data: { id: string } }>(response);
    expect(body.data.id).toBe(TOOL_ID);
  });

  it('clears cache and broadcasts change after creation', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.mcpExposedTool.create).mockResolvedValue(makeTool() as never);

    await POST(makePostRequest(VALID_TOOL_BODY));

    expect(clearMcpToolCache).toHaveBeenCalled();
    expect(broadcastMcpToolsChanged).toHaveBeenCalled();
  });

  it('creates tool with customName when provided', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.mcpExposedTool.create).mockResolvedValue(
      makeTool({ customName: 'search_kb' }) as never
    );

    const response = await POST(makePostRequest({ ...VALID_TOOL_BODY, customName: 'search_kb' }));

    expect(response.status).toBe(201);
    expect(prisma.mcpExposedTool.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ customName: 'search_kb' }),
      })
    );
  });

  it('rejects invalid capabilityId (non-CUID)', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    const response = await POST(
      makePostRequest({ ...VALID_TOOL_BODY, capabilityId: 'not-a-cuid' })
    );

    expect(response.status).toBe(400);
  });

  it('rejects customName that does not match tool name pattern', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    // Tool names must start with lowercase letter
    const response = await POST(makePostRequest({ ...VALID_TOOL_BODY, customName: 'InvalidName' }));

    expect(response.status).toBe(400);
  });

  it('rejects customName with spaces', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    const response = await POST(
      makePostRequest({ ...VALID_TOOL_BODY, customName: 'search knowledge' })
    );

    expect(response.status).toBe(400);
  });

  it('rejects rateLimitPerKey above 10000', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    const response = await POST(makePostRequest({ ...VALID_TOOL_BODY, rateLimitPerKey: 99999 }));

    expect(response.status).toBe(400);
  });
});
