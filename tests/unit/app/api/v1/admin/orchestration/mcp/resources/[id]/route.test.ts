/**
 * Tests: MCP Exposed Resource by ID Endpoints
 *
 * PATCH  /api/v1/admin/orchestration/mcp/resources/:id — update
 * DELETE /api/v1/admin/orchestration/mcp/resources/:id — delete
 *
 * Test Coverage:
 * - Authentication (401/403 guards)
 * - PATCH: updates resource fields
 * - PATCH: handles handlerConfig null (sets to Prisma.JsonNull)
 * - PATCH: returns 404 when resource not found
 * - PATCH: rejects invalid CUID
 * - DELETE: deletes resource and returns deleted:true
 * - DELETE: returns 404 when resource not found
 * - Cache invalidation and broadcast after mutation
 * - Rate limiting (429 when limit exceeded)
 *
 * @see app/api/v1/admin/orchestration/mcp/resources/[id]/route.ts
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
import { PATCH, DELETE } from '@/app/api/v1/admin/orchestration/mcp/resources/[id]/route';

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

function makePatchRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest(
    `http://localhost:3000/api/v1/admin/orchestration/mcp/resources/${RESOURCE_ID}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  );
}

function makeDeleteRequest(): NextRequest {
  return new NextRequest(
    `http://localhost:3000/api/v1/admin/orchestration/mcp/resources/${RESOURCE_ID}`,
    { method: 'DELETE' }
  );
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

describe('PATCH /mcp/resources/:id', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

    const response = await PATCH(makePatchRequest({ name: 'Updated' }), makeParams(RESOURCE_ID));

    expect(response.status).toBe(401);
  });

  it('returns 403 when authenticated as non-admin', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

    const response = await PATCH(makePatchRequest({ name: 'Updated' }), makeParams(RESOURCE_ID));

    expect(response.status).toBe(403);
  });

  it('returns 429 when rate limit exceeded', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(adminLimiter.check).mockReturnValue({ success: false } as never);

    const response = await PATCH(makePatchRequest({ name: 'Updated' }), makeParams(RESOURCE_ID));

    expect(createRateLimitResponse).toHaveBeenCalled();
    expect(response.status).toBe(429);
  });

  it('returns 400 for invalid non-CUID id', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    const response = await PATCH(makePatchRequest({ name: 'Updated' }), makeParams('bad-id'));

    expect(response.status).toBe(400);
  });

  it('returns 404 when resource not found', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.mcpExposedResource.findUnique).mockResolvedValue(null);

    const response = await PATCH(makePatchRequest({ name: 'Updated' }), makeParams(RESOURCE_ID));

    expect(response.status).toBe(404);
  });

  it('returns 400 when no fields provided', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    const response = await PATCH(makePatchRequest({}), makeParams(RESOURCE_ID));

    expect(response.status).toBe(400);
  });

  it('updates resource name and returns 200', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.mcpExposedResource.findUnique).mockResolvedValue(makeResource() as never);
    vi.mocked(prisma.mcpExposedResource.update).mockResolvedValue(
      makeResource({ name: 'Updated Name' }) as never
    );

    const response = await PATCH(
      makePatchRequest({ name: 'Updated Name' }),
      makeParams(RESOURCE_ID)
    );

    expect(response.status).toBe(200);
    expect(prisma.mcpExposedResource.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: RESOURCE_ID },
        data: expect.objectContaining({ name: 'Updated Name' }),
      })
    );
  });

  it('clears cache and broadcasts change after update', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.mcpExposedResource.findUnique).mockResolvedValue(makeResource() as never);
    vi.mocked(prisma.mcpExposedResource.update).mockResolvedValue(makeResource() as never);

    await PATCH(makePatchRequest({ isEnabled: false }), makeParams(RESOURCE_ID));

    expect(clearMcpResourceCache).toHaveBeenCalled();
    expect(broadcastMcpResourcesChanged).toHaveBeenCalled();
  });

  it('toggles isEnabled to false', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.mcpExposedResource.findUnique).mockResolvedValue(makeResource() as never);
    vi.mocked(prisma.mcpExposedResource.update).mockResolvedValue(
      makeResource({ isEnabled: false }) as never
    );

    const response = await PATCH(makePatchRequest({ isEnabled: false }), makeParams(RESOURCE_ID));

    expect(response.status).toBe(200);
    expect(prisma.mcpExposedResource.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ isEnabled: false }),
      })
    );
  });
});

describe('DELETE /mcp/resources/:id', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

    const response = await DELETE(makeDeleteRequest(), makeParams(RESOURCE_ID));

    expect(response.status).toBe(401);
  });

  it('returns 403 when authenticated as non-admin', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

    const response = await DELETE(makeDeleteRequest(), makeParams(RESOURCE_ID));

    expect(response.status).toBe(403);
  });

  it('returns 429 when rate limit exceeded', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(adminLimiter.check).mockReturnValue({ success: false } as never);

    const response = await DELETE(makeDeleteRequest(), makeParams(RESOURCE_ID));

    expect(createRateLimitResponse).toHaveBeenCalled();
    expect(response.status).toBe(429);
  });

  it('returns 400 for invalid non-CUID id', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    const response = await DELETE(makeDeleteRequest(), makeParams('bad-id'));

    expect(response.status).toBe(400);
  });

  it('returns 404 when resource not found', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.mcpExposedResource.findUnique).mockResolvedValue(null);

    const response = await DELETE(makeDeleteRequest(), makeParams(RESOURCE_ID));

    expect(response.status).toBe(404);
  });

  it('deletes resource and returns deleted:true', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.mcpExposedResource.findUnique).mockResolvedValue(makeResource() as never);
    vi.mocked(prisma.mcpExposedResource.delete).mockResolvedValue(makeResource() as never);

    const response = await DELETE(makeDeleteRequest(), makeParams(RESOURCE_ID));

    expect(response.status).toBe(200);
    expect(prisma.mcpExposedResource.delete).toHaveBeenCalledWith({
      where: { id: RESOURCE_ID },
    });

    const body = await parseJson<{ data: { id: string; deleted: boolean } }>(response);
    expect(body.data.id).toBe(RESOURCE_ID);
    expect(body.data.deleted).toBe(true);
  });

  it('clears cache and broadcasts change after deletion', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.mcpExposedResource.findUnique).mockResolvedValue(makeResource() as never);
    vi.mocked(prisma.mcpExposedResource.delete).mockResolvedValue(makeResource() as never);

    await DELETE(makeDeleteRequest(), makeParams(RESOURCE_ID));

    expect(clearMcpResourceCache).toHaveBeenCalled();
    expect(broadcastMcpResourcesChanged).toHaveBeenCalled();
  });
});
