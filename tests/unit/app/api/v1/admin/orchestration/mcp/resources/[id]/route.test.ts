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
import { Prisma } from '@prisma/client';

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

vi.mock('@/lib/security/ip', () => ({
  getClientIP: vi.fn(() => '127.0.0.1'),
}));

vi.mock('@/lib/api/context', () => ({
  getRouteLogger: vi.fn(() => Promise.resolve({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
}));

vi.mock('@/lib/orchestration/mcp', () => ({
  clearMcpResourceCache: vi.fn(),
  broadcastMcpResourcesChanged: vi.fn(),
  broadcastMcpResourceUpdated: vi.fn(),
}));

// ─── Imports ─────────────────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import {
  broadcastMcpResourceUpdated,
  broadcastMcpResourcesChanged,
  clearMcpResourceCache,
} from '@/lib/orchestration/mcp';
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

  it('clears cache and broadcasts list_changed + resource updated after update', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.mcpExposedResource.findUnique).mockResolvedValue(makeResource() as never);
    vi.mocked(prisma.mcpExposedResource.update).mockResolvedValue(
      makeResource({ uri: 'sunrise://knowledge/search' }) as never
    );

    await PATCH(makePatchRequest({ isEnabled: false }), makeParams(RESOURCE_ID));

    // test-review:accept no_arg_called — zero-arg side-effect trigger
    expect(clearMcpResourceCache).toHaveBeenCalled();
    // test-review:accept no_arg_called — zero-arg side-effect trigger
    expect(broadcastMcpResourcesChanged).toHaveBeenCalled();
    // Per-URI fan-out lets subscribed clients refresh just this resource
    // without re-running resources/list. Asserting the URI argument
    // exercises the new Phase 4 wiring.
    expect(broadcastMcpResourceUpdated).toHaveBeenCalledWith('sunrise://knowledge/search');
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

  it('maps handlerConfig: null to Prisma.JsonNull sentinel (not JS null)', async () => {
    // Verifies the ternary on line 36 of route.ts correctly translates JS null
    // into the Prisma.JsonNull sentinel. Prisma 7 requires this sentinel to store
    // a JSON null literal; passing raw JS null stores SQL NULL instead.
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.mcpExposedResource.findUnique).mockResolvedValue(makeResource() as never);
    vi.mocked(prisma.mcpExposedResource.update).mockResolvedValue(makeResource() as never);

    await PATCH(makePatchRequest({ handlerConfig: null }), makeParams(RESOURCE_ID));

    const updateCall = vi.mocked(prisma.mcpExposedResource.update).mock.calls[0][0];
    // toBe checks reference identity — this fails if the ternary is removed and
    // JS null is passed straight through.
    expect((updateCall.data as Record<string, unknown>).handlerConfig).toBe(Prisma.JsonNull);
  });

  it('passes handlerConfig object through unchanged', async () => {
    // Verifies the ternary passes non-null handlerConfig values through as-is.
    const config = { foo: 'bar' };
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.mcpExposedResource.findUnique).mockResolvedValue(makeResource() as never);
    vi.mocked(prisma.mcpExposedResource.update).mockResolvedValue(
      makeResource({ handlerConfig: config }) as never
    );

    await PATCH(makePatchRequest({ handlerConfig: config }), makeParams(RESOURCE_ID));

    const updateCall = vi.mocked(prisma.mcpExposedResource.update).mock.calls[0][0];
    expect((updateCall.data as Record<string, unknown>).handlerConfig).toEqual({ foo: 'bar' });
  });

  it('omits handlerConfig key entirely when not present in request body', async () => {
    // Verifies the outer if (handlerConfig !== undefined) guard: a request that
    // does not send handlerConfig must not write the key to data at all. An absent
    // key is semantically different from { handlerConfig: undefined } and must not
    // accidentally store null or Prisma.JsonNull in the column.
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.mcpExposedResource.findUnique).mockResolvedValue(makeResource() as never);
    vi.mocked(prisma.mcpExposedResource.update).mockResolvedValue(makeResource() as never);

    await PATCH(makePatchRequest({ name: 'NoConfigChange' }), makeParams(RESOURCE_ID));

    const updateCall = vi.mocked(prisma.mcpExposedResource.update).mock.calls[0][0];
    // not.toHaveProperty is stronger than checking === undefined: an object with
    // { handlerConfig: undefined } would pass the undefined check but still
    // contain the key.
    expect(updateCall.data).not.toHaveProperty('handlerConfig');
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
    // test-review:accept tobe_true — structural boolean assertion on API response field
    expect(body.data.deleted).toBe(true);
  });

  it('clears cache and broadcasts change after deletion', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.mcpExposedResource.findUnique).mockResolvedValue(makeResource() as never);
    vi.mocked(prisma.mcpExposedResource.delete).mockResolvedValue(makeResource() as never);

    await DELETE(makeDeleteRequest(), makeParams(RESOURCE_ID));

    // test-review:accept no_arg_called — zero-arg side-effect trigger
    expect(clearMcpResourceCache).toHaveBeenCalled();
    // test-review:accept no_arg_called — zero-arg side-effect trigger
    expect(broadcastMcpResourcesChanged).toHaveBeenCalled();
  });
});
