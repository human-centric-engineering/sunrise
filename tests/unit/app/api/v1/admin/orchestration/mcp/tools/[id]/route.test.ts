/**
 * Tests: MCP Exposed Tool by ID Endpoints
 *
 * PATCH  /api/v1/admin/orchestration/mcp/tools/:id — update exposed tool
 * DELETE /api/v1/admin/orchestration/mcp/tools/:id — remove exposed tool
 *
 * Test Coverage:
 * - Authentication (401/403 guards)
 * - PATCH: updates tool fields (isEnabled, customName, etc.)
 * - PATCH: returns 404 when tool not found
 * - PATCH: rejects invalid CUID
 * - PATCH: rejects empty body
 * - DELETE: deletes tool and returns deleted:true
 * - DELETE: returns 404 when tool not found
 * - Cache invalidation and broadcast after mutation
 * - Rate limiting (429 when limit exceeded)
 *
 * @see app/api/v1/admin/orchestration/mcp/tools/[id]/route.ts
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
      findUnique: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
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
import { PATCH, DELETE } from '@/app/api/v1/admin/orchestration/mcp/tools/[id]/route';

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

function makePatchRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest(`http://localhost:3000/api/v1/admin/orchestration/mcp/tools/${TOOL_ID}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function makeDeleteRequest(): NextRequest {
  return new NextRequest(`http://localhost:3000/api/v1/admin/orchestration/mcp/tools/${TOOL_ID}`, {
    method: 'DELETE',
  });
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
});

describe('PATCH /mcp/tools/:id', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

    const response = await PATCH(makePatchRequest({ isEnabled: false }), makeParams(TOOL_ID));

    expect(response.status).toBe(401);
  });

  it('returns 403 when authenticated as non-admin', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

    const response = await PATCH(makePatchRequest({ isEnabled: false }), makeParams(TOOL_ID));

    expect(response.status).toBe(403);
  });

  it('returns 429 when rate limit exceeded', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(adminLimiter.check).mockReturnValue({ success: false } as never);

    const response = await PATCH(makePatchRequest({ isEnabled: false }), makeParams(TOOL_ID));

    // test-review:accept no_arg_called — zero-arg side-effect trigger
    expect(createRateLimitResponse).toHaveBeenCalled();
    expect(response.status).toBe(429);
  });

  it('returns 400 for invalid non-CUID id', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    const response = await PATCH(makePatchRequest({ isEnabled: false }), makeParams('bad-id'));

    expect(response.status).toBe(400);
  });

  it('returns 404 when tool not found', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.mcpExposedTool.findUnique).mockResolvedValue(null);

    const response = await PATCH(makePatchRequest({ isEnabled: false }), makeParams(TOOL_ID));

    expect(response.status).toBe(404);
  });

  it('returns 400 when no fields provided', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    const response = await PATCH(makePatchRequest({}), makeParams(TOOL_ID));

    expect(response.status).toBe(400);
  });

  it('disables tool by setting isEnabled to false', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.mcpExposedTool.findUnique).mockResolvedValue(makeTool() as never);
    vi.mocked(prisma.mcpExposedTool.update).mockResolvedValue(
      makeTool({ isEnabled: false }) as never
    );

    const response = await PATCH(makePatchRequest({ isEnabled: false }), makeParams(TOOL_ID));

    expect(response.status).toBe(200);
    expect(prisma.mcpExposedTool.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: TOOL_ID },
        data: expect.objectContaining({ isEnabled: false }),
        include: { capability: true },
      })
    );
  });

  it('updates customName', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.mcpExposedTool.findUnique).mockResolvedValue(makeTool() as never);
    vi.mocked(prisma.mcpExposedTool.update).mockResolvedValue(
      makeTool({ customName: 'search_kb' }) as never
    );

    const response = await PATCH(
      makePatchRequest({ customName: 'search_kb' }),
      makeParams(TOOL_ID)
    );

    expect(response.status).toBe(200);
    expect(prisma.mcpExposedTool.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ customName: 'search_kb' }),
      })
    );
  });

  it('clears cache and broadcasts change after update', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.mcpExposedTool.findUnique).mockResolvedValue(makeTool() as never);
    vi.mocked(prisma.mcpExposedTool.update).mockResolvedValue(makeTool() as never);

    await PATCH(makePatchRequest({ isEnabled: false }), makeParams(TOOL_ID));

    // test-review:accept no_arg_called — zero-arg side-effect trigger
    expect(clearMcpToolCache).toHaveBeenCalled();
    // test-review:accept no_arg_called — zero-arg side-effect trigger
    expect(broadcastMcpToolsChanged).toHaveBeenCalled();
  });

  it('returns updated tool with capability in response', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.mcpExposedTool.findUnique).mockResolvedValue(makeTool() as never);
    vi.mocked(prisma.mcpExposedTool.update).mockResolvedValue(makeTool() as never);

    const response = await PATCH(makePatchRequest({ isEnabled: true }), makeParams(TOOL_ID));

    const body = await parseJson<{ data: { id: string } }>(response);
    expect(body.data.id).toBe(TOOL_ID);
  });
});

describe('DELETE /mcp/tools/:id', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

    const response = await DELETE(makeDeleteRequest(), makeParams(TOOL_ID));

    expect(response.status).toBe(401);
  });

  it('returns 403 when authenticated as non-admin', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

    const response = await DELETE(makeDeleteRequest(), makeParams(TOOL_ID));

    expect(response.status).toBe(403);
  });

  it('returns 429 when rate limit exceeded', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(adminLimiter.check).mockReturnValue({ success: false } as never);

    const response = await DELETE(makeDeleteRequest(), makeParams(TOOL_ID));

    // test-review:accept no_arg_called — zero-arg side-effect trigger
    expect(createRateLimitResponse).toHaveBeenCalled();
    expect(response.status).toBe(429);
  });

  it('returns 400 for invalid non-CUID id', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    const response = await DELETE(makeDeleteRequest(), makeParams('bad-id'));

    expect(response.status).toBe(400);
  });

  it('returns 404 when tool not found', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.mcpExposedTool.findUnique).mockResolvedValue(null);

    const response = await DELETE(makeDeleteRequest(), makeParams(TOOL_ID));

    expect(response.status).toBe(404);
  });

  it('deletes tool and returns deleted:true', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.mcpExposedTool.findUnique).mockResolvedValue(makeTool() as never);
    vi.mocked(prisma.mcpExposedTool.delete).mockResolvedValue(makeTool() as never);

    const response = await DELETE(makeDeleteRequest(), makeParams(TOOL_ID));

    expect(response.status).toBe(200);
    expect(prisma.mcpExposedTool.delete).toHaveBeenCalledWith({ where: { id: TOOL_ID } });

    const body = await parseJson<{ data: { id: string; deleted: boolean } }>(response);
    expect(body.data.id).toBe(TOOL_ID);
    // test-review:accept tobe_true — structural boolean assertion on API response field
    expect(body.data.deleted).toBe(true);
  });

  it('clears cache and broadcasts change after deletion', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.mcpExposedTool.findUnique).mockResolvedValue(makeTool() as never);
    vi.mocked(prisma.mcpExposedTool.delete).mockResolvedValue(makeTool() as never);

    await DELETE(makeDeleteRequest(), makeParams(TOOL_ID));

    // test-review:accept no_arg_called — zero-arg side-effect trigger
    expect(clearMcpToolCache).toHaveBeenCalled();
    // test-review:accept no_arg_called — zero-arg side-effect trigger
    expect(broadcastMcpToolsChanged).toHaveBeenCalled();
  });
});
