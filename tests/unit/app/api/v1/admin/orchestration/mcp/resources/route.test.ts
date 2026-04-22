/**
 * Tests: MCP Exposed Resources Endpoints
 *
 * GET  /api/v1/admin/orchestration/mcp/resources — list exposed resources
 * POST /api/v1/admin/orchestration/mcp/resources — create exposed resource
 *
 * Test Coverage:
 * - Authentication (401/403 guards)
 * - GET: returns paginated resource list
 * - GET: filters by isEnabled and resourceType
 * - POST: creates resource, clears cache, broadcasts change
 * - POST: rejects invalid URI scheme
 * - POST: rejects invalid resourceType
 * - Rate limiting (429 when limit exceeded)
 *
 * @see app/api/v1/admin/orchestration/mcp/resources/route.ts
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
    mcpExposedResource: {
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
  clearMcpResourceCache: vi.fn(),
  broadcastMcpResourcesChanged: vi.fn(),
}));

// ─── Imports ─────────────────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { clearMcpResourceCache, broadcastMcpResourcesChanged } from '@/lib/orchestration/mcp';
import {
  mockAdminUser,
  mockUnauthenticatedUser,
  mockAuthenticatedUser,
} from '@/tests/helpers/auth';
import { GET, POST } from '@/app/api/v1/admin/orchestration/mcp/resources/route';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const RESOURCE_ID = 'cmjbv4i3x00003wsloputgwu1';

function makeResource(overrides: Record<string, unknown> = {}) {
  return {
    id: RESOURCE_ID,
    uri: 'sunrise://knowledge/search',
    name: 'Knowledge Search',
    description: 'Search the knowledge base',
    mimeType: 'application/json',
    resourceType: 'knowledge_search',
    isEnabled: true,
    handlerConfig: null,
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    ...overrides,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeGetRequest(params: Record<string, string> = {}): NextRequest {
  const url = new URL('http://localhost:3000/api/v1/admin/orchestration/mcp/resources');
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  return new NextRequest(url);
}

function makePostRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost:3000/api/v1/admin/orchestration/mcp/resources', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

const VALID_RESOURCE_BODY = {
  uri: 'sunrise://knowledge/search',
  name: 'Knowledge Search',
  description: 'Search the knowledge base',
  resourceType: 'knowledge_search',
  isEnabled: false,
};

// ─── Tests ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
});

describe('GET /mcp/resources', () => {
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

  it('returns paginated resources', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.mcpExposedResource.findMany).mockResolvedValue([makeResource()] as never);
    vi.mocked(prisma.mcpExposedResource.count).mockResolvedValue(1);

    const response = await GET(makeGetRequest());

    expect(response.status).toBe(200);
    const body = await parseJson<{ data: unknown[]; meta: { total: number } }>(response);
    expect(body.data).toHaveLength(1);
    expect(body.meta.total).toBe(1);
  });

  it('filters by isEnabled', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.mcpExposedResource.findMany).mockResolvedValue([]);
    vi.mocked(prisma.mcpExposedResource.count).mockResolvedValue(0);

    await GET(makeGetRequest({ isEnabled: 'true' }));

    expect(prisma.mcpExposedResource.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { isEnabled: true } })
    );
  });

  it('filters by resourceType', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.mcpExposedResource.findMany).mockResolvedValue([]);
    vi.mocked(prisma.mcpExposedResource.count).mockResolvedValue(0);

    await GET(makeGetRequest({ resourceType: 'agent_list' }));

    expect(prisma.mcpExposedResource.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { resourceType: 'agent_list' } })
    );
  });
});

describe('POST /mcp/resources', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

    const response = await POST(makePostRequest(VALID_RESOURCE_BODY));

    expect(response.status).toBe(401);
  });

  it('returns 403 when authenticated as non-admin', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

    const response = await POST(makePostRequest(VALID_RESOURCE_BODY));

    expect(response.status).toBe(403);
  });

  it('returns 429 when rate limit exceeded', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(adminLimiter.check).mockReturnValue({ success: false } as never);

    const response = await POST(makePostRequest(VALID_RESOURCE_BODY));

    expect(createRateLimitResponse).toHaveBeenCalled();
    expect(response.status).toBe(429);
  });

  it('creates resource and returns 201', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.mcpExposedResource.create).mockResolvedValue(makeResource() as never);

    const response = await POST(makePostRequest(VALID_RESOURCE_BODY));

    expect(response.status).toBe(201);
    const body = await parseJson<{ data: { id: string } }>(response);
    expect(body.data.id).toBe(RESOURCE_ID);
  });

  it('clears cache and broadcasts change after creation', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.mcpExposedResource.create).mockResolvedValue(makeResource() as never);

    await POST(makePostRequest(VALID_RESOURCE_BODY));

    expect(clearMcpResourceCache).toHaveBeenCalled();
    expect(broadcastMcpResourcesChanged).toHaveBeenCalled();
  });

  it('rejects URI without sunrise:// scheme', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    const response = await POST(
      makePostRequest({ ...VALID_RESOURCE_BODY, uri: 'https://example.com/resource' })
    );

    expect(response.status).toBe(400);
  });

  it('rejects invalid resourceType', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    const response = await POST(
      makePostRequest({ ...VALID_RESOURCE_BODY, resourceType: 'invalid_type' })
    );

    expect(response.status).toBe(400);
  });

  it('rejects missing name', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    const { name: _name, ...bodyWithoutName } = VALID_RESOURCE_BODY;
    const response = await POST(makePostRequest(bodyWithoutName));

    expect(response.status).toBe(400);
  });
});
